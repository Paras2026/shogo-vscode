import * as path from "path";
import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import {
  asRelative,
  assertSafeRelativePath,
  isLikelyTextFile,
  normalizeRelativePath,
  resolveWorkspacePath,
} from "./workspace";

const EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".vscode",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".vue",
  ".svelte",
]);

interface ProjectMapEntry {
  path: string;
  lines: number;
  symbols: string[];
}

const SYMBOL_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /^export\s+(default\s+)?function\s+(\w+)/m, label: "fn" },
  { regex: /^export\s+(default\s+)?class\s+(\w+)/m, label: "class" },
  { regex: /^export\s+(default\s+)?interface\s+(\w+)/m, label: "iface" },
  { regex: /^export\s+(default\s+)?type\s+(\w+)/m, label: "type" },
  { regex: /^export\s+(default\s+)?const\s+(\w+)/m, label: "const" },
  { regex: /^export\s+(default\s+)?enum\s+(\w+)/m, label: "enum" },
  { regex: /^def\s+(\w+)/m, label: "fn" },
  { regex: /^class\s+(\w+)/m, label: "class" },
  { regex: /^func\s+(\w+)/m, label: "fn" },
  { regex: /^pub\s+(fn|struct|trait)\s+(\w+)/m, label: "fn" },
  { regex: /^def\s+(self,\s*)?(\w+)/m, label: "fn" },
];

function extractSymbols(content: string, maxSymbols: number): string[] {
  const symbols: string[] = [];
  for (const { regex, label } of SYMBOL_PATTERNS) {
    const matches = content.matchAll(new RegExp(regex.source, "gm"));
    for (const match of matches) {
      const name = match[2] || match[1];
      if (name && !symbols.includes(`${label}:${name}`)) {
        symbols.push(`${label}:${name}`);
        if (symbols.length >= maxSymbols) {
          return symbols;
        }
      }
    }
  }
  return symbols;
}

function shouldIndex(relativePath: string): boolean {
  const ext = path.posix.extname(relativePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) {
    return false;
  }
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (EXCLUDE.has(part)) {
      return false;
    }
  }
  return true;
}

export const projectMapTool: ToolDefinition = {
  name: "projectMap",
  description:
    "Scan the workspace and return a lightweight project map: file paths, line counts, and exported symbols. " +
    "Use this FIRST on large codebases to understand the structure before reading individual files. " +
    "For large projects (100+ files), use the pattern param to filter (e.g. 'src/**/*.ts').",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Optional glob to filter files. Default: all source files. Examples: 'src/**/*.ts', 'lib/**/*.py'",
      },
      maxFiles: {
        type: "number",
        description: "Maximum files to index. Default 200, max 1000.",
      },
      withSymbols: {
        type: "boolean",
        description:
          "Include exported symbol names. Default true. Set false for faster scan on huge projects.",
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    const pattern =
      typeof input.pattern === "string" ? input.pattern : "**/*";
    const maxFiles =
      typeof input.maxFiles === "number"
        ? Math.min(Math.max(input.maxFiles, 1), 1000)
        : 200;
    const withSymbols = input.withSymbols !== false;

    const uris = await vscode.workspace.findFiles(
      pattern,
      "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**}",
      maxFiles + 50
    );

    const entries: ProjectMapEntry[] = [];

    for (const uri of uris) {
      const rel = asRelative(uri);
      if (!isLikelyTextFile(rel) || !shouldIndex(rel)) {
        continue;
      }
      try {
        assertSafeRelativePath(rel);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const lines = text.split(/\r?\n/).length;

        const symbols = withSymbols ? extractSymbols(text, 15) : [];

        entries.push({ path: rel, lines, symbols });

        if (entries.length >= maxFiles) {
          break;
        }
      } catch {
        continue;
      }
    }

    const summary = entries
      .map((e) => {
        const symStr =
          e.symbols.length > 0 ? ` — ${e.symbols.join(", ")}` : "";
        return `${e.path} (${e.lines} lines)${symStr}`;
      })
      .join("\n");

    return {
      ok: true,
      data: {
        totalFiles: entries.length,
        totalLines: entries.reduce((s, e) => s + e.lines, 0),
        files: entries,
        summary,
      },
    };
  },
};
