import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import {
  asRelative,
  getWorkspaceRootPath,
  isLikelyTextFile,
  normalizeRelativePath,
  resolveAbsolutePath,
  truncateText,
} from "./workspace";

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
    const max = typeof input.max === "number" ? Math.min(Math.max(input.max, 1), 1000) : 100;
    const root = getWorkspaceRootPath();
    if (!root) return { ok: false, error: "No workspace folder is open." };

    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    try {
      const stdout = await execCommand(
        `find . -path './node_modules' -prune -o -path './.git' -prune -o -path './dist' -prune -o -type f -name '${pattern.replace("**/*", "*").replace("**/", "")}' -print | head -${max}`,
        root
      );
      const files = stdout.trim().split("\n").filter(Boolean).slice(0, max);
      return { ok: true, data: { files } };
    } catch {
      // Fallback to VS Code API
      const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/*.vsix}";
      const uris = await vscode.workspace.findFiles(pattern, exclude, max);
      return { ok: true, data: { files: uris.map(asRelative) } };
    }
  },
};

export const readFileTool: ToolDefinition = {
  name: "readFile",
  description:
    "Read a text file from the workspace. Returns content with line numbers. For large files (500+ lines), ALWAYS use startLine/endLine.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      startLine: { type: "number", description: "First line to read (1-based). Default: 1" },
      endLine: { type: "number", description: "Last line to read (1-based, inclusive). Default: 200" },
      maxChars: { type: "number", description: "Optional max chars, default 12000" },
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

    try {
      const absPath = resolveAbsolutePath(rel);
      const fullText = await fs.promises.readFile(absPath, "utf-8");
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

      const maxChars = typeof input.maxChars === "number" ? input.maxChars : 12000;
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

      return { ok: true, data: { ...meta, content: truncated } };
    } catch (err) {
      // Fallback to VS Code API
      try {
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ...rel.split("/"));
        const bytes = await vscode.workspace.fs.readFile(uri);
        const fullText = Buffer.from(bytes).toString("utf8");
        const lines = fullText.split(/\r?\n/);
        const totalLines = lines.length;
        const startLine = typeof input.startLine === "number" ? Math.floor(input.startLine) : 1;
        const endLine = typeof input.endLine === "number" ? Math.min(Math.floor(input.endLine), totalLines) : Math.min(startLine + 199, totalLines);
        const selectedLines = lines.slice(startLine - 1, endLine);
        const numbered = selectedLines.map((line, i) => `${startLine + i}|${line}`).join("\n");
        const maxChars = typeof input.maxChars === "number" ? input.maxChars : 12000;
        return { ok: true, data: { path: rel, totalLines, startLine, endLine: Math.min(endLine, totalLines), content: truncateText(numbered, maxChars) } };
      } catch (fallbackErr) {
        return { ok: false, error: `Failed to read ${rel}: ${fallbackErr instanceof Error ? fallbackErr.message : "Unknown error"}` };
      }
    }
  },
};

export const searchWorkspaceTool: ToolDefinition = {
  name: "searchWorkspace",
  description: "Search text files in the workspace for a case-insensitive query. Uses ripgrep when available.",
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
    const maxMatches = typeof input.maxMatches === "number" ? Math.min(input.maxMatches, 200) : 30;
    const root = getWorkspaceRootPath();
    if (!root) return { ok: false, error: "No workspace folder is open." };

    // Try ripgrep first (10-100x faster than Node.js grep)
    try {
      const args = [
        "--line-number",
        "--ignore-case",
        "--max-count", String(maxMatches),
        "--glob", "!node_modules",
        "--glob", "!.git",
        "--glob", "!dist",
        "--glob", "!build",
        "--glob", "!.next",
        "--glob", "!*.vsix",
        "--glob", "!*.min.js",
      ];
      if (input.pattern && typeof input.pattern === "string") {
        args.push("--glob", input.pattern);
      }
      args.push(input.query, ".");

      const stdout = await execCommand(`rg ${args.map(escapeShell).join(" ")}`, root);
      const matches = stdout.trim().split("\n").filter(Boolean).slice(0, maxMatches).map((line) => {
        const colonIdx = line.indexOf(":");
        const lineNumIdx = line.indexOf(":", colonIdx + 1);
        if (colonIdx > 0 && lineNumIdx > 0) {
          return {
            path: line.slice(0, colonIdx).replace(/^\.\//, ""),
            line: parseInt(line.slice(colonIdx + 1, lineNumIdx), 10) || 0,
            text: truncateText(line.slice(lineNumIdx + 1).trim(), 300),
          };
        }
        return { path: line, line: 0, text: "" };
      });
      return { ok: true, data: { query: input.query, matches, engine: "ripgrep" } };
    } catch {
      // rg not found — fall through to grep
    }

    // Try grep
    try {
      const stdout = await execCommand(
        `grep -rn --include='*' -i '${input.query.replace(/'/g, "'\\''")}' . | head -${maxMatches}`,
        root
      );
      const matches = stdout.trim().split("\n").filter(Boolean).slice(0, maxMatches).map((line) => {
        const colonIdx = line.indexOf(":");
        const lineNumIdx = line.indexOf(":", colonIdx + 1);
        if (colonIdx > 0 && lineNumIdx > 0) {
          return {
            path: line.slice(0, colonIdx).replace(/^\.\//, ""),
            line: parseInt(line.slice(colonIdx + 1, lineNumIdx), 10) || 0,
            text: truncateText(line.slice(lineNumIdx + 1).trim(), 300),
          };
        }
        return { path: line, line: 0, text: "" };
      });
      return { ok: true, data: { query: input.query, matches, engine: "grep" } };
    } catch {
      // grep also not found — fall through to VS Code API
    }

    // Final fallback: VS Code API (slowest)
    const query = input.query.toLowerCase();
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}";
    const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
    const maxFiles = typeof input.maxFiles === "number" ? Math.min(input.maxFiles, 2000) : 200;
    const files = await vscode.workspace.findFiles(pattern, exclude, maxFiles);
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const uri of files) {
      const rel = asRelative(uri);
      if (!isLikelyTextFile(rel)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            matches.push({ path: rel, line: i + 1, text: truncateText(lines[i].trim(), 300) });
            if (matches.length >= maxMatches) {
              return { ok: true, data: { query: input.query, matches, engine: "vscode" } };
            }
          }
        }
      } catch {
        continue;
      }
    }

    return { ok: true, data: { query: input.query, matches, engine: "vscode" } };
  },
};

function execCommand(cmd: string, cwd: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, CI: "true", GIT_TERMINAL_PROMPT: "0" },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => {
      if (code === 0 || stdout.length > 0) resolve(stdout);
      else reject(new Error(stderr || `Command exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function escapeShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
