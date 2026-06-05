/**
 * Working Memory V2 — intelligent, priority-ranked memory for the current task.
 *
 * Key improvements over V1:
 * - Priority ranking (high/medium/low) with selective forgetting
 * - Capacity limit (50 findings) with automatic pruning
 * - Only high+medium priority findings in summary output
 * - Tracks files read, searches, tool calls, findings, and hypothesis
 */

export type FindingPriority = "high" | "medium" | "low";

export interface FileSummary {
  path: string;
  lines: number;
  keyExports: string[];
  summary: string;
}

export interface SearchResult {
  query: string;
  matchCount: number;
  topMatches: string[];
}

export interface PrioritizedFinding {
  text: string;
  priority: FindingPriority;
  timestamp: number;
}

export interface WorkingMemoryData {
  issue: string;
  filesRead: FileSummary[];
  searches: SearchResult[];
  toolCallsUsed: number;
  findings: PrioritizedFinding[];
  hypothesis: string;
}

const MAX_FINDINGS = 50;

export class WorkingMemory {
  private data: WorkingMemoryData;

  constructor(issue: string) {
    this.data = {
      issue,
      filesRead: [],
      searches: [],
      toolCallsUsed: 0,
      findings: [],
      hypothesis: "",
    };
  }

  updateFromToolResult(toolName: string, input: Record<string, unknown>, result: unknown): void {
    this.data.toolCallsUsed++;

    if (toolName === "readFile" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const filePath = typeof data.path === "string" ? data.path : typeof input.path === "string" ? input.path : "";
        const totalLines = typeof data.totalLines === "number" ? data.totalLines : 0;
        const content = typeof data.content === "string" ? data.content : "";
        const keyExports = extractKeySymbols(content);

        this.data.filesRead.push({
          path: filePath,
          lines: totalLines,
          keyExports,
          summary: summarizeFileContent(filePath, content, totalLines),
        });

        // High priority: reading the main file the user is asking about
        const isMainFile = this.data.filesRead.length <= 2;
        this.addFinding(`Read ${filePath} (${totalLines} lines)`, isMainFile ? "high" : "medium");
      }
    }

    if (toolName === "searchWorkspace" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const query = typeof data.query === "string" ? data.query : "";
        const matches = Array.isArray(data.matches) ? data.matches : [];
        const topMatches = matches.slice(0, 10).map((m: unknown) => {
          if (typeof m === "object" && m !== null) {
            const match = m as Record<string, unknown>;
            const filePath = typeof match.path === "string" ? match.path : "";
            const line = typeof match.line === "number" ? match.line : 0;
            const text = typeof match.text === "string" ? match.text : "";
            return `${filePath}:${line} — ${text}`;
          }
          return String(m);
        });

        this.data.searches.push({ query, matchCount: matches.length, topMatches });
        this.addFinding(`Search "${query}" found ${matches.length} matches`, "medium");
      }
    }

    if (toolName === "runCommand" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const ok = r.ok as boolean | undefined;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const cmd = typeof data.command === "string" ? data.command : "";
        const stdout = typeof data.stdout === "string" ? data.stdout : "";
        const exitCode = typeof data.exitCode === "number" ? data.exitCode : 0;
        const priority: FindingPriority = ok ? "medium" : "high";
        this.addFinding(
          ok
            ? `Command "${cmd}" succeeded: ${stdout.slice(0, 150)}`
            : `Command "${cmd}" failed (exit ${exitCode}): ${stdout.slice(0, 150)}`,
          priority,
        );
      }
    }

    if (toolName === "findReferences" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const count = typeof data.referenceCount === "number" ? data.referenceCount : 0;
        const symbol = typeof data.symbol === "string" ? data.symbol : "";
        this.addFinding(`${symbol} has ${count} references`, count > 5 ? "high" : "medium");
      }
    }

    if (toolName === "goToDefinition" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data && Array.isArray(data.definitions)) {
        const symbol = typeof data.symbol === "string" ? data.symbol : "";
        const defs = data.definitions.map((d: unknown) => {
          if (typeof d === "object" && d !== null) {
            const def = d as Record<string, unknown>;
            return `${typeof def.file === "string" ? def.file : "?"}:${typeof def.startLine === "number" ? def.startLine : "?"}`;
          }
          return String(d);
        });
        this.addFinding(`${symbol} defined at: ${defs.join(", ")}`, "high");
      }
    }

    // Auto-prune if over capacity
    this.pruneFindings();
  }

  addFinding(text: string, priority: FindingPriority = "medium"): void {
    this.data.findings.push({
      text,
      priority,
      timestamp: Date.now(),
    });
    this.pruneFindings();
  }

  setHypothesis(h: string): void {
    this.data.hypothesis = h;
  }

  getToolCallCount(): number {
    return this.data.toolCallsUsed;
  }

  /**
   * Serialize to a compact summary for injection into the LLM context.
   * Only includes high and medium priority findings.
   */
  toSummary(): string {
    const parts: string[] = [];

    parts.push(`TASK: ${this.data.issue}`);
    parts.push(`Tool calls used: ${this.data.toolCallsUsed}`);

    if (this.data.filesRead.length > 0) {
      parts.push(`\nFILES READ (${this.data.filesRead.length}):`);
      for (const f of this.data.filesRead) {
        parts.push(`  - ${f.path} (${f.lines} lines): ${f.summary}`);
        if (f.keyExports.length > 0) {
          parts.push(`    Key exports: ${f.keyExports.join(", ")}`);
        }
      }
    }

    if (this.data.searches.length > 0) {
      parts.push(`\nSEARCHES (${this.data.searches.length}):`);
      for (const s of this.data.searches) {
        parts.push(`  - "${s.query}" → ${s.matchCount} matches`);
        for (const m of s.topMatches.slice(0, 5)) {
          parts.push(`    ${m}`);
        }
      }
    }

    // Only high + medium priority findings
    const importantFindings = this.data.findings.filter((f) => f.priority !== "low");
    if (importantFindings.length > 0) {
      parts.push(`\nFINDINGS (${importantFindings.length}):`);
      for (const f of importantFindings.slice(-20)) {
        const icon = f.priority === "high" ? "🔴" : "🟡";
        parts.push(`  ${icon} ${f.text}`);
      }
    }

    if (this.data.hypothesis) {
      parts.push(`\nHYPOTHESIS: ${this.data.hypothesis}`);
    }

    return parts.join("\n");
  }

  /**
   * Prune findings when over capacity — remove oldest low-priority first.
   */
  private pruneFindings(): void {
    if (this.data.findings.length <= MAX_FINDINGS) return;

    // Sort: keep high priority, then medium, then recent
    this.data.findings.sort((a, b) => {
      const priorityScore = (p: FindingPriority) => p === "high" ? 3 : p === "medium" ? 2 : 1;
      const scoreDiff = priorityScore(b.priority) - priorityScore(a.priority);
      if (scoreDiff !== 0) return scoreDiff;
      return b.timestamp - a.timestamp;
    });

    this.data.findings = this.data.findings.slice(0, MAX_FINDINGS);
  }
}

// ── Helpers ──

function extractKeySymbols(content: string): string[] {
  const symbols: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const exportMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+(\w+)/);
    if (exportMatch) {
      symbols.push(exportMatch[1]);
    }
  }
  return symbols.slice(0, 15);
}

function summarizeFileContent(path: string, content: string, totalLines: number): string {
  const lines = content.split("\n");
  const imports = lines.filter((l) => l.trim().startsWith("import ")).length;
  const exports = lines.filter((l) => l.trim().startsWith("export ")).length;
  return `${totalLines} lines, ${imports} imports, ${exports} exports`;
}
