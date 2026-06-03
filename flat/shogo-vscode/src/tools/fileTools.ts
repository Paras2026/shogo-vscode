import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import {
  asRelative,
  assertSafeRelativePath,
  isLikelyTextFile,
  normalizeRelativePath,
  resolveWorkspacePath,
  truncateText,
} from "./workspace";

const DEFAULT_EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/*.vsix}";

export const listFilesTool: ToolDefinition = {
  name: "listFiles",
  description: "List workspace files, excluding build outputs and dependencies.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Optional glob, default **/*" },
      max: { type: "number", description: "Maximum files to return, default 100" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    const max = typeof input.max === "number" ? Math.min(Math.max(input.max, 1), 1000) : 100;
    const files = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, max);
    return { ok: true, data: { files: files.map(asRelative) } };
  },
};

export const readFileTool: ToolDefinition = {
  name: "readFile",
  description: "Read a text file from the workspace by relative path.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      maxChars: { type: "number", description: "Optional max chars, default 8000" },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }
    const rel = normalizeRelativePath(input.path);
    if (!isLikelyTextFile(rel)) {
      return { ok: false, error: "Refusing to read a likely binary or hidden file." };
    }
    const uri = resolveWorkspacePath(rel);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const maxChars = typeof input.maxChars === "number" ? input.maxChars : 8000;
    return { ok: true, data: { path: rel, content: truncateText(text, maxChars) } };
  },
};

export const searchWorkspaceTool: ToolDefinition = {
  name: "searchWorkspace",
  description: "Search text files in the workspace for a case-insensitive query.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Text to search for" },
      pattern: { type: "string", description: "Optional glob, default **/*" },
      maxFiles: { type: "number", description: "Max files to scan, default 200" },
      maxMatches: { type: "number", description: "Max matches to return, default 30" },
      regex: { type: "boolean", description: "Treat query as a JavaScript regular expression" },
      caseSensitive: { type: "boolean", description: "Use case-sensitive matching" },
      contextLines: { type: "number", description: "Include N lines before/after each match, default 0" },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.query !== "string" || !input.query.trim()) {
      return { ok: false, error: "query must be a non-empty string" };
    }
    const rawQuery = input.query.trim();
    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    const maxFiles = typeof input.maxFiles === "number" ? Math.min(Math.max(input.maxFiles, 1), 5000) : 200;
    const maxMatches = typeof input.maxMatches === "number" ? Math.min(Math.max(input.maxMatches, 1), 500) : 30;
    const contextLines = typeof input.contextLines === "number" ? Math.min(Math.max(input.contextLines, 0), 5) : 0;
    const caseSensitive = input.caseSensitive === true;
    const regex = input.regex === true ? new RegExp(rawQuery, caseSensitive ? "" : "i") : undefined;
    const literalQuery = caseSensitive ? rawQuery : rawQuery.toLowerCase();
    const files = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, maxFiles);
    const matches: Array<{ path: string; line: number; column: number; text: string; context?: string }> = [];

    for (const uri of files) {
      const rel = asRelative(uri);
      if (!isLikelyTextFile(rel)) {
        continue;
      }
      try {
        assertSafeRelativePath(rel);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const haystack = caseSensitive ? line : line.toLowerCase();
          const match = regex ? line.match(regex) : undefined;
          const column = regex ? match?.index ?? -1 : haystack.indexOf(literalQuery);
          if (column >= 0) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length, i + contextLines + 1);
            matches.push({
              path: rel,
              line: i + 1,
              column: column + 1,
              text: truncateText(line.trim(), 300),
              context: contextLines > 0 ? truncateText(lines.slice(start, end).join("\n"), 1000) : undefined,
            });
            if (matches.length >= maxMatches) {
              return { ok: true, data: { query: input.query, scannedFiles: files.length, matches } };
            }
          }
        }
      } catch {
        continue;
      }
    }

    return { ok: true, data: { query: input.query, scannedFiles: files.length, matches } };
  },
};
