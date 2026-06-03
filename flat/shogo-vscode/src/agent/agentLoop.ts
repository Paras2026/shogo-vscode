import * as vscode from "vscode";
import { streamChat, type ChatMessage } from "../shogoClient";
import { executeTool, getToolDescriptions, getToolNames } from "./toolRegistry";
import type { ApprovalRequest, ParsedToolCall, ToolResult } from "./types";

export interface AgentLoopOptions {
  apiKey: string;
  model: string;
  apiUrl?: string;
  system: string;
  messages: ChatMessage[];
  extensionContext: vscode.ExtensionContext;
  maxSteps?: number;
  signal?: AbortSignal;
  onActivity?: (text: string) => void;
  onFinalToken?: (text: string) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
}

const DEFAULT_MAX_STEPS = 16;
const MAX_HISTORY_CHARS = 40000;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let totalChars = 0;
  const trimmed: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgChars = messages[i].content.length;
    if (totalChars + msgChars > MAX_HISTORY_CHARS && trimmed.length > 0) {
      break;
    }
    totalChars += msgChars;
    trimmed.unshift(messages[i]);
  }
  return trimmed;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  const messages: ChatMessage[] = trimHistory(opts.messages);
  const system = `${opts.system}\n\n${buildToolProtocol()}`;
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? DEFAULT_MAX_STEPS, 1), 32);
  let successfulToolCalls = 0;
  let correctedFalseSuccess = false;

  for (let step = 0; step < maxSteps; step++) {
    let response = "";
    response = await streamChat({
      apiKey: opts.apiKey,
      model: opts.model,
      apiUrl: opts.apiUrl,
      system,
      messages,
      signal: opts.signal,
      onToken: (chunk) => {
        response += chunk;
      },
    });

    const toolCall = parseToolCall(response);
    if (!toolCall) {
      const finalResponse = stripToolMarkup(response);
      if (!correctedFalseSuccess && successfulToolCalls === 0 && looksLikeUnverifiedWorkspaceSuccess(finalResponse)) {
        correctedFalseSuccess = true;
        messages.push({ role: "assistant", content: response });
        messages.push({
          role: "user",
          content:
            "No tool ran. Do not claim success. Call the appropriate tool now.",
        });
        continue;
      }

      opts.onFinalToken?.(finalResponse);
      return finalResponse;
    }

    opts.onActivity?.(`Tool: ${toolCall.tool}`);
    messages.push({ role: "assistant", content: formatToolCallForHistory(toolCall) });

    const result = await executeTool(toolCall.tool, toolCall.input, {
      extensionContext: opts.extensionContext,
      signal: opts.signal,
      postActivity: opts.onActivity,
      requestApproval: opts.requestApproval,
    });

    if (result.ok) {
      successfulToolCalls += 1;
    }

    opts.onActivity?.(`${toolCall.tool}: ${result.ok ? "done" : "failed"}`);
    messages.push({
      role: "user",
      content: formatToolResult(toolCall.tool, result),
    });
  }

  const final = `I stopped after ${maxSteps} tool steps to avoid looping. Ask me to continue if you want me to keep going.`;
  opts.onFinalToken?.(final);
  return final;
}

function buildToolProtocol(): string {
  return [
    "TOOLS: Use JSON tool calls to inspect/edit the workspace. Format:",
    '{"type":"tool_call","tool":"<name>","input":{...}}',
    "No XML/fences/text around tool calls. Verify actions via tool results before claiming success.",
    "For edits use applyPatch (oldText/newText). For new files use writeFile.",
    getToolDescriptions(),
  ].join("\n");
}

function parseToolCall(text: string): ParsedToolCall | undefined {
  const trimmed = text.trim();
  const xmlCall = parseXmlToolCall(trimmed);
  if (xmlCall) {
    return xmlCall;
  }

  const candidates = [trimmed, stripJsonFence(trimmed), extractFirstJsonObject(trimmed)].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ParsedToolCall> & { type?: string; name?: string; arguments?: unknown };
      const tool = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.name === "string" ? parsed.name : undefined;
      const input = isRecord(parsed.input) ? parsed.input : isRecord(parsed.arguments) ? parsed.arguments : {};
      if ((parsed.type === "tool_call" || tool) && tool) {
        return { tool, input };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function stripJsonFence(text: string): string | undefined {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim();
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

function parseXmlToolCall(text: string): ParsedToolCall | undefined {
  const invoke = text.match(/<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/i);
  if (!invoke?.[1]) {
    return undefined;
  }

  const input: Record<string, unknown> = {};
  const body = invoke[2] ?? "";
  const paramRegex = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(body)) !== null) {
    input[match[1]] = coerceXmlParameter(decodeXmlEntities(match[2].trim()));
  }

  return { tool: invoke[1], input };
}

function coerceXmlParameter(value: string): unknown {
  if (!value) {
    return "";
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeXmlEntities(value: string): string {
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

function looksLikeUnverifiedWorkspaceSuccess(text: string): boolean {
  const normalized = stripToolMarkup(text).toLowerCase();
  const successVerb = /\b(created|wrote|updated|modified|changed|edited|deleted|removed|renamed|moved|fixed|ran|executed|installed|applied|searched|indexed|committed)\b/;
  const successPhrase = /\b(i('|’)?ve|i have|i successfully|successfully|done[,!]?|completed|finished)\b/;
  const workspaceTarget = /\b(file|folder|workspace|project|command|terminal|script|test|package|dependency|diff|patch|code|component|function|class|repo|branch|commit|index|search)\b/;
  return successVerb.test(normalized) && (successPhrase.test(normalized) || workspaceTarget.test(normalized));
}

function stripToolMarkup(text: string): string {
  return text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

function formatToolCallForHistory(toolCall: ParsedToolCall): string {
  return JSON.stringify({ type: "tool_call", tool: toolCall.tool, input: toolCall.input });
}

function formatToolResult(tool: string, result: ToolResult): string {
  const payload = JSON.stringify(result);
  const truncated = payload.length > 8000 ? payload.slice(0, 8000) + "...[truncated]" : payload;
  return `RESULT(${tool}):${truncated}`;
}
