import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import {
  buildCallGraph,
  findImpact,
  findDeadCode,
  findCallChains,
  type CallGraph,
} from "../intelligence/codeGraph";

let cachedGraph: CallGraph | null = null;
let lastBuildTime = 0;
const CACHE_TTL_MS = 30_000;

async function getGraph(pattern?: string): Promise<CallGraph> {
  const now = Date.now();
  if (cachedGraph && now - lastBuildTime < CACHE_TTL_MS) {
    return cachedGraph;
  }
  cachedGraph = await buildCallGraph(pattern);
  lastBuildTime = now;
  return cachedGraph;
}

function formatSummary(graph: CallGraph): string {
  const files = graph.fileIndex.size;
  const funcs = Array.from(graph.nodes.values()).filter((n) => n.kind !== "class").length;
  const classes = Array.from(graph.nodes.values()).filter((n) => n.kind === "class").length;
  const edges = graph.edges.length;

  const byFile = Array.from(graph.fileIndex.entries())
    .map(([file, nodeIds]) => {
      const names = nodeIds
        .map((id) => graph.nodes.get(id)!)
        .map((n) => n.name)
        .join(", ");
      return `  ${file} — ${names}`;
    })
    .join("\n");

  return [
    `Call Graph: ${files} files, ${funcs} functions, ${classes} classes, ${edges} call edges`,
    "",
    byFile,
  ].join("\n");
}

// ── Tool: buildCallGraph ──

export const buildCallGraphTool: ToolDefinition = {
  name: "buildCallGraph",
  description:
    "Build a call graph of the entire codebase. Shows which functions call which other functions. " +
    "Run this FIRST before impactAnalysis, deadCode, or callChain. The graph is cached for 30 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Optional glob to filter files. Default: all source files. Example: "src/**/*.ts"',
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
    const graph = await getGraph(pattern);
    return { ok: true, data: { summary: formatSummary(graph), nodes: graph.nodes.size, edges: graph.edges.length } };
  },
};

// ── Tool: impactAnalysis ──

export const impactAnalysisTool: ToolDefinition = {
  name: "impactAnalysis",
  description:
    "Find what would break if you change a function. Walks the call graph backwards to find all callers. " +
    "Shows direct and indirect dependents up to N levels deep. Use before making risky changes.",
  inputSchema: {
    type: "object",
    required: ["function"],
    properties: {
      function: {
        type: "string",
        description: "Function name to analyze impact for",
      },
      depth: {
        type: "number",
        description: "Max depth to traverse (default 4)",
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.function !== "string") {
      return { ok: false, error: "function must be a string" };
    }
    const graph = await getGraph();
    const depth = typeof input.depth === "number" ? input.depth : 4;
    const impacts = findImpact(graph, input.function, depth);

    if (impacts.length === 0) {
      return {
        ok: true,
        data: {
          function: input.function,
          impact: "NONE — no callers found. This function may be dead code or called externally.",
          dependents: [],
        },
      };
    }

    const byDepth = new Map<number, typeof impacts>();
    for (const impact of impacts) {
      const d = impact.depth;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(impact);
    }

    const lines: string[] = [`Impact of changing "${input.function}":`, ""];
    let totalFiles = new Set<string>();

    for (const [d, items] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
      const label = d === 1 ? "Direct callers" : `Indirect (${d} levels up)`;
      lines.push(`${label}:`);
      for (const item of items) {
        lines.push(`  → ${item.name}() in ${item.file} (line ${item.line})`);
        totalFiles.add(item.file);
      }
      lines.push("");
    }

    lines.push(`Total: ${impacts.length} functions across ${totalFiles.size} files`);
    lines.push(`Risk: ${impacts.length > 10 ? "HIGH" : impacts.length > 3 ? "MEDIUM" : "LOW"}`);

    return {
      ok: true,
      data: {
        function: input.function,
        totalDependents: impacts.length,
        affectedFiles: totalFiles.size,
        risk: impacts.length > 10 ? "HIGH" : impacts.length > 3 ? "MEDIUM" : "LOW",
        details: lines.join("\n"),
        dependents: impacts,
      },
    };
  },
};

// ── Tool: deadCode ──

export const deadCodeTool: ToolDefinition = {
  name: "deadCode",
  description:
    "Find functions that are never called by anything else in the codebase. " +
    "Identifies cruft, unused utilities, and stale code that can be safely removed.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    const graph = await getGraph();
    const dead = findDeadCode(graph);

    if (dead.length === 0) {
      return { ok: true, data: { message: "No dead code found. All functions have callers.", functions: [] } };
    }

    const lines: string[] = [`Dead code found (${dead.length} functions):`, ""];
    let currentFile = "";

    for (const item of dead) {
      if (item.file !== currentFile) {
        currentFile = item.file;
        lines.push(`  ${currentFile}`);
      }
      lines.push(`    ${item.name}() (line ${item.line}) — ${item.reason}`);
    }

    return {
      ok: true,
      data: {
        totalDead: dead.length,
        details: lines.join("\n"),
        functions: dead,
      },
    };
  },
};

// ── Tool: callChain ──

export const callChainTool: ToolDefinition = {
  name: "callChain",
  description:
    "Trace the call chain from one function to another. Shows the path the execution takes. " +
    "Example: trace from 'handlePrompt' to 'readFile' to see the full request flow.",
  inputSchema: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "Starting function name" },
      to: { type: "string", description: "Target function name" },
      maxDepth: { type: "number", description: "Max chain depth (default 6)" },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.from !== "string" || typeof input.to !== "string") {
      return { ok: false, error: "from and to must be strings" };
    }
    const graph = await getGraph();
    const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : 6;
    const chains = findCallChains(graph, input.from, input.to, maxDepth);

    if (chains.length === 0) {
      return {
        ok: true,
        data: {
          from: input.from,
          to: input.to,
          message: `No call chain found from "${input.from}" to "${input.to}". They may not be connected.`,
          chains: [],
        },
      };
    }

    const lines: string[] = [`Call chains from "${input.from}" to "${input.to}" (${chains.length} found):`, ""];

    for (let i = 0; i < Math.min(chains.length, 5); i++) {
      const chain = chains[i];
      lines.push(`Chain ${i + 1}:`);
      for (let j = 0; j < chain.steps.length; j++) {
        const step = chain.steps[j];
        const arrow = j < chain.steps.length - 1 ? "  →" : "  ✓";
        lines.push(`${arrow} ${step.name}() ${step.file}:${step.line}`);
      }
      lines.push("");
    }

    return {
      ok: true,
      data: {
        from: input.from,
        to: input.to,
        totalChains: chains.length,
        details: lines.join("\n"),
        chains: chains.slice(0, 5),
      },
    };
  },
};
