import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import { asRelative, assertSafeRelativePath, getWorkspaceRoot, isLikelyTextFile, truncateText } from "./workspace";

const FlexSearch = require("flexsearch") as {
  Index: new (options?: Record<string, unknown>) => {
    add(id: number, text: string): void;
    search(query: string, options?: Record<string, unknown>): number[];
  };
};

const DEFAULT_EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/*.vsix}";
const MAX_INDEX_FILES = 2000;
const MAX_FILE_CHARS = 120000;
const MAX_CHUNK_CHARS = 6000;

interface IndexedChunk {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
  symbol?: string;
  text: string;
}

let index = new FlexSearch.Index({ tokenize: "forward", cache: true });
let chunks: IndexedChunk[] = [];
let indexedAt = 0;

export const indexWorkspaceTool: ToolDefinition = {
  name: "indexWorkspace",
  description: "Build or rebuild a local lexical code index for faster Cursor-like project search.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Optional glob, default **/*" },
      maxFiles: { type: "number", description: "Maximum files to index, default 2000" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    const maxFiles = typeof input.maxFiles === "number" ? Math.min(Math.max(input.maxFiles, 1), MAX_INDEX_FILES) : MAX_INDEX_FILES;
    const files = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, maxFiles);

    index = new FlexSearch.Index({ tokenize: "forward", cache: true });
    chunks = [];
    let nextId = 1;

    for (const uri of files) {
      const rel = asRelative(uri);
      if (!isLikelyTextFile(rel)) {
        continue;
      }
      try {
        assertSafeRelativePath(rel);
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        if (!text.trim()) {
          continue;
        }
        for (const chunk of chunkFile(rel, truncateText(text, MAX_FILE_CHARS), nextId)) {
          chunks.push(chunk);
          index.add(chunk.id, `${chunk.path}\n${chunk.kind}\n${chunk.symbol ?? ""}\n${chunk.text}`);
          nextId = chunk.id + 1;
        }
      } catch {
        continue;
      }
    }

    indexedAt = Date.now();
    await persistIndexSnapshot();
    return { ok: true, data: { indexedAt, filesScanned: files.length, chunks: chunks.length } };
  },
};

export const searchIndexTool: ToolDefinition = {
  name: "searchIndex",
  description: "Search the local lexical code index. Call indexWorkspace first if the index is empty or stale.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Maximum results, default 20" },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.query !== "string" || !input.query.trim()) {
      return { ok: false, error: "query must be a non-empty string" };
    }
    if (chunks.length === 0) {
      const snapshotLoaded = await loadIndexSnapshot();
      if (!snapshotLoaded) {
        return { ok: false, error: "Index is empty. Call indexWorkspace first." };
      }
    }

    const limit = typeof input.limit === "number" ? Math.min(Math.max(input.limit, 1), 100) : 20;
    const ids = index.search(input.query, { limit });
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const matches = ids
      .map((id) => byId.get(id))
      .filter((chunk): chunk is IndexedChunk => !!chunk)
      .map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        kind: chunk.kind,
        symbol: chunk.symbol,
        preview: truncateText(chunk.text.replace(/\s+/g, " ").trim(), 500),
      }));

    return { ok: true, data: { query: input.query, indexedAt, matches } };
  },
};

function chunkFile(path: string, text: string, firstId: number): IndexedChunk[] {
  const lines = text.split(/\r?\n/);
  const symbolLines = findSymbolLines(lines);
  if (symbolLines.length === 0) {
    return chunkBySize(path, lines, firstId);
  }

  const result: IndexedChunk[] = [];
  for (let i = 0; i < symbolLines.length; i++) {
    const current = symbolLines[i];
    const next = symbolLines[i + 1];
    const start = current.line;
    const end = next ? Math.max(next.line - 1, start) : Math.min(lines.length, start + 160);
    const chunkText = lines.slice(start - 1, end).join("\n");
    result.push({
      id: firstId + result.length,
      path,
      startLine: start,
      endLine: end,
      kind: current.kind,
      symbol: current.symbol,
      text: truncateText(chunkText, MAX_CHUNK_CHARS),
    });
  }
  return result;
}

function findSymbolLines(lines: string[]): Array<{ line: number; kind: string; symbol: string }> {
  const symbols: Array<{ line: number; kind: string; symbol: string }> = [];
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "component", regex: /^\s*(?:export\s+)?(?:const|let)\s+([A-Z][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "declaration", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "python", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "python-class", regex: /^\s*class\s+([A-Za-z_][\w]*)/ },
  ];

  lines.forEach((line, idx) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match?.[1]) {
        symbols.push({ line: idx + 1, kind: pattern.kind, symbol: match[1] });
        break;
      }
    }
  });

  return symbols;
}

function chunkBySize(path: string, lines: string[], firstId: number): IndexedChunk[] {
  const result: IndexedChunk[] = [];
  for (let start = 0; start < lines.length; start += 120) {
    const slice = lines.slice(start, start + 160);
    result.push({
      id: firstId + result.length,
      path,
      startLine: start + 1,
      endLine: start + slice.length,
      kind: "chunk",
      text: truncateText(slice.join("\n"), MAX_CHUNK_CHARS),
    });
  }
  return result;
}

async function persistIndexSnapshot(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }
  const dir = vscode.Uri.joinPath(root.uri, ".shogo", "index");
  await vscode.workspace.fs.createDirectory(dir);
  const snapshot = { indexedAt, chunks };
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "chunks.json"), Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"));
}

async function loadIndexSnapshot(): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) {
    return false;
  }
  try {
    const uri = vscode.Uri.joinPath(root.uri, ".shogo", "index", "chunks.json");
    const snapshot = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8")) as { indexedAt?: number; chunks?: IndexedChunk[] };
    if (!Array.isArray(snapshot.chunks)) {
      return false;
    }
    index = new FlexSearch.Index({ tokenize: "forward", cache: true });
    chunks = snapshot.chunks;
    indexedAt = typeof snapshot.indexedAt === "number" ? snapshot.indexedAt : 0;
    for (const chunk of chunks) {
      index.add(chunk.id, `${chunk.path}\n${chunk.kind}\n${chunk.symbol ?? ""}\n${chunk.text}`);
    }
    return true;
  } catch {
    return false;
  }
}
