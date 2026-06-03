import * as path from "path";
import * as vscode from "vscode";

const BLOCKED_SEGMENTS = new Set([".git", "node_modules"]);
const BLOCKED_FILES = new Set([".env", ".env.local", ".env.production", ".npmrc"]);
const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".csv",
  ".env.example",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".php",
  ".prisma",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

export function getWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error("No workspace folder is open.");
  }

  const clean = normalizeRelativePath(relativePath);
  assertSafeRelativePath(clean);
  return vscode.Uri.joinPath(root.uri, ...clean.split("/"));
}

export function normalizeRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.posix.normalize(normalized);
}

export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || relativePath === ".") {
    throw new Error("A file path is required.");
  }
  if (relativePath.startsWith("../") || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw new Error("Path must stay inside the workspace.");
  }

  const parts = relativePath.split("/");
  for (const part of parts) {
    if (BLOCKED_SEGMENTS.has(part)) {
      throw new Error(`Refusing to access ${part}.`);
    }
  }

  const basename = parts[parts.length - 1];
  if (BLOCKED_FILES.has(basename)) {
    throw new Error(`Refusing to access ${basename} without explicit user handling.`);
  }
}

export function isLikelyTextFile(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  if (base.startsWith(".") && !base.includes(".example")) {
    return false;
  }
  const ext = path.posix.extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || !ext;
}

export function truncateText(text: string, maxChars = 20000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

export function asRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}
