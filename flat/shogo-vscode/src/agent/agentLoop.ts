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
  signal?: AbortSignal;
  onActivity?: (text: string) => void;
  onFinalToken?: (text: string) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
}

const MAX_STEPS = 12;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  const messages: ChatMessage[] = [...opts.messages];
  const system = `${opts.system}\n\n${buildToolProtocol()}`;

  for (let step = 0; step < MAX_STEPS; step++) {
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
      opts.onFinalToken?.(response);
      return response;
    }

    opts.onActivity?.(`Tool: ${toolCall.tool}`);
    messages.push({ role: "assistant", content: response });

    const result = await executeTool(toolCall.tool, toolCall.input, {
      extensionContext: opts.extensionContext,
      signal: opts.signal,
      postActivity: opts.onActivity,
      requestApproval: opts.requestApproval,
    });

    opts.onActivity?.(`${toolCall.tool}: ${result.ok ? "done" : "failed"}`);
    messages.push({
      role: "user",
      content: formatToolResult(toolCall.tool, result),
    });
  }

  const final = `I stopped after ${MAX_STEPS} tool steps to avoid looping. Ask me to continue if you want me to keep going.`;
  opts.onFinalToken?.(final);
  return final;
}

function buildToolProtocol(): string {
  return [
    "You can use local VS Code tools to inspect, edit, and verify the user's workspace.",
    "When you need a tool, respond with ONLY compact JSON and no Markdown:",
    '{"type":"tool_call","tool":"readFile","input":{"path":"src/App.tsx"}}',
    "After the tool result is provided, continue reasoning. Use another tool if needed, or give the final answer.",
    "Never claim you edited or ran a command unless a tool result confirms it.",
    "For edits, prefer applyPatch with exact oldText/newText. Use writeFile only for new files or small full-file replacements.",
    "For commands, use runCommand. Risky commands require user approval and destructive commands are blocked.",
    "Available tools:",
    getToolDescriptions(),
    `Tool names: ${getToolNames().join(", ")}`,
  ].join("\n");
}

function parseToolCall(text: string): ParsedToolCall | undefined {
  const trimmed = text.trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolResult(tool: string, result: ToolResult): string {
  return `TOOL_RESULT ${tool}:\n${JSON.stringify(result, null, 2)}\n\nUse this result to decide the next step. If the task is complete, answer normally. If more work is needed, call another tool with ONLY JSON.`;
}
