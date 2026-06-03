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
  description:
    "Read a text file from the workspace. Supports line ranges for large files (startLine/endLine). Always returns line numbers. For files over 500 lines, use startLine/endLine to read only the section you need.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      startLine: {
        type: "number",
        description:
          "First line to read (1-based). Use with endLine for large files. Default: 1",
      },
      endLine: {
        type: "number",
        description:
          "Last line to read (1-based, inclusive). Default: 200 or end of file.",
      },
      maxChars: {
        type: "number",
        description: "Optional max chars, default 12000",
      },
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
    const fullText = Buffer.from(bytes).toString("utf8");
    const lines = fullText.split(/\r?\n/);
    const totalLines = lines.length;

    const startLine =
      typeof input.startLine === "number" && input.startLine >= 1
        ? Math.floor(input.startLine)
        : 1;
    const endLine =
      typeof input.endLine === "number" && input.endLine >= startLine
        ? Math.min(Math.floor(input.endLine), totalLines)
        : Math.min(startLine + 199, totalLines);

    const selectedLines = lines.slice(startLine - 1, endLine);
    const numbered = selectedLines
      .map((line, i) => `${startLine + i}|${line}`)
      .join("\n");

    const maxChars =
      typeof input.maxChars === "number" ? input.maxChars : 12000;
    const truncated = truncateText(numbered, maxChars);

    const meta: Record<string, string | number> = {
      path: rel,
      totalLines,
      startLine,
      endLine: Math.min(endLine, totalLines),
    };

    if (endLine < totalLines) {
      meta.hint = `Lines ${endLine + 1}-${totalLines} not shown. Use endLine to read more.`;
    }

    return {
      ok: true,
      data: { ...meta, content: truncated },
    };
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
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.query !== "string" || !input.query.trim()) {
      return { ok: false, error: "query must be a non-empty string" };
    }
    const query = input.query.toLowerCase();
    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    const maxFiles = typeof input.maxFiles === "number" ? Math.min(input.maxFiles, 2000) : 200;
    const maxMatches = typeof input.maxMatches === "number" ? Math.min(input.maxMatches, 200) : 30;
    const files = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, maxFiles);
    const matches: Array<{ path: string; line: number; text: string }> = [];

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
          if (lines[i].toLowerCase().includes(query)) {
            matches.push({ path: rel, line: i + 1, text: truncateText(lines[i].trim(), 300) });
            if (matches.length >= maxMatches) {
              return { ok: true, data: { query: input.query, matches } };
            }
          }
        }
      } catch {
        continue;
      }
    }

    return { ok: true, data: { query: input.query, matches } };
  },
};
