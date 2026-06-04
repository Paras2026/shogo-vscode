import * as vscode from "vscode";
import { streamChat, stripToolCallsFromText, type ChatMessage, type StructuredToolCall } from "../shogoClient";
import { logInfo, logError, logDebug, logWarn } from "../logger";
import { executeTool, getToolDescriptions, getToolNames, validateToolInput } from "./toolRegistry";
import type { ApprovalRequest, ToolResult } from "./types";
import { WorkingMemory } from "./workingMemory";
import { getEnvironmentContext, buildEnvironmentErrorContext, type EnvironmentContext } from "../context/environmentContext";

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
  environment?: EnvironmentContext;
}

const MAX_STEPS = 30;
const MAX_CONCURRENT_TOOLS = 4;
const COMPACTION_THRESHOLD_CHARS = 60000;
const TOOL_RESULT_MAX_CHARS = 4000;
const MAX_TOOL_ERROR_RETRIES = 3;
const CHARS_PER_TOKEN = 4;

// Phase budgets (safety caps — the LLM can transition early)
const PHASE_BUDGETS: Record<string, number> = {
  explore: 15,
  diagnose: 10,
  respond: 0,
};

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

// ── Phase detection ──
type AgentPhase = "explore" | "diagnose" | "respond";

function detectPhaseFromResponse(text: string): AgentPhase | null {
  const lower = text.toLowerCase();
  // LLM signals it's ready to diagnose
  if (/\b(diagnos|root cause|the (problem|issue|bug) (is|seems|appears))\b/i.test(lower)) return "diagnose";
  // LLM signals it's ready to respond
  if (/\b(here('s| is) (my |the )?(analysis|fix|solution|recommendation|answer|response))\b/i.test(lower)) return "respond";
  return null;
}

// ── Task decomposition ──
function shouldDecomposeTask(userMessage: string): boolean {
  if (userMessage.length < 50) return false;
  const taskKeywords = /\b(fix|bug|issue|error|implement|feature|refactor|optimize|debug|update|replace|add|remove|create)\b/i;
  return taskKeywords.test(userMessage);
}

async function generatePlan(
  apiKey: string, model: string, apiUrl: string | undefined,
  system: string, userMessage: string, signal?: AbortSignal
): Promise<string | null> {
  const planPrompt: ChatMessage[] = [
    { role: "user", content: `Create a brief plan for this task. Output a JSON object with "goal" and "subtasks" (array of strings, max 6). No explanation, just JSON.\n\nTask: ${userMessage.slice(0, 500)}` },
  ];

  try {
    const result = await streamChat({ apiKey, model, apiUrl, system: "You are a planning assistant. Output only JSON.", messages: planPrompt, signal, onToken: () => {} });
    const text = result.text.trim();
    // Try to extract JSON plan
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      if (plan.goal && Array.isArray(plan.subtasks)) {
        return `PLAN: ${plan.goal}\nSubtasks:\n${plan.subtasks.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`;
      }
    }
  } catch {}
  return null;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  let messages: ChatMessage[] = opts.messages;
  const system = `${opts.system}\n\n${buildToolProtocol()}`;
  let successfulToolCalls = 0;
  let consecutiveToolErrors = 0;
  let correctedFalseSuccess = false;
  const toolCallCounts = new Map<string, number>();
  const semaphore = createSemaphore(MAX_CONCURRENT_TOOLS);
  const memory = new WorkingMemory(opts.messages[opts.messages.length - 1]?.content || "");

  // Phase state
  let currentPhase: AgentPhase = "explore";
  const phaseStepCounts: Record<AgentPhase, number> = { explore: 0, diagnose: 0, respond: 0 };

  // Loop guard state
  let consecutiveDuplicates = 0;
  let lastToolCallKey = "";
  let loopGuardTriggered = false;

  logInfo(`Agent loop starting: model=${opts.model}, history=${messages.length} msgs, system=${estimateTokens(system)} tokens`);

  // Task decomposition for complex tasks
  const lastUserMsg = opts.messages[opts.messages.length - 1]?.content || "";
  if (shouldDecomposeTask(lastUserMsg)) {
    logInfo("Complex task detected — generating plan");
    const plan = await generatePlan(opts.apiKey, opts.model, opts.apiUrl, opts.system, lastUserMsg, opts.signal);
    if (plan) {
      memory.addFinding(plan);
      logInfo(`Task plan generated:\n${plan}`);
    }
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    logDebug(`Step ${step + 1}/${MAX_STEPS} | Phase: ${currentPhase} | Memory: ${memory.getToolCallCount()} tools`);
    phaseStepCounts[currentPhase]++;

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
      onToken: (chunk) => { responseText += chunk; },
    });

    toolCalls = streamResult.toolCalls.map((tc) => {
      let input = tc.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch {} }
      if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
      return { ...tc, input: input as Record<string, unknown> };
    });

    // No tool calls → model wants to answer
    if (toolCalls.length === 0) {
      logDebug(`No tool calls. Response: ${responseText.length} chars`);
      const cleanedText = stripToolCallsFromText(responseText);

      if (!correctedFalseSuccess && successfulToolCalls === 0 && looksLikeUnverifiedWorkspaceSuccess(cleanedText)) {
        correctedFalseSuccess = true;
        messages.push({ role: "assistant", content: responseText });
        messages.push({ role: "user", content: "No tool was executed. Do not claim success without running a tool." });
        continue;
      }

      const orphanChars = cleanedText.replace(/^[{}\s,]+|[{}\s,]+$/g, "");
      if (orphanChars.length === 0 && responseText.includes("tool_call")) {
        logWarn(`Malformed tool call in response`);
        messages.push({ role: "assistant", content: responseText });
        messages.push({
          role: "user",
          content: `Malformed tool call. Output ONLY: {"type":"tool_call","tool":"<name>","input":{...}}\nAvailable: ${getToolNames().join(", ")}`,
        });
        continue;
      }

      opts.onFinalToken?.(cleanedText);
      return cleanedText;
    }

    toolCalls = deduplicateToolCalls(toolCalls, toolCallCounts);

    // ── Loop Guard: detect consecutive duplicate tool calls ──
    if (toolCalls.length > 0) {
      const primary = toolCalls[0];
      const currentKey = `${primary.toolName}:${JSON.stringify(primary.input)}`;
      if (currentKey === lastToolCallKey && currentKey !== "") {
        consecutiveDuplicates++;
      } else {
        consecutiveDuplicates = 0;
        lastToolCallKey = currentKey;
      }

      if (consecutiveDuplicates >= 2 && !loopGuardTriggered) {
        logWarn(`Loop guard triggered: same tool called ${consecutiveDuplicates + 1} times consecutively`);
        loopGuardTriggered = true;
        messages.push({
          role: "system",
          content: "CRITICAL: You are stuck in an execution loop calling the exact same tool with identical parameters. You must immediately HALT further tool execution and synthesize your answer now using only the information you already possess. Do NOT call any more tools.",
        });
        // Reset to give model one chance to respond
        consecutiveDuplicates = 0;
        lastToolCallKey = "";
        continue;
      }

      if (loopGuardTriggered && consecutiveDuplicates >= 1) {
        logWarn("Loop guard: second violation — forcing response");
        const msg = `I'm stuck in a loop. Here's what I know so far:\n\n${memory.toSummary()}`;
        opts.onFinalToken?.(msg);
        return msg;
      }
    }

    if (toolCalls.length === 0) {
      loopGuardTriggered = false;
      consecutiveDuplicates = 0;
      lastToolCallKey = "";
      messages.push({ role: "assistant", content: responseText });
      messages.push({ role: "user", content: "You repeated an identical action. Choose a different approach or provide your analysis." });
      continue;
    }

    // Execute tools in parallel batches
    const batches = groupIndependent(toolCalls);
    logDebug(`Executing ${toolCalls.length} tools in ${batches.length} batch(es)`);

    for (const batch of batches) {
      const results = await Promise.all(
        batch.map(async (tc) => {
          await semaphore.acquire();
          try { return await executeSingleTool(tc, opts); }
          finally { semaphore.release(); }
        })
      );

      for (const { toolCall, result, retryMessages } of results) {
        if (result.ok) { successfulToolCalls++; consecutiveToolErrors = 0; }
        else { consecutiveToolErrors++; }

        // Update working memory
        memory.updateFromToolResult(toolCall.toolName, toolCall.input, result);

        opts.onActivity?.(`${toolCall.toolName}: ${result.ok ? "done" : "failed"}`);
        messages.push({
          role: "user",
          content: `RESULT(${toolCall.toolName}):${smartTruncateResult(toolCall.toolName, result)}`,
        });
        messages.push(...retryMessages);
      }
    }

    // ── LLM-driven phase transitions ──
    const phaseBudget = PHASE_BUDGETS[currentPhase];
    const phaseStepsUsed = phaseStepCounts[currentPhase];

    // Check if LLM signaled a phase transition
    const detectedPhase = detectPhaseFromResponse(responseText);
    if (detectedPhase && phaseAllowed(currentPhase, detectedPhase)) {
      logInfo(`LLM signaled transition: ${currentPhase} → ${detectedPhase}`);
      currentPhase = detectedPhase;
      phaseStepCounts[currentPhase] = 0;
    }
    // Budget exhausted → force transition
    else if (phaseStepsUsed >= phaseBudget && currentPhase !== "respond") {
      const nextPhase = currentPhase === "explore" ? "diagnose" : "respond";
      logInfo(`Phase budget exhausted: ${currentPhase} → ${nextPhase} (used ${phaseStepsUsed}/${phaseBudget})`);

      messages.push({
        role: "system",
        content: buildPhaseTransitionMessage(currentPhase, nextPhase, memory),
      });
      currentPhase = nextPhase;
      phaseStepCounts[currentPhase] = 0;
    }

    if (consecutiveToolErrors >= 6) {
      const msg = "Stopping: too many consecutive errors. Try a different approach.";
      opts.onFinalToken?.(msg);
      return msg;
    }
  }

  logInfo(`Agent loop ended after ${MAX_STEPS} steps. Successful: ${successfulToolCalls}`);
  const final = `I stopped after ${MAX_STEPS} steps. Working memory:\n\n${memory.toSummary()}\n\nAsk me to continue if you want me to keep going.`;
  opts.onFinalToken?.(final);
  return final;
}

function phaseAllowed(from: AgentPhase, to: AgentPhase): boolean {
  const order: AgentPhase[] = ["explore", "diagnose", "respond"];
  return order.indexOf(to) > order.indexOf(from);
}

function buildPhaseTransitionMessage(from: AgentPhase, to: AgentPhase, memory: WorkingMemory): string {
  const summary = memory.toSummary();
  if (to === "diagnose") {
    return [
      `You have completed the EXPLORE phase (${memory.getToolCallCount()} tool calls).`,
      `\nYOUR WORKING MEMORY:\n${summary}`,
      `\nNow DIAGNOSE: Based on what you've read, what is the root cause? What needs to change?`,
      "Form a clear hypothesis before moving on.",
    ].join("\n");
  }
  if (to === "respond") {
    return [
      `You have completed the DIAGNOSE phase.`,
      `\nYOUR WORKING MEMORY:\n${summary}`,
      `\nNow RESPOND: Write your final analysis with the fix. Reference specific files, line numbers, and code.`,
      "Do NOT call any more tools. Just write your answer.",
    ].join("\n");
  }
  return "";
}

async function executeSingleTool(
  toolCall: StructuredToolCall,
  opts: AgentLoopOptions,
): Promise<{ toolCall: StructuredToolCall; result: ToolResult; retryMessages: ChatMessage[] }> {
  opts.onActivity?.(`Tool: ${toolCall.toolName}`);

  // Lazy-load environment context
  const env = opts.environment || await getEnvironmentContext().catch(() => undefined);

  const validationError = validateToolInput(toolCall.toolName, toolCall.input);
  if (validationError) {
    return { toolCall, result: { ok: false, error: validationError }, retryMessages: [] };
  }

  logInfo(`Executing: ${toolCall.toolName}(${JSON.stringify(toolCall.input).slice(0, 200)})`);
  let result = await executeTool(toolCall.toolName, toolCall.input, {
    extensionContext: opts.extensionContext,
    signal: opts.signal,
    postActivity: opts.onActivity,
    requestApproval: opts.requestApproval,
  });

  let retryCount = 0;
  const retryMessages: ChatMessage[] = [];
  while (!result.ok && retryCount < MAX_TOOL_ERROR_RETRIES) {
    retryCount++;
    retryMessages.push({ role: "user", content: buildRetryFeedback(toolCall.toolName, toolCall.input, result, retryCount, env) });

    const retryResult = await streamChat({
      apiKey: opts.apiKey, model: opts.model, apiUrl: opts.apiUrl,
      system: opts.system, messages: retryMessages,
      signal: opts.signal, onToken: () => {},
    });

    if (retryResult.toolCalls.length === 0) break;

    const retryCall = retryResult.toolCalls[0];
    let retryInput = retryCall.input;
    if (typeof retryInput === "string") { try { retryInput = JSON.parse(retryInput); } catch {} }
    if (!retryInput || typeof retryInput !== "object") retryInput = {};
    retryMessages.push({ role: "assistant", content: JSON.stringify({ type: "tool_call", tool: retryCall.toolName, input: retryInput }) });

    result = await executeTool(retryCall.toolName, retryInput as Record<string, unknown>, {
      extensionContext: opts.extensionContext,
      signal: opts.signal,
      postActivity: opts.onActivity,
      requestApproval: opts.requestApproval,
    });

    toolCall.toolName = retryCall.toolName;
    toolCall.input = retryInput as Record<string, unknown>;
  }

  return { toolCall, result, retryMessages };
}

function buildToolProtocol(): string {
  const toolNames = getToolNames().join(", ");
  return [
    "━━━ TOOL CALLING FORMAT ━━━",
    "Output ONLY a JSON object when using a tool:",
    '{"type":"tool_call","tool":"readFile","input":{"path":"src/index.ts"}}',
    '{"type":"tool_call","tool":"searchWorkspace","input":{"query":"export function"}}',
    "",
    "For edits use SEARCH/REPLACE:",
    '{"type":"tool_call","tool":"applyPatch","input":{"path":"file.ts","patch":"<<<<<<< SEARCH\\nold\\n=======\\nnew\\n>>>>>>> REPLACE"}}',
    "",
    "For LSP tools (more accurate than search for symbols):",
    '{"type":"tool_call","tool":"findReferences","input":{"symbol":"handleUpload","file":"src/upload.ts"}}',
    '{"type":"tool_call","tool":"goToDefinition","input":{"symbol":"parseCSV","file":"src/import.ts","line":78}}',
    '{"type":"tool_call","tool":"getDocumentSymbols","input":{"file":"src/components/App.tsx"}}',
    "",
    `Available tools: ${toolNames}`,
    "",
    "IMPORTANT RULES:",
    "1. Output ONLY valid JSON. No markdown fences, no explanation before or after.",
    "2. Each tool call is ONE JSON object on its own line. Output multiple tool calls as separate lines.",
    "3. Use tools to inspect files. Never guess file contents.",
    "4. For edits: readFile first, then applyPatch with SEARCH/REPLACE.",
    "5. For symbol lookup: prefer findReferences/goToDefinition over searchWorkspace.",
    "6. After enough exploration, write your analysis. Don't keep searching forever.",
    "7. NEVER repeat the same tool call with identical parameters.",
    "8. Reference specific files and line numbers in your answer.",
    "9. For git operations: ALWAYS use gitLog, gitStatus, gitDiff tools. Do NOT use runCommand for git.",
    "10. If your edit broke something, use undoEdit to revert it.",
  ].join("\n");
}

function buildRetryFeedback(toolName: string, args: Record<string, unknown>, result: ToolResult, retryCount: number, env?: EnvironmentContext): string {
  const errorDetail = result.error ?? "Unknown error";
  const envContext = env ? buildEnvironmentErrorContext(env, toolName, errorDetail) : "";

  if (toolName === "applyPatch" && (errorDetail.includes("not found") || errorDetail.includes("SEARCH text not found"))) {
    return `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}\nRead the file again with readFile. Use EXACT text from the file as the SEARCH block.${envContext ? "\n" + envContext : ""}`;
  }
  if (toolName === "readFile") {
    return `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}\nCheck the path. Use listFiles to discover files.${envContext ? "\n" + envContext : ""}`;
  }
  if (toolName === "runCommand") {
    return `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}${envContext ? "\n" + envContext : "\nUse the correct shell for your platform."}`;
  }
  return `Tool ${toolName} failed (attempt ${retryCount}): ${errorDetail}.${envContext ? "\n" + envContext : ""} Fix and retry.`;
}

function looksLikeUnverifiedWorkspaceSuccess(text: string): boolean {
  const n = stripToolCallsFromText(text).toLowerCase();
  return /\b(created|wrote|updated|modified|fixed|ran|applied)\b/.test(n) &&
    /\b(i have|i've|successfully|done|completed)\b/.test(n);
}
