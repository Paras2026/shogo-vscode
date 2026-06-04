import { createShogoLlmProvider } from "@shogo-ai/sdk";
import { streamText, type ModelMessage } from "ai";
import { TOOL_DEFINITIONS } from "./agent/toolDefinitions";
import { logInfo, logError, logDebug, logWarn } from "./logger";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StructuredToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  toolCalls: StructuredToolCall[];
}

export interface StreamOptions {
  apiKey: string;
  model: string;
  apiUrl?: string;
  system: string;
  messages: ChatMessage[];
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
}

let nativeToolUseFailed = false;

const STREAM_TIMEOUT_MS = 120000;

/**
 * Races a promise against a timeout. Rejects with a clear error if it stalls.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Stream timed out after ${Math.round(ms / 1000)}s (${label}). The model may be invalid or the gateway is unreachable.`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Validates the model name against known models and warns early.
 */
function validateModel(model: string): string {
  const known = [
    "mimo-v2.5", "claude-sonnet-4-6", "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001", "gpt-4o", "gpt-4o-mini",
  ];
  if (!known.some((k) => model.includes(k))) {
    logWarn(`Unknown model "${model}". Known: ${known.join(", ")}. Proceeding anyway — gateway may reject it.`);
  }
  return model;
}

/**
 * Streams a chat completion from the Shogo Cloud LLM gateway.
 */
export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const model = validateModel(opts.model);
  logInfo(`streamChat: model=${model}, messages=${opts.messages.length}, system=${opts.system.length} chars`);

  const provider = createShogoLlmProvider(
    opts.apiUrl
      ? { apiKey: opts.apiKey, baseUrl: opts.apiUrl }
      : { apiKey: opts.apiKey }
  );

  const coreMessages: ModelMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (!nativeToolUseFailed) {
    try {
      logDebug("Attempting native tool_use stream...");
      const result = await withTimeout(
        streamWithNativeTools(provider, model, coreMessages, opts),
        STREAM_TIMEOUT_MS,
        "native tool_use"
      );
      if (result.text.length === 0 && result.toolCalls.length === 0) {
        logWarn("Native tool_use returned empty — switching to text mode permanently");
        nativeToolUseFailed = true;
        return withTimeout(
          streamWithTextFallback(provider, model, coreMessages, opts),
          STREAM_TIMEOUT_MS,
          "text fallback after empty native"
        );
      }
      return result;
    } catch (nativeError: unknown) {
      const msg = nativeError instanceof Error ? nativeError.message : String(nativeError);
      logWarn(`Native tool_use failed: ${msg} — switching to text mode permanently`);
      nativeToolUseFailed = true;
    }
  }

  return withTimeout(
    streamWithTextFallback(provider, model, coreMessages, opts),
    STREAM_TIMEOUT_MS,
    "text fallback"
  );
}

async function streamWithNativeTools(
  provider: ReturnType<typeof createShogoLlmProvider>,
  model: string,
  coreMessages: ModelMessage[],
  opts: StreamOptions
): Promise<StreamResult> {
  const result = streamText({
    model: provider(model),
    system: opts.system,
    messages: coreMessages,
    tools: TOOL_DEFINITIONS as never,
    abortSignal: opts.signal,
  });

  let full = "";
  for await (const delta of result.textStream) {
    full += delta;
    opts.onToken(delta);
  }

  logDebug(`Native stream complete: ${full.length} chars text`);

  const nativeToolCalls = await result.toolCalls;
  const toolCalls: StructuredToolCall[] = (nativeToolCalls ?? []).map((tc) => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: (tc.input ?? {}) as Record<string, unknown>,
  }));

  logInfo(`Native tool calls: ${toolCalls.length} — ${toolCalls.map((t) => t.toolName).join(", ") || "none"}`);
  return { text: full, toolCalls };
}

async function streamWithTextFallback(
  provider: ReturnType<typeof createShogoLlmProvider>,
  model: string,
  coreMessages: ModelMessage[],
  opts: StreamOptions
): Promise<StreamResult> {
  const result = streamText({
    model: provider(model),
    system: opts.system,
    messages: coreMessages,
    abortSignal: opts.signal,
  });

  let full = "";
  for await (const delta of result.textStream) {
    full += delta;
    opts.onToken(delta);
  }

  logDebug(`Fallback stream complete: ${full.length} chars text`);

  const toolCalls = parseToolCallsFromText(full);
  logInfo(`Parsed tool calls from text: ${toolCalls.length} — ${toolCalls.map((t) => t.toolName).join(", ") || "none"}`);
  if (full.length === 0) {
    logWarn("Stream returned EMPTY text — the model produced no output");
    throw new Error(
      `The model "${opts.model}" returned no output. It may not be supported by the Shogo Cloud gateway. Try switching to "Claude Sonnet 4.5" in the model dropdown.`
    );
  }

  return { text: full, toolCalls };
}

/**
 * Parses tool calls from text as a fallback when native tool_use is unavailable.
 * Supports JSON, JSON in fences, XML, and multiple tool calls per message.
 */
function parseToolCallsFromText(text: string): StructuredToolCall[] {
  const toolCalls: StructuredToolCall[] = [];
  const seen = new Set<string>();

  const xmlCalls = parseAllXmlToolCalls(text);
  for (const tc of xmlCalls) {
    const key = `${tc.toolName}:${JSON.stringify(tc.input)}`;
    if (!seen.has(key)) {
      seen.add(key);
      toolCalls.push(tc);
    }
  }

  const jsonCalls = parseAllJsonToolCalls(text);
  for (const tc of jsonCalls) {
    const key = `${tc.toolName}:${JSON.stringify(tc.input)}`;
    if (!seen.has(key)) {
      seen.add(key);
      toolCalls.push(tc);
    }
  }

  return toolCalls;
}

/**
 * Strips tool call JSON/XML from display text so the user doesn't see raw markup.
 */
export function stripToolCallsFromText(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "");
  cleaned = cleaned.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, "");
  cleaned = cleaned.replace(/\{"\s*"?type"?\s*:\s*"tool_call"[\s\S]*?\}/g, "");
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "");
  return cleaned.trim();
}

function parseAllJsonToolCalls(text: string): StructuredToolCall[] {
  const results: StructuredToolCall[] = [];
  const regex = /\{"\s*"?type"?\s*:\s*"tool_call"[\s\S]*?\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const tc = parseJsonToolCall(match[0]);
    if (tc) {
      results.push({
        toolCallId: `text-${Date.now()}-${results.length}-${Math.random().toString(36).slice(2)}`,
        toolName: tc.tool,
        input: tc.input,
      });
    }
  }

  if (results.length === 0) {
    const regex2 = /\{[^{}]*"tool"\s*:\s*"([^"]+)"[^{}]*\}/g;
    while ((match = regex2.exec(text)) !== null) {
      const tc = parseJsonToolCall(match[0]);
      if (tc) {
        results.push({
          toolCallId: `text-${Date.now()}-${results.length}-${Math.random().toString(36).slice(2)}`,
          toolName: tc.tool,
          input: tc.input,
        });
      }
    }
  }

  return results;
}

function parseJsonToolCall(text: string): { tool: string; input: Record<string, unknown> } | undefined {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const tool = pickToolName(parsed);
    const input = pickToolInput(parsed);
    if (tool) return { tool, input };
  } catch {
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(jsonStr.slice(start, end + 1)) as Record<string, unknown>;
        const tool = pickToolName(parsed);
        const input = pickToolInput(parsed);
        if (tool) return { tool, input };
        } catch { /* skip */ }
    }
  }
  return undefined;
}

function pickToolName(parsed: Record<string, unknown>): string | undefined {
  if (typeof parsed.tool === "string") return parsed.tool;
  if (typeof parsed.name === "string") return parsed.name;
  if (typeof parsed.function === "string") return parsed.function;
  return undefined;
}

function pickToolInput(parsed: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(parsed.input)) return parsed.input;
  if (isRecord(parsed.arguments)) return parsed.arguments;
  if (isRecord(parsed.parameters)) return parsed.parameters;
  return {};
}

function parseAllXmlToolCalls(text: string): StructuredToolCall[] {
  const results: StructuredToolCall[] = [];
  const regex = /<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const input: Record<string, unknown> = {};
    const body = match[2] ?? "";
    const paramRegex = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      input[pMatch[1]] = coerceValue(decodeEntities(pMatch[2].trim()));
    }
    results.push({
      toolCallId: `text-${Date.now()}-${results.length}-${Math.random().toString(36).slice(2)}`,
      toolName: match[1],
      input,
    });
  }
  return results;
}

function coerceValue(value: string): unknown {
  if (!value) return "";
  try { return JSON.parse(value); } catch { return value; }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
