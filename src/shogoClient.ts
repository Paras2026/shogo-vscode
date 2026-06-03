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
    "claude-sonnet-4-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
    "hoshi-1.0", "opus-4.8", "gpt-5.5", "sonnet-4.6", "gpt-5.4-mini", "gpt-5.4-nano",
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
 * Handles JSON, JSON in fences, and XML formats.
 */
function parseToolCallsFromText(text: string): StructuredToolCall[] {
  const toolCalls: StructuredToolCall[] = [];
  const tc = parseSingleToolCall(text);
  if (tc) {
    toolCalls.push({
      toolCallId: `text-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      toolName: tc.tool,
      input: tc.input,
    });
  }
  return toolCalls;
}

function parseSingleToolCall(text: string): { tool: string; input: Record<string, unknown> } | undefined {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    stripJsonFence(trimmed),
    extractFirstJsonObject(trimmed),
  ].filter(Boolean) as string[];

  const xmlCall = parseXmlToolCall(trimmed);
  if (xmlCall) return xmlCall;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const tool = pickToolName(parsed);
      const input = pickToolInput(parsed);
      if (tool) return { tool, input };
    } catch {
      continue;
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

function stripJsonFence(text: string): string | undefined {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim();
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function parseXmlToolCall(text: string): { tool: string; input: Record<string, unknown> } | undefined {
  const invoke = text.match(
    /<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/i
  );
  if (!invoke?.[1]) return undefined;

  const input: Record<string, unknown> = {};
  const body = invoke[2] ?? "";
  const paramRegex = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(body)) !== null) {
    input[match[1]] = coerceValue(decodeEntities(match[2].trim()));
  }

  return { tool: invoke[1], input };
}

function coerceValue(value: string): unknown {
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
