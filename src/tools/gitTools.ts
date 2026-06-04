import * as vscode from "vscode";
import { spawn } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition, ToolResult } from "../agent/types";
import { logWarn } from "../logger";

function findGitBinary(): string {
  const platform = os.platform();
  if (platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const result = execSync("where git", { encoding: "utf8", timeout: 3000 }).trim().split("\n")[0];
      if (result && fs.existsSync(result)) return result;
    } catch {}
    const candidates = [
      "git.exe", "git",
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    ];
    for (const g of candidates) {
      try { fs.accessSync(g); return g; } catch { continue; }
    }
  }
  return "git";
}

const GIT_BIN = findGitBinary();

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(GIT_BIN, args, { cwd, stdio: "pipe", signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    child.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
  });
}

function getCwd(input: Record<string, unknown>): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  // Accept both "cwd" and "path" as parameter names (LLMs use both)
  const raw = (typeof input.cwd === "string" && input.cwd.trim())
    || (typeof input.path === "string" && input.path.trim());
  if (raw) {
    const resolved = path.resolve(root, raw);
    if (!resolved.startsWith(root)) {
      logWarn(`Blocked path traversal: "${raw}" resolved to ${resolved}`);
      return root;
    }
    return resolved;
  }
  return root;
}

export const gitStatusTool: ToolDefinition = {
  name: "gitStatus",
  description: "Show the working tree status (modified, added, deleted, untracked files).",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Working directory (workspace-relative path). Leave empty for workspace root." },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = getCwd(input);
    const result = await runGit(["status", "--porcelain"], cwd, ctx.signal);
    if (result.code !== 0) {
      const hint = result.stderr.includes("not a git repository")
        ? ` The directory "${cwd}" is not a git repository. Use the cwd parameter to point to a directory that contains a .git folder.`
        : "";
      return { ok: false, error: `${result.stderr || "git status failed."}${hint}` };
    }
    if (!result.stdout) {
      return { ok: true, data: { status: "clean", message: "No changes in the working tree." } };
    }
    const files = result.stdout.split("\n").filter(Boolean).map((line) => ({
      status: line.charAt(0) === "?" ? "untracked" : line.charAt(0) === "A" ? "added" : line.charAt(0) === "D" ? "deleted" : line.charAt(0) === "R" ? "renamed" : "modified",
      path: line.slice(3).trim(),
    }));
    return { ok: true, data: { files, count: files.length } };
  },
};

export const gitDiffTool: ToolDefinition = {
  name: "gitDiff",
  description: "Show file changes that have not been staged. Use staged=true for staged changes.",
  inputSchema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes instead of unstaged" },
      maxLines: { type: "number", description: "Max diff lines to return (default 200)" },
      cwd: { type: "string", description: "Working directory (workspace-relative path)." },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = getCwd(input);
    const staged = input.staged === true;
    const maxLines = typeof input.maxLines === "number" ? input.maxLines : 200;
    const args = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"];
    const statResult = await runGit(args, cwd, ctx.signal);

    const diffArgs = staged ? ["diff", "--cached"] : ["diff"];
    const diffResult = await runGit(diffArgs, cwd, ctx.signal);
    if (diffResult.code !== 0) {
      const hint = diffResult.stderr.includes("not a git repository")
        ? ` The directory "${cwd}" is not a git repository. Use the cwd parameter to point to a directory that contains a .git folder.`
        : "";
      return { ok: false, error: `${diffResult.stderr || "git diff failed."}${hint}` };
    }

    const lines = diffResult.stdout.split("\n");
    const truncated = lines.length > maxLines;
    const output = truncated ? lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)` : diffResult.stdout;

    return {
      ok: true,
      data: {
        staged,
        summary: statResult.stdout,
        diff: output || "No changes.",
        truncated,
      },
    };
  },
};

export const gitLogTool: ToolDefinition = {
  name: "gitLog",
  description: "Show recent git commits.",
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits to show (default 10)" },
      cwd: { type: "string", description: "Working directory (workspace-relative path)." },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = getCwd(input);
    const count = typeof input.count === "number" ? input.count : 10;
    const result = await runGit(
      ["log", `--max-count=${count}`, "--pretty=format:%h %s (%ar)"],
      cwd,
      ctx.signal
    );
    if (result.code !== 0) {
      const hint = result.stderr.includes("not a git repository")
        ? ` The directory "${cwd}" is not a git repository. Use the cwd parameter to point to a directory that contains a .git folder.`
        : "";
      return { ok: false, error: `${result.stderr || "git log failed."}${hint}` };
    }
    const commits = result.stdout.split("\n").filter(Boolean).map((line) => {
      const hash = line.slice(0, 7);
      const rest = line.slice(8);
      const parenIdx = rest.lastIndexOf(" (");
      const message = parenIdx > 0 ? rest.slice(0, parenIdx) : rest;
      const when = parenIdx > 0 ? rest.slice(parenIdx + 2, -1) : "";
      return { hash, message, when };
    });
    return { ok: true, data: { commits, count: commits.length } };
  },
};
