/**
 * Recursive Agent Loop — the core of the extension.
 *
 * Replaces the flat 30-step for-loop with a recursive reasoning loop
 * where the LLM naturally decides when to stop.
 *
 * Key features:
 * - Recursive depth tracking (max 50)
 * - Token budget guard integrated
 * - Git checkpoints before major edits
 * - Structured error recovery
 * - Persistent project memory
 * - Loop guard against stuck agents
 * - Parallel tool execution with batching
 */
import * as vscode from "vscode";
import { streamChat, stripToolCallsFromText, type ChatMessage, type StructuredToolCall } from "../shogoClient";
import { logInfo, logError, logDebug, logWarn } from "../logger";
import { executeTool, getToolNames, validateToolInput } from "./toolRegistry";
import type { ApprovalRequest, ToolResult } from "./types";
import { WorkingMemory } from "./workingMemory";
import { getEnvironmentContext, buildEnvironmentErrorContext, type EnvironmentContext } from "../context/environmentContext";
import { TokenBudget, type BudgetConfig } from "./tokenBudget";
import { buildErrorFeedback } from "./errorRecovery";
import { createCheckpoint, rollbackToCheckpoint, type Checkpoint } from "../tools/gitCheckpoint";
import { addLearning, recordErrorPattern, formatMemoryForContext } from "./projectMemory";
import { buildFullSystemPrompt } from "./systemPrompt";

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
  onBudgetWarning?: (summary: string) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  requestBudgetApproval?: (data: { summary: string; recentActions: string[]; remaining: number }) => Promise<"continue" | "stop" | "increase">;
  environment?: EnvironmentContext;
  budgetConfig?: Partial<BudgetConfig>;
}

// Limits
const MAX_RECURSION_DEPTH = 50;
const MAX_CONCURRENT_TOOLS = 4;
const COMPACTION_THRESHOLD_CHARS = 60000;
const TOOL_RESULT_MAX_CHARS = 4000;
const MAX_TOOL_ERROR_RETRIES = 3;
const CHARS_PER_TOKEN = 4;
const CONSECUTIVE_ERROR_LIMIT = 6;
const CHECKPOINT_THRESHOLD_TOOLS = 5; // Create checkpoint every N write tools

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function totalMessagesChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

function compactHistory(messages: ChatMessage[]): ChatMessage[] {
  if (totalMessagesChars(messages) < COMPACTION_THRESHOLD_CHARS) return messages;

  logWarn(`Context compaction triggered: ${totalMessagesChars(messages)} chars`);
  const keepRecent = 4;
  const recent = messages.slice(-keepRecent);
  const old = messages.slice(0, -keepRecent);

  const summaryParts: string[] = ["[CONTEXT COMPACTED — summary of earlier work]"];
  const filesRead = new Set<string>();
  const toolsUsed = new Map<string, number>();

  for (const msg of old) {
    if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.type === "tool_call" && parsed.tool) {
          toolsUsed.set(parsed.tool, (toolsUsed.get(parsed.tool) || 0) + 1);
          if (parsed.tool === "readFile" && parsed.input?.path) filesRead.add(parsed.input.path);
        }
      } catch {}
    }
  }

  if (filesRead.size > 0) summaryParts.push(`Files read: ${Array.from(filesRead).join(", ")}`);
  const toolSummary = Array.from(toolsUsed.entries()).map(([n, c]) => `${n}(${c}x)`).join(", ");
  if (toolSummary) summaryParts.push(`Tools used: ${toolSummary}`);

  const compacted: ChatMessage[] = [
    { role: "user", content: summaryParts.join("\n") },
    { role: "assistant", content: "I have the context from our previous conversation. Continuing..." },
    ...recent,
  ];

  logInfo(`Context compacted: ${messages.length} → ${compacted.length} messages`);
  return compacted;
}

function smartTruncateResult(tool: string, result: ToolResult): string {
  const payload = JSON.stringify(result);
  if (payload.length <= TOOL_RESULT_MAX_CHARS) return payload;

  if (tool === "readFile" && result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === "string" ? data.content : "";
    if (content.length > 3000) {
      const meta = { ...data, content: undefined };
      return JSON.stringify({
        ...meta,
        content: content.slice(0, 1500) + `\n... [${content.length - 3000} chars omitted] ...\n` + content.slice(-1500),
      }).slice(0, TOOL_RESULT_MAX_CHARS);
    }
  }

  if (tool === "searchWorkspace" && result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;
    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (matches.length > 15) {
      return JSON.stringify({ ...data, matches: matches.slice(0, 15), _note: `Showing 15 of ${matches.length}` }).slice(0, TOOL_RESULT_MAX_CHARS);
    }
  }

  if (tool === "runCommand" && result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    if (stdout.length > 2000) {
      return JSON.stringify({ ...data, stdout: stdout.slice(0, 1000) + `\n... [${stdout.length - 1500} omitted] ...\n` + stdout.slice(-500) }).slice(0, TOOL_RESULT_MAX_CHARS);
    }
  }

  return payload.slice(0, TOOL_RESULT_MAX_CHARS) + "...[truncated]";
}

function pruneHistory(messages: ChatMessage[]): ChatMessage[] {
  const protectedCount = 10;
  if (messages.length <= protectedCount) return messages;

  const pruned = [...messages.slice(0, -protectedCount)];
  for (let i = 0; i < pruned.length; i++) {
    if (pruned[i].role === "user" && pruned[i].content.startsWith("RESULT(")) {
      const match = pruned[i].content.match(/^RESULT\((\w+)\):(.*)/);
      if (match && match[2].length > TOOL_RESULT_MAX_CHARS) {
        pruned[i] = { ...pruned[i], content: `RESULT(${match[1]}):${match[2].slice(0, TOOL_RESULT_MAX_CHARS)}...[pruned]` };
      }
    }
  }
  return [...pruned, ...messages.slice(-protectedCount)];
}

function deduplicateToolCalls(toolCalls: StructuredToolCall[], seen: Map<string, number>): StructuredToolCall[] {
  return toolCalls.filter((tc) => {
    const key = `${tc.toolName}:${JSON.stringify(tc.input)}`;
    const count = seen.get(key) || 0;
    if (count >= 2) { logWarn(`Skipping duplicate: ${key}`); return false; }
    seen.set(key, count + 1);
    return true;
  });
}

// ── Concurrency limiter ──
function createSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (active < max) { active++; return; }
      return new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      active--;
      if (queue.length > 0) { active++; queue.shift()!(); }
    },
  };
}

function canParallel(a: StructuredToolCall, b: StructuredToolCall): boolean {
  if (a.toolName === b.toolName) {
    const pathA = (a.input as Record<string, unknown>).path;
    const pathB = (b.input as Record<string, unknown>).path;
    if (pathA && pathB && pathA === pathB) return false;
  }
  const writeTools = new Set(["applyPatch", "writeFile", "runCommand"]);
  if (writeTools.has(a.toolName) || writeTools.has(b.toolName)) return false;
  return true;
}

function groupIndependent(toolCalls: StructuredToolCall[]): StructuredToolCall[][] {
  const batches: StructuredToolCall[][] = [];
  let currentBatch: StructuredToolCall[] = [];
  for (const tc of toolCalls) {
    if (currentBatch.every((e) => canParallel(e, tc))) {
      currentBatch.push(tc);
    } else {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [tc];
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

// ── Write tool tracking for checkpoints ──
const WRITE_TOOLS = new Set(["applyPatch", "writeFile", "runCommand"]);
let writeToolCount = 0;
let lastCheckpoint: Checkpoint | null = null;

function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

// ── Loop guard ──
function detectStuckLoop(toolCalls: StructuredToolCall[], history: Map<string, number>): "ok" | "warn" | "force_stop" {
  if (toolCalls.length === 0) return "ok";
  const primary = toolCalls[0];
  const key = `${primary.toolName}:${JSON.stringify(primary.input)}`;
  const count = (history.get(key) || 0) + 1;
  history.set(key, count);

  if (count >= 3) return "force_stop";
  if (count >= 2) return "warn";
  return "ok";
}

/**
 * The recursive agent loop.
 * Called once to start — recurses until the task is complete or limits are hit.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  let messages: ChatMessage[] = opts.messages;
  const toolCallCounts = new Map<string, number>();
  const semaphore = createSemaphore(MAX_CONCURRENT_TOOLS);
  const memory = new WorkingMemory(opts.messages[opts.messages.length - 1]?.content || "");
  const tokenBudget = new TokenBudget(opts.budgetConfig);

  let successfulToolCalls = 0;
  let consecutiveToolErrors = 0;
  let writeToolsExecuted = 0;

  // Reset checkpoint tracking
  writeToolCount = 0;
  lastCheckpoint = null;

  // Build the full system prompt with the new architecture
  const fullSystem = buildFullSystemPrompt({
    workspaceName: opts.messages.length > 0 ? undefined : undefined,
    environment: opts.environment,
  });

  // Append project memory context
  const memoryContext = formatMemoryForContext();
  const systemWithMemory = memoryContext
    ? `${fullSystem}\n\n${memoryContext}`
    : fullSystem;

  logInfo(`Agent loop starting (recursive): model=${opts.model}, depth=0/${MAX_RECURSION_DEPTH}, budget=${tokenBudget.formatUsage()}`);

  // ── Start recursive loop ──
  const result = await agentStep({
    messages,
    system: systemWithMemory,
    depth: 0,
    opts,
    tokenBudget,
    memory,
    toolCallCounts,
    semaphore,
    successfulToolCalls: 0,
    consecutiveToolErrors: 0,
    writeToolsExecuted: 0,
  });

  return result;
}

interface StepContext {
  messages: ChatMessage[];
  system: string;
  depth: number;
  opts: AgentLoopOptions;
  tokenBudget: TokenBudget;
  memory: WorkingMemory;
  toolCallCounts: Map<string, number>;
  semaphore: ReturnType<typeof createSemaphore>;
  successfulToolCalls: number;
  consecutiveToolErrors: number;
  writeToolsExecuted: number;
}

async function agentStep(ctx: StepContext): Promise<string> {
  const { messages, system, depth, opts, tokenBudget, memory, toolCallCounts, semaphore } = ctx;

  // ── Depth guard ──
  if (depth >= MAX_RECURSION_DEPTH) {
    logWarn(`Max recursion depth reached (${MAX_RECURSION_DEPTH}). Summarizing progress.`);
    const summary = `Stopped after ${MAX_RECURSION_DEPTH} recursive steps.\n\nWorking memory:\n${memory.toSummary()}\n\nAsk me to continue if needed.`;
    opts.onFinalToken?.(summary);
    return summary;
  }

  // ── Consecutive error guard ──
  if (ctx.consecutiveToolErrors >= CONSECUTIVE_ERROR_LIMIT) {
    const msg = `Stopping: ${ctx.consecutiveToolErrors} consecutive tool errors. Too many failures — try a different approach or rephrase the task.`;
    logWarn(msg);
    opts.onFinalToken?.(msg);
    return msg;
  }

  logDebug(`Step ${depth + 1}/${MAX_RECURSION_DEPTH} | Budget: ${tokenBudget.formatUsage()}`);

  // ── Compact and prune history ──
  let currentMessages = compactHistory(messages);
  currentMessages = pruneHistory(currentMessages);

  let responseText = "";
  let toolCalls: StructuredToolCall[] = [];

  // ── LLM call ──
  try {
    const streamResult = await streamChat({
      apiKey: opts.apiKey,
      model: opts.model,
      apiUrl: opts.apiUrl,
      system,
      messages: currentMessages,
      signal: opts.signal,
      onToken: (chunk) => { responseText += chunk; },
    });

    toolCalls = streamResult.toolCalls.map((tc) => {
      let input = tc.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch {} }
      if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
      return { ...tc, input: input as Record<string, unknown> };
    });

    // Track token usage if available
    if ((streamResult as any).usage) {
      const usage = (streamResult as any).usage;
      tokenBudget.trackUsage(opts.model, usage.promptTokens || 0, usage.completionTokens || 0);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.includes("AbortError")) {
      logInfo("Agent loop aborted by user");
      return "Generation stopped.";
    }
    logError(`LLM call failed at depth ${depth}`, err);
    return `Error: ${msg}`;
  }

  // ── No tool calls → LLM wants to answer ──
  if (toolCalls.length === 0) {
    logDebug(`No tool calls at depth ${depth + 1}. Response: ${responseText.length} chars`);
    const cleanedText = stripToolCallsFromText(responseText);

    // Check for false success (claimed without executing)
    if (ctx.successfulToolCalls === 0 && looksLikeUnverifiedWorkspaceSuccess(cleanedText)) {
      currentMessages.push({ role: "assistant", content: responseText });
      currentMessages.push({ role: "user", content: "No tool was executed. Do not claim success without running a tool." });
      return agentStep({ ...ctx, messages: currentMessages, depth: depth + 1 });
    }

    // Check for orphan JSON (malformed tool call)
    const orphanChars = cleanedText.replace(/^[{}\s,]+|[{}\s,]+$/g, "");
    if (orphanChars.length === 0 && responseText.includes("tool_call")) {
      logWarn(`Malformed tool call at depth ${depth + 1}`);
      currentMessages.push({ role: "assistant", content: responseText });
      currentMessages.push({
        role: "user",
        content: `Malformed tool call. Output ONLY: {"type":"tool_call","tool":"<name>","input":{...}}\nAvailable: ${getToolNames().join(", ")}`,
      });
      return agentStep({ ...ctx, messages: currentMessages, depth: depth + 1 });
    }

    opts.onFinalToken?.(cleanedText);
    return cleanedText;
  }

  // ── Deduplicate tool calls ──
  toolCalls = deduplicateToolCalls(toolCalls, toolCallCounts);

  // ── Loop guard ──
  const loopStatus = detectStuckLoop(toolCalls, toolCallCounts);
  if (loopStatus === "force_stop") {
    logWarn(`Loop guard: same tool called 3+ times consecutively — forcing response`);
    currentMessages.push({
      role: "user",
      content: `CRITICAL: You are stuck in a loop. HALT tool execution and synthesize your answer now using information you already have. Working memory:\n${memory.toSummary()}`,
    });
    return agentStep({ ...ctx, messages: currentMessages, depth: depth + 1 });
  }
  if (loopStatus === "warn") {
    logWarn(`Loop guard: same tool called 2 times consecutively`);
    currentMessages.push({
      role: "user",
      content: `WARNING: You're repeating the same action. Choose a different approach or provide your analysis.`,
    });
    return agentStep({ ...ctx, messages: currentMessages, depth: depth + 1 });
  }

  // ── Execute tools in parallel batches ──
  const batches = groupIndependent(toolCalls);
  logDebug(`Executing ${toolCalls.length} tools in ${batches.length} batch(es) at depth ${depth + 1}`);

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (tc) => {
        await semaphore.acquire();
        try { return await executeSingleTool(tc, opts); }
        finally { semaphore.release(); }
      })
    );

    for (const { toolCall, result } of results) {
      if (result.ok) {
        ctx.successfulToolCalls++;
        ctx.consecutiveToolErrors = 0;
      } else {
        ctx.consecutiveToolErrors++;
      }

      // Track write tools for checkpoints
      if (isWriteTool(toolCall.toolName) && result.ok) {
        ctx.writeToolsExecuted++;
        writeToolCount++;
      }

      // Update working memory
      memory.updateFromToolResult(toolCall.toolName, toolCall.input, result);

      opts.onActivity?.(`${toolCall.toolName}: ${result.ok ? "done" : "failed"}`);
      currentMessages.push({
        role: "user",
        content: `RESULT(${toolCall.toolName}):${smartTruncateResult(toolCall.toolName, result)}`,
      });

      // Structured error recovery feedback
      if (!result.ok) {
        const errorDetail = typeof result.error === "string" ? result.error : "unknown error";
        const env = opts.environment || await getEnvironmentContext().catch(() => undefined);

        const feedback = buildErrorFeedback(toolCall.toolName, toolCall.input, errorDetail, 1, env);
        currentMessages.push({ role: "user", content: feedback });

        // Record error pattern for persistent memory
        recordErrorPattern(`${toolCall.toolName}: ${errorDetail.slice(0, 100)}`, feedback.slice(0, 200));
      }
    }
  }

  // ── Token budget check ──
  const budgetCheck = tokenBudget.check();

  if (budgetCheck.action === "warn") {
    const warningMsg = `⚠️ Token Budget: ${tokenBudget.formatUsage()}`;
    logWarn(warningMsg);
    opts.onBudgetWarning?.(warningMsg);
  }

  if (budgetCheck.action === "pause") {
    logWarn(`Token budget exceeded: ${tokenBudget.formatUsage()}`);

    if (opts.requestBudgetApproval) {
      const recentActions = toolCallCounts.size > 0
        ? Array.from(toolCallCounts.entries()).slice(-5).map(([k]) => k)
        : [];

      const decision = await opts.requestBudgetApproval({
        summary: tokenBudget.formatUsage(),
        recentActions,
        remaining: tokenBudget.getRemaining(),
      });

      if (decision === "stop") {
        const summary = `Task paused — token budget exceeded.\n\n${tokenBudget.formatUsage()}\n\nWorking memory:\n${memory.toSummary()}`;
        opts.onFinalToken?.(summary);
        return summary;
      }

      if (decision === "increase") {
        tokenBudget.increaseLimit(5.0);
      }

      tokenBudget.approve();
    } else {
      // No approval UI available — just warn and continue
      tokenBudget.approve();
    }
  }

  // ── Create git checkpoint periodically for write-heavy tasks ──
  if (ctx.writeToolsExecuted > 0 && ctx.writeToolsExecuted % CHECKPOINT_THRESHOLD_TOOLS === 0) {
    try {
      const checkpoint = await createCheckpoint(`auto: ${ctx.writeToolsExecuted} write tools executed`);
      if (checkpoint) {
        lastCheckpoint = checkpoint;
        logInfo(`Auto-checkpoint created: ${checkpoint.hash.slice(0, 8)}`);
      }
    } catch (err) {
      logWarn(`Failed to create auto-checkpoint: ${err}`);
    }
  }

  // ── Record learnings from successful tool calls ──
  if (ctx.successfulToolCalls > 0 && ctx.successfulToolCalls % 10 === 0) {
    addLearning(
      "pattern",
      `Task progress: ${memory.getToolCallCount()} tool calls, ${ctx.successfulToolCalls} successful`,
      "agent-loop",
      0.6,
    );
  }

  // ── RECURSE ──
  return agentStep({
    messages: currentMessages,
    system,
    depth: depth + 1,
    opts,
    tokenBudget,
    memory,
    toolCallCounts,
    semaphore,
    successfulToolCalls: ctx.successfulToolCalls,
    consecutiveToolErrors: ctx.consecutiveToolErrors,
    writeToolsExecuted: ctx.writeToolsExecuted,
  });
}

async function executeSingleTool(
  toolCall: StructuredToolCall,
  opts: AgentLoopOptions,
): Promise<{ toolCall: StructuredToolCall; result: ToolResult }> {
  opts.onActivity?.(`Tool: ${toolCall.toolName}`);

  const validationError = validateToolInput(toolCall.toolName, toolCall.input);
  if (validationError) {
    return { toolCall, result: { ok: false, error: validationError } };
  }

  logInfo(`Executing: ${toolCall.toolName}(${JSON.stringify(toolCall.input).slice(0, 200)})`);
  const result = await executeTool(toolCall.toolName, toolCall.input, {
    extensionContext: opts.extensionContext,
    signal: opts.signal,
    postActivity: opts.onActivity,
    requestApproval: opts.requestApproval,
  });

  return { toolCall, result };
}

function looksLikeUnverifiedWorkspaceSuccess(text: string): boolean {
  const n = stripToolCallsFromText(text).toLowerCase();
  return /\b(created|wrote|updated|modified|fixed|ran|applied)\b/.test(n) &&
    /\b(i have|i've|successfully|done|completed)\b/.test(n);
}
