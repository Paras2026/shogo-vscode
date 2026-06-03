import { createShogoLlmProvider } from "@shogo-ai/sdk";
import { streamText, type ModelMessage } from "ai";
import { TOOL_DEFINITIONS } from "./agent/toolDefinitions";

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

/**
 * Streams a chat completion from the Shogo Cloud LLM gateway.
 *
 * Attempts native tool_use first (tools passed in the API request).
 * Falls back to text-based parsing if the gateway doesn't support tools.
 */
export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const provider = createShogoLlmProvider(
    opts.apiUrl
      ? { apiKey: opts.apiKey, baseUrl: opts.apiUrl }
      : { apiKey: opts.apiKey }
  );

  const coreMessages: ModelMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const result = await streamWithNativeTools(provider, opts.model, coreMessages, opts);
    return result;
  } catch (nativeError: unknown) {
    const msg = nativeError instanceof Error ? nativeError.message : String(nativeError);
    if (isToolNotSupportedError(msg)) {
      return streamWithTextFallback(provider, opts.model, coreMessages, opts);
    }
    throw nativeError;
  }
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

  const nativeToolCalls = await result.toolCalls;
  const toolCalls: StructuredToolCall[] = (nativeToolCalls ?? []).map((tc) => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: (tc.input ?? {}) as Record<string, unknown>,
  }));

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

  const toolCalls = parseToolCallsFromText(full);
  return { text: full, toolCalls };
}

function isToolNotSupportedError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("unknown parameter") &&
    (lower.includes("tools") || lower.includes("tool_choice"))
  );
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
