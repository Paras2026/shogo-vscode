/**
 * Working Memory — a compact, structured summary of everything the agent has
 * learned during the current task. Replaces 30 raw tool results with a ~3000
 * char summary that the LLM can actually reason over.
 */

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

export interface WorkingMemoryData {
  issue: string;
  filesRead: FileSummary[];
  searches: SearchResult[];
  toolCallsUsed: number;
  findings: string[];
  hypothesis: string;
}

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

  /**
   * Update working memory after a tool call returns.
   * This is called by the agent loop after each successful tool execution.
   */
  updateFromToolResult(toolName: string, input: Record<string, unknown>, result: unknown): void {
    this.data.toolCallsUsed++;

    if (toolName === "readFile" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const path = typeof data.path === "string" ? data.path : typeof input.path === "string" ? input.path : "";
        const totalLines = typeof data.totalLines === "number" ? data.totalLines : 0;
        const content = typeof data.content === "string" ? data.content : "";

        // Extract key exports/symbols from content
        const keyExports = extractKeySymbols(content);

        this.data.filesRead.push({
          path,
          lines: totalLines,
          keyExports,
          summary: summarizeFileContent(path, content, totalLines),
        });
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
            const path = typeof match.path === "string" ? match.path : "";
            const line = typeof match.line === "number" ? match.line : 0;
            const text = typeof match.text === "string" ? match.text : "";
            return `${path}:${line} — ${text}`;
          }
          return String(m);
        });

        this.data.searches.push({
          query,
          matchCount: matches.length,
          topMatches,
        });
      }
    }

    if (toolName === "runCommand" && typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      if (r.ok) {
        const data = r.data as Record<string, unknown> | undefined;
        if (data) {
          const cmd = typeof data.command === "string" ? data.command : "";
          const stdout = typeof data.stdout === "string" ? data.stdout : "";
          this.data.findings.push(`Command "${cmd}" succeeded. Output: ${stdout.slice(0, 200)}`);
        }
      }
    }

    if (toolName === "findReferences") {
      const r = result as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      if (data) {
        const count = typeof data.referenceCount === "number" ? data.referenceCount : 0;
        const symbol = typeof data.symbol === "string" ? data.symbol : "";
        this.data.findings.push(`${symbol} has ${count} references`);
      }
    }

    if (toolName === "goToDefinition") {
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
        this.data.findings.push(`${symbol} defined at: ${defs.join(", ")}`);
      }
    }
  }

  addFinding(finding: string): void {
    this.data.findings.push(finding);
  }

  setHypothesis(h: string): void {
    this.data.hypothesis = h;
  }

  getToolCallCount(): number {
    return this.data.toolCallsUsed;
  }

  /**
   * Serialize to a compact ~3000 char summary for injection into the LLM context.
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

    if (this.data.findings.length > 0) {
      parts.push(`\nFINDINGS:`);
      for (const f of this.data.findings) {
        parts.push(`  - ${f}`);
      }
    }

    if (this.data.hypothesis) {
      parts.push(`\nHYPOTHESIS: ${this.data.hypothesis}`);
    }

    return parts.join("\n");
  }
}

// ── Helpers ──

function extractKeySymbols(content: string): string[] {
  const symbols: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match export function/class/const/type/interface patterns
    const exportMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+(\w+)/);
    if (exportMatch) {
      symbols.push(exportMatch[1]);
    }
  }
  return symbols.slice(0, 15);
}

function summarizeFileContent(path: string, content: string, totalLines: number): string {
  const ext = path.split(".").pop() || "";
  const lines = content.split("\n");
  const imports = lines.filter((l) => l.trim().startsWith("import ")).length;
  const exports = lines.filter((l) => l.trim().startsWith("export ")).length;

  return `${totalLines} lines, ${imports} imports, ${exports} exports`;
}
