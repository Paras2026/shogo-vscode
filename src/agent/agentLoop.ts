import * as vscode from "vscode";
import { streamChat, stripToolCallsFromText, type ChatMessage, type StructuredToolCall } from "../shogoClient";
import { logInfo, logError, logDebug, logWarn } from "../logger";
import { executeTool, getToolDescriptions, getToolNames, validateToolInput } from "./toolRegistry";
import type { ApprovalRequest, ToolResult } from "./types";

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

const MAX_STEPS = 30;
const COMPACTION_THRESHOLD_CHARS = 60000;
const TOOL_RESULT_MAX_CHARS = 3000;
const MAX_TOOL_ERROR_RETRIES = 3;
const CHARS_PER_TOKEN = 4;

function estimateChars(text: string): number {
  return text.length;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function totalMessagesChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

function compactHistory(messages: ChatMessage[]): ChatMessage[] {
  if (totalMessagesChars(messages) < COMPACTION_THRESHOLD_CHARS) {
    return messages;
  }

  logWarn(`Context compaction triggered: ${totalMessagesChars(messages)} chars exceeds ${COMPACTION_THRESHOLD_CHARS}`);

  const keepRecent = 4;
  const recent = messages.slice(-keepRecent);
  const old = messages.slice(0, -keepRecent);

  const summaryParts: string[] = [];
  summaryParts.push("[CONTEXT COMPACTED — summary of earlier work]");

  let filesRead = new Set<string>();
  let filesSearched = new Set<string>();
  let toolsUsed = new Map<string, number>();

  for (const msg of old) {
    if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.type === "tool_call" && parsed.tool && parsed.input) {
          toolsUsed.set(parsed.tool, (toolsUsed.get(parsed.tool) || 0) + 1);
          if (parsed.tool === "readFile" && parsed.input.path) {
            filesRead.add(parsed.input.path);
          }
          if (parsed.tool === "searchWorkspace" && parsed.input.query) {
            filesSearched.add(parsed.input.query);
          }
          if (parsed.tool === "listFiles" && parsed.input.pattern) {
            filesSearched.add("list:" + parsed.input.pattern);
          }
        }
      } catch { /* not JSON */ }
    }
    if (msg.role === "user" && msg.content.startsWith("RESULT(")) {
      const match = msg.content.match(/^RESULT\((\w+)\):/);
      if (match) toolsUsed.set(match[1], (toolsUsed.get(match[1]) || 0) + 1);
    }
  }

  if (filesRead.size > 0) {
    summaryParts.push(`Files read: ${Array.from(filesRead).join(", ")}`);
  }
  if (filesSearched.size > 0) {
    summaryParts.push(`Searches performed: ${Array.from(filesSearched).join(", ")}`);
  }

  const toolSummary = Array.from(toolsUsed.entries())
    .map(([name, count]) => `${name}(${count}x)`)
    .join(", ");
  if (toolSummary) {
    summaryParts.push(`Tools used: ${toolSummary}`);
  }

  let lastUserMsg = "";
  for (let i = old.length - 1; i >= 0; i--) {
    if (old[i].role === "user" && !old[i].content.startsWith("RESULT(")) {
      lastUserMsg = old[i].content.slice(0, 500);
      break;
    }
  }
  if (lastUserMsg) {
    summaryParts.push(`Original task: "${lastUserMsg}"`);
  }

  const compacted: ChatMessage[] = [
    { role: "user", content: summaryParts.join("\n") },
    { role: "assistant", content: "I have the context from our previous conversation. Continuing..." },
    ...recent,
  ];

  logInfo(`Context compacted: ${messages.length} messages → ${compacted.length} messages (${totalMessagesChars(compacted)} chars)`);
  return compacted;
}

function pruneToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) {
    return content;
  }
  const match = content.match(/^RESULT\((\w+)\):/);
  if (match) {
    const toolName = match[1];
    const rest = content.slice(match[0].length);
    const truncated = rest.slice(0, TOOL_RESULT_MAX_CHARS) + `\n...[pruned ${rest.length - TOOL_RESULT_MAX_CHARS} chars]`;
    return `RESULT(${toolName}):${truncated}`;
  }
  return content.slice(0, TOOL_RESULT_MAX_CHARS) + `\n...[pruned]`;
}

function pruneHistory(messages: ChatMessage[]): ChatMessage[] {
  const protectedCount = 10;
  if (messages.length <= protectedCount) return messages;

  const pruned = [...messages.slice(0, -protectedCount)];
  for (let i = 0; i < pruned.length; i++) {
    if (pruned[i].role === "user" && pruned[i].content.startsWith("RESULT(")) {
      pruned[i] = { ...pruned[i], content: pruneToolResult(pruned[i].content) };
    }
  }
  return [...pruned, ...messages.slice(-protectedCount)];
}

function deduplicateToolCalls(toolCalls: StructuredToolCall[], seen: Map<string, number>): StructuredToolCall[] {
  return toolCalls.filter((tc) => {
    const key = `${tc.toolName}:${JSON.stringify(tc.input)}`;
    const count = seen.get(key) || 0;
    if (count >= 2) {
      logWarn(`Skipping duplicate tool call: ${key} (called ${count} times already)`);
      return false;
    }
    seen.set(key, count + 1);
    return true;
  });
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  let messages: ChatMessage[] = opts.messages;
  const system = `${opts.system}\n\n${buildToolProtocol()}`;
  let successfulToolCalls = 0;
  let consecutiveToolErrors = 0;
  let correctedFalseSuccess = false;
  const toolCallCounts = new Map<string, number>();

  logInfo(`Agent loop starting: model=${opts.model}, history=${messages.length} msgs, system=${estimateTokens(system)} tokens`);

  for (let step = 0; step < MAX_STEPS; step++) {
    logDebug(`Step ${step + 1}/${MAX_STEPS}`);

    messages = compactHistory(messages);
    messages = pruneHistory(messages);

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
      const cleanedText = stripToolCallsFromText(responseText);

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

      const orphanChars = cleanedText.replace(/^[{}\s,]+|[{}\s,]+$/g, "");
      if (orphanChars.length === 0 && responseText.includes("tool_call")) {
        logWarn(`Response was entirely a tool call that wasn't parsed. Raw: ${responseText.slice(0, 200)}`);
        messages.push({ role: "assistant", content: responseText });
        messages.push({
          role: "user",
          content: [
            "Your tool call was malformed and could not be parsed.",
            "Output ONLY the raw JSON object — no text before or after.",
            `Format: {"type":"tool_call","tool":"<name>","input":{...}}`,
            `Available tools: ${getToolNames().join(", ")}`,
          ].join("\n"),
        });
        continue;
      }

      opts.onFinalToken?.(cleanedText);
      return cleanedText;
    }

    toolCalls = deduplicateToolCalls(toolCalls, toolCallCounts);

    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: responseText });
      messages.push({
        role: "user",
        content: "You repeated an action you've already done. Choose a different approach or provide your analysis.",
      });
      continue;
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
  const final = `I stopped after ${MAX_STEPS} steps. Ask me to continue if you want me to keep going.`;
  opts.onFinalToken?.(final);
  return final;
}

function buildToolProtocol(): string {
  const toolNames = getToolNames().join(", ");
  return [
    "━━━ TOOL CALLING FORMAT ━━━",
    "You have access to tools. When you need to use a tool, output ONLY a JSON object — nothing else:",
    "",
    '{"type":"tool_call","tool":"readFile","input":{"path":"src/index.ts"}}',
    '{"type":"tool_call","tool":"searchWorkspace","input":{"query":"export function"}}',
    '{"type":"tool_call","tool":"runCommand","input":{"command":"ls -la"}}',
    '{"type":"tool_call","tool":"applyPatch","input":{"path":"src/index.ts","oldText":"old","newText":"new"}}',
    "",
    "RULES:",
    "1. Output ONLY the JSON object. No markdown fences, no explanation before/after.",
    "2. The JSON must be valid with nested braces properly closed.",
    `3. Available tools: ${toolNames}`,
    "4. Use tools to inspect and modify files. Never guess file contents.",
    "5. For edits: readFile first, then applyPatch with the EXACT oldText.",
    "6. One tool call per response. After the tool result, call the next tool.",
    "7. After gathering enough information (10+ tool calls), provide your analysis and stop calling tools.",
    "8. NEVER repeat the same tool call with the same parameters.",
    "9. When writing your final analysis, reference specific files and line numbers.",
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
  const normalized = stripToolCallsFromText(text).toLowerCase();
  const successVerb = /\b(created|wrote|updated|modified|changed|edited|deleted|removed|renamed|moved|fixed|ran|executed|installed|applied)\b/;
  const successPhrase = /\b(i('|')?ve|i have|i successfully|successfully|done[,!]?|completed)\b/;
  const workspaceTarget = /\b(file|folder|workspace|project|command|terminal|script|test|package|dependency|diff|patch|code|component|function|class|repo|branch|commit)\b/;
  return successVerb.test(normalized) && (successPhrase.test(normalized) || workspaceTarget.test(normalized));
}

function formatToolResult(tool: string, result: ToolResult): string {
  const payload = JSON.stringify(result);
  const maxChars = TOOL_RESULT_MAX_CHARS;
  const truncated = payload.length > maxChars ? payload.slice(0, maxChars) + "...[truncated]" : payload;
  return `RESULT(${tool}):${truncated}`;
}
