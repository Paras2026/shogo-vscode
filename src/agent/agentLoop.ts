import * as vscode from "vscode";
import { streamChat, type ChatMessage, type StructuredToolCall } from "../shogoClient";
import { logInfo as logInfoImport, logError, logDebug, logWarn } from "../logger";
import { executeTool, getToolDescriptions, validateToolInput } from "./toolRegistry";
import type { ApprovalRequest, ToolResult } from "./types";
import { logInfo, logError, logWarn, logDebug } from "../logger";

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

const MAX_STEPS = 16;
const MAX_HISTORY_CHARS = 40000;
const MAX_TOOL_ERROR_RETRIES = 3;
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


function parseTextToolCalls(text: string): StructuredToolCall[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    const toolName = typeof parsed.tool === "string" ? parsed.tool
      : typeof parsed.name === "string" ? parsed.name
      : undefined;
    if (!toolName) return [];

    let input: Record<string, unknown> = {};
    if (parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)) {
      input = parsed.input as Record<string, unknown>;
    } else if (parsed.arguments && typeof parsed.arguments === "object") {
      input = parsed.arguments as Record<string, unknown>;
    }

    return [{ toolCallId: `text-${Date.now()}`, toolName, input }];
  } catch {
    return [];
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  const messages: ChatMessage[] = trimHistory(opts.messages);
  const system = `${opts.system}\n\n${buildToolProtocol()}`;
  let successfulToolCalls = 0;
  let consecutiveToolErrors = 0;
  let correctedFalseSuccess = false;

  logInfo(`Agent loop starting: model=${opts.model}, history=${messages.length} msgs, system=${system.length} chars`);

  for (let step = 0; step < MAX_STEPS; step++) {
    logDebug(`Step ${step + 1}/${MAX_STEPS}`);
    let responseText = "";
    let toolCalls: StructuredToolCall[] = [];

    const streamResult = await streamChat({
      apiKey: opts.apiKey,
      model: opts.model,
      apiUrl: opts.apiUrl,
      system,
      messages,
      signal: opts.signal,
      onToken: (chunk) => {
        responseText += chunk;
      },
    });

    toolCalls = streamResult.toolCalls.map((tc) => {
      let input = tc.input;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { /* keep as-is */ }
      }
      if (input === null || input === undefined) input = {};
      if (typeof input !== "object" || Array.isArray(input)) input = {};
      return { ...tc, input: input as Record<string, unknown> };
    });

    if (toolCalls.length === 0) {
      logDebug(`No tool calls. Response text: ${responseText.length} chars`);
      const cleanedText = stripToolMarkup(responseText);

      if (!correctedFalseSuccess && successfulToolCalls === 0 && looksLikeUnverifiedWorkspaceSuccess(cleanedText)) {
        correctedFalseSuccess = true;
        messages.push({ role: "assistant", content: responseText });
        messages.push({
          role: "user",
          content:
            "No tool was executed. Do not claim success without running a tool. Call the appropriate tool now.",
        });
        continue;
      }

      opts.onFinalToken?.(cleanedText);
      return cleanedText;
    }

    for (const toolCall of toolCalls) {
      opts.onActivity?.(`Tool: ${toolCall.toolName}`);

      const validationError = validateToolInput(toolCall.toolName, toolCall.input);
      if (validationError) {
        consecutiveToolErrors++;
        const errorFeedback = `Tool parameter error for ${toolCall.toolName}: ${validationError}. Check the parameter names and types.`;
        opts.onActivity?.(`${toolCall.toolName}: failed (bad params)`);
        messages.push({
          role: "assistant",
          content: JSON.stringify({ type: "tool_call", tool: toolCall.toolName, input: toolCall.input }),
        });
        messages.push({ role: "user", content: errorFeedback });
        continue;
      }

      messages.push({
        role: "assistant",
        content: JSON.stringify({ type: "tool_call", tool: toolCall.toolName, input: toolCall.input }),
      });

      logInfo(`Executing tool: ${toolCall.toolName}(${JSON.stringify(toolCall.input).slice(0, 200)})`);
      let result = await executeTool(toolCall.toolName, toolCall.input, {
        extensionContext: opts.extensionContext,
        signal: opts.signal,
        postActivity: opts.onActivity,
        requestApproval: opts.requestApproval,
      });

      let retryCount = 0;
      while (!result.ok && retryCount < MAX_TOOL_ERROR_RETRIES) {
        retryCount++;
        const retryFeedback = buildRetryFeedback(toolCall.toolName, toolCall.input, result, retryCount);
        opts.onActivity?.(`${toolCall.toolName}: retry ${retryCount} — ${result.error}`);
        messages.push({ role: "user", content: retryFeedback });

        const retryResult = await streamChat({
          apiKey: opts.apiKey,
          model: opts.model,
          apiUrl: opts.apiUrl,
          system,
          messages,
          signal: opts.signal,
          onToken: () => {},
        });

        if (retryResult.toolCalls.length === 0) {
          break;
        }

        const retryCall = retryResult.toolCalls[0];
        messages.push({
          role: "assistant",
          content: JSON.stringify({ type: "tool_call", tool: retryCall.toolName, input: retryCall.input }),
        });

        result = await executeTool(retryCall.toolName, retryCall.input, {
          extensionContext: opts.extensionContext,
          signal: opts.signal,
          postActivity: opts.onActivity,
          requestApproval: opts.requestApproval,
        });

        toolCall.toolName = retryCall.toolName;
        toolCall.input = retryCall.input;
      }

      if (result.ok) {
        successfulToolCalls += 1;
        consecutiveToolErrors = 0;
      } else {
        consecutiveToolErrors++;
      }

      opts.onActivity?.(`${toolCall.toolName}: ${result.ok ? "done" : "failed"}`);
      messages.push({
        role: "user",
        content: formatToolResult(toolCall.toolName, result),
      });
    }

    if (consecutiveToolErrors >= 6) {
      const msg = "Stopping: too many consecutive tool errors. Please try a different approach or ask the user for help.";
      opts.onFinalToken?.(msg);
      return msg;
    }
  }

  logInfo(`Agent loop ended after ${MAX_STEPS} steps. Successful tools: ${successfulToolCalls}`);
  const final = `I stopped after ${MAX_STEPS} steps to avoid looping. Ask me to continue if you want me to keep going.`;
  opts.onFinalToken?.(final);
  return final;
}

function buildToolProtocol(): string {
  return [
    "TOOL CALLING RULES:",
    "1. To use a tool, output ONLY a JSON object with this exact format:",
    '   {"type":"tool_call","tool":"<toolName>","input":{...}}',
    "2. Do NOT wrap the JSON in code fences or add any text before/after it.",
    "3. You MUST call tools to inspect or modify files. Never guess file contents.",
    "4. For edits: first read the file with readFile, then use applyPatch with the EXACT oldText.",
    "5. For new files: use writeFile with the complete content.",
    "6. If a tool fails, fix your parameters and try again.",
    "",
    "AVAILABLE TOOLS:",
    getToolDescriptions(),
  ].join("\n");
}

function buildRetryFeedback(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  retryCount: number
): string {
  const errorDetail = result.error ?? "Unknown error";

  if (toolName === "applyPatch") {
    const path = typeof args.path === "string" ? args.path : "unknown";
    if (errorDetail.includes("not found") || errorDetail.includes("not unique")) {
      return [
        `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}`,
        "You MUST read the file again with readFile to get the current content.",
        "Then use the EXACT text from the file as oldText — character for character, including whitespace.",
        "Do not modify or paraphrase the oldText.",
      ].join("\n");
    }
  }

  if (toolName === "readFile") {
    return [
      `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}`,
      "Check the file path. Use listFiles to discover available files.",
    ].join("\n");
  }

  return `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}. Fix your input and try again.`;
}

function looksLikeUnverifiedWorkspaceSuccess(text: string): boolean {
  const normalized = stripToolMarkup(text).toLowerCase();
  const successVerb = /\b(created|wrote|updated|modified|changed|edited|deleted|removed|renamed|moved|fixed|ran|executed|installed|applied)\b/;
  const successPhrase = /\b(i('|')?ve|i have|i successfully|successfully|done[,!]?|completed)\b/;
  const workspaceTarget = /\b(file|folder|workspace|project|command|terminal|script|test|package|dependency|diff|patch|code|component|function|class|repo|branch|commit)\b/;
  return successVerb.test(normalized) && (successPhrase.test(normalized) || workspaceTarget.test(normalized));
}

function stripToolMarkup(text: string): string {
  return text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
    .replace(/```json\s*\{[\s\S]*?\}\s*```/gi, "")
    .trim();
}

function formatToolResult(tool: string, result: ToolResult): string {
  const payload = JSON.stringify(result);
  const truncated = payload.length > 8000 ? payload.slice(0, 8000) + "...[truncated]" : payload;
  return `RESULT(${tool}):${truncated}`;
}
