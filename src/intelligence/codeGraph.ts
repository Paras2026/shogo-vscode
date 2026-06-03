import * as path from "path";
import * as vscode from "vscode";

// ── Types ──

export interface GraphNode {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: "function" | "method" | "class" | "export";
}

export interface GraphEdge {
  from: string;
  to: string;
  line: number;
}

export interface CallGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  callers: Map<string, GraphEdge[]>;   // nodeId → edges where this node is the target
  callees: Map<string, GraphEdge[]>;   // nodeId → edges where this node is the source
  fileIndex: Map<string, string[]>;    // file → nodeIds
}

// ── Symbol extraction (regex-based, fast) ──

const FUNC_DEF_PATTERNS = [
  // JS/TS function declarations
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
  // JS/TS arrow/const functions
  /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>|async\s*\(|function)/gm,
  // JS/TS class methods (inside class body)
  /^\s+(?:async\s+)?(\w+)\s*\(/gm,
  // Python
  /^(?:def|async\s+def)\s+(\w+)\s*\(/gm,
  // Go
  /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm,
  // Rust
  /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
  // Java/C#
  /^(?:public|private|protected|static|async|override|\s)*[\w<>\[\]]+\s+(\w+)\s*\(/gm,
];

const CALL_PATTERN = /\b([a-zA-Z_]\w*)\s*\(/g;

const SKIP_WORDS = new Set([
  "if", "else", "for", "while", "switch", "case", "return", "throw",
  "catch", "finally", "new", "typeof", "instanceof", "in", "of",
  "let", "const", "var", "class", "extends", "implements", "import",
  "export", "from", "default", "function", "async", "await", "yield",
  "this", "super", "self", "console", "Math", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Map", "Set", "RegExp",
  "Date", "Error", "Symbol", "parseInt", "parseFloat", "isNaN",
  "acquireVsCodeApi", "require", "module", "exports",
]);

function extractDefinitions(content: string, file: string): GraphNode[] {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    for (const pattern of FUNC_DEF_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(line)) !== null) {
        const name = match[1];
        if (!name || SKIP_WORDS.has(name) || name.length < 2) continue;
        const id = `${file}::${name}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const kind = line.includes("class ") ? "class"
          : line.includes("function ") || line.includes("=>") || line.includes("fn ") || line.includes("def ") ? "function"
          : "method";

        nodes.push({ id, name, file, line: lineNum + 1, kind });
      }
    }
  }

  return nodes;
}

function extractCalls(content: string, file: string, knownFunctions: Set<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const lines = content.split(/\r?\n/);

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;

    let match;
    const regex = new RegExp(CALL_PATTERN.source, CALL_PATTERN.flags);
    while ((match = regex.exec(line)) !== null) {
      const name = match[1];
      if (SKIP_WORDS.has(name) || name.length < 2) continue;

      for (const known of knownFunctions) {
        if (known === name) {
          edges.push({ from: `${file}::unknown`, to: `*::${name}`, line: lineNum + 1 });
          break;
        }
      }
    }
  }

  return edges;
}

// ── Graph builder ──

export async function buildCallGraph(pattern?: string): Promise<CallGraph> {
  const glob = pattern || "**/*.{ts,tsx,js,jsx,py,go,rs,java}";
  const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**}";

  const uris = await vscode.workspace.findFiles(glob, exclude, 500);

  const allNodes: GraphNode[] = [];
  const fileFuncs = new Map<string, Set<string>>();

  // Phase 1: Extract all function/class definitions
  for (const uri of uris) {
    const rel = asRelative(uri);
    if (isBinary(rel)) continue;

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const nodes = extractDefinitions(text, rel);
      allNodes.push(...nodes);

      const funcNames = new Set<string>();
      for (const n of nodes) funcNames.add(n.name);
      fileFuncs.set(rel, funcNames);
    } catch {
      continue;
    }
  }

  // Phase 2: Extract all calls
  const allEdges: GraphEdge[] = [];
  const globalFuncNames = new Set<string>();
  for (const names of fileFuncs.values()) {
    for (const n of names) globalFuncNames.add(n);
  }

  for (const uri of uris) {
    const rel = asRelative(uri);
    if (isBinary(rel)) continue;

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const fileFuncsHere = fileFuncs.get(rel) || new Set();

      const lines = text.split(/\r?\n/);
      let currentFunc = "unknown";

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];

        // Track which function we're inside
        for (const node of allNodes) {
          if (node.file === rel && node.line === lineNum + 1) {
            currentFunc = node.name;
            break;
          }
        }

        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;

        let match;
        const regex = new RegExp(CALL_PATTERN.source, CALL_PATTERN.flags);
        while ((match = regex.exec(line)) !== null) {
          const name = match[1];
          if (SKIP_WORDS.has(name) || name.length < 2) continue;
          if (fileFuncsHere.has(name)) {
            allEdges.push({
              from: `${rel}::${currentFunc}`,
              to: `${rel}::${name}`,
              line: lineNum + 1,
            });
          } else if (globalFuncNames.has(name)) {
            allEdges.push({
              from: `${rel}::${currentFunc}`,
              to: `*::${name}`,
              line: lineNum + 1,
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Phase 3: Resolve cross-file edges
  for (const edge of allEdges) {
    if (edge.to.startsWith("*::")) {
      const targetName = edge.to.slice(2);
      for (const node of allNodes) {
        if (node.name === targetName && node.file !== edge.from.split("::")[0]) {
          edge.to = node.id;
          break;
        }
      }
      if (edge.to.startsWith("*::")) {
        edge.to = edge.to.replace("*::", "external::");
      }
    }
  }

  // Phase 4: Build index structures
  const nodes = new Map<string, GraphNode>();
  for (const n of allNodes) nodes.set(n.id, n);

  const callers = new Map<string, GraphEdge[]>();
  const callees = new Map<string, GraphEdge[]>();
  const fileIndex = new Map<string, string[]>();

  for (const n of allNodes) {
    if (!fileIndex.has(n.file)) fileIndex.set(n.file, []);
    fileIndex.get(n.file)!.push(n.id);
  }

  for (const edge of allEdges) {
    if (!callers.has(edge.to)) callers.set(edge.to, []);
    callers.get(edge.to)!.push(edge);
    if (!callees.has(edge.from)) callees.set(edge.from, []);
    callees.get(edge.from)!.push(edge);
  }

  return { nodes, edges: allEdges, callers, callees, fileIndex };
}

// ── Impact analysis ──

export function findImpact(graph: CallGraph, functionName: string, maxDepth: number = 5): ImpactResult[] {
  const results: ImpactResult[] = [];
  const visited = new Set<string>();

  const targetIds = findNodeIds(graph, functionName);

  for (const targetId of targetIds) {
    walkUp(graph, targetId, 0, maxDepth, visited, results);
  }

  return results;
}

export interface ImpactResult {
  nodeId: string;
  name: string;
  file: string;
  line: number;
  depth: number;
}

function walkUp(graph: CallGraph, nodeId: string, depth: number, maxDepth: number, visited: Set<string>, results: ImpactResult[]) {
  if (depth > maxDepth || visited.has(nodeId)) return;
  visited.add(nodeId);

  const edges = graph.callers.get(nodeId) || [];
  for (const edge of edges) {
    const callerNode = graph.nodes.get(edge.from);
    if (!callerNode) continue;
    results.push({ nodeId: edge.from, name: callerNode.name, file: callerNode.file, line: callerNode.line, depth: depth + 1 });
    walkUp(graph, edge.from, depth + 1, maxDepth, visited, results);
  }
}

// ── Dead code detection ──

export interface DeadCodeResult {
  nodeId: string;
  name: string;
  file: string;
  line: number;
  reason: string;
}

export function findDeadCode(graph: CallGraph): DeadCodeResult[] {
  const results: DeadCodeResult[] = [];

  for (const [nodeId, node] of graph.nodes) {
    if (node.kind === "class") continue;

    const callerEdges = graph.callers.get(nodeId) || [];

    if (callerEdges.length === 0) {
      const isExported = node.name.startsWith("default") ||
        (graph.edges.some((e) => e.from.includes("::") && e.to === nodeId));
      const isMain = node.name === "main" || node.name === "activate";
      const isHandler = node.name.startsWith("on") && node.name.length > 2;

      let reason = "No callers found";
      if (isExported) reason = "Exported but not called internally";
      if (isMain) reason = "Entry point (may be called by framework)";
      if (isHandler) reason = "Event handler (may be called by framework)";

      results.push({ nodeId, name: node.name, file: node.file, line: node.line, reason });
    }
  }

  return results;
}

// ── Call chain explorer ──

export interface CallChain {
  steps: Array<{ name: string; file: string; line: number }>;
}

export function findCallChains(graph: CallGraph, fromFunction: string, toFunction: string, maxDepth: number = 6): CallChain[] {
  const chains: CallChain[] = [];
  const sourceIds = findNodeIds(graph, fromFunction);
  const targetIds = new Set(findNodeIds(graph, toFunction).map((n) => n.name));

  for (const sourceId of sourceIds) {
    const sourceNode = graph.nodes.get(sourceId);
    if (!sourceNode) continue;
    walkDown(graph, sourceId, targetIds, [{ name: sourceNode.name, file: sourceNode.file, line: sourceNode.line }], maxDepth, new Set(), chains);
  }

  return chains;
}

function walkDown(graph: CallGraph, nodeId: string, targetNames: Set<string>, path: Array<{ name: string; file: string; line: number }>, maxDepth: number, visited: Set<string>, chains: CallChain[]) {
  if (path.length > maxDepth || visited.has(nodeId)) return;
  visited.add(nodeId);

  const edges = graph.callees.get(nodeId) || [];
  for (const edge of edges) {
    const calleeNode = graph.nodes.get(edge.to);
    if (!calleeNode) continue;

    const step = { name: calleeNode.name, file: calleeNode.file, line: calleeNode.line };
    const newPath = [...path, step];

    if (targetNames.has(calleeNode.name)) {
      chains.push({ steps: newPath });
    }

    walkDown(graph, edge.to, targetNames, newPath, maxDepth, new Set(visited), chains);
  }
}

// ── Helpers ──

function findNodeIds(graph: CallGraph, name: string): string[] {
  const ids: string[] = [];
  for (const [id, node] of graph.nodes) {
    if (node.name === name) ids.push(id);
  }
  if (ids.length === 0) {
    for (const [id, node] of graph.nodes) {
      if (node.name.toLowerCase() === name.toLowerCase()) ids.push(id);
    }
  }
  return ids;
}

function asRelative(uri: vscode.Uri): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return uri.fsPath;
  return uri.fsPath.slice(ws.uri.fsPath.length + 1).replace(/\\/g, "/");
}

function isBinary(filePath: string): boolean {
  const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".map", ".lock"]);
  const ext = path.posix.extname(filePath).toLowerCase();
  return binaryExts.has(ext);
}
