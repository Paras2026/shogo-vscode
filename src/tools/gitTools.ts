import * as vscode from "vscode";
import { spawn } from "child_process";
import type { ToolDefinition, ToolResult } from "../agent/types";

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: "pipe", signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    child.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
  });
}

function getCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export const gitStatusTool: ToolDefinition = {
  name: "gitStatus",
  description: "Show the working tree status (modified, added, deleted, untracked files).",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx): Promise<ToolResult> {
    const cwd = getCwd();
    const result = await runGit(["status", "--porcelain"], cwd, ctx.signal);
    if (result.code !== 0) {
      return { ok: false, error: result.stderr || "git status failed. Is this a git repository?" };
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
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = getCwd();
    const staged = input.staged === true;
    const maxLines = typeof input.maxLines === "number" ? input.maxLines : 200;
    const args = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"];
    const statResult = await runGit(args, cwd, ctx.signal);

    const diffArgs = staged ? ["diff", "--cached"] : ["diff"];
    const diffResult = await runGit(diffArgs, cwd, ctx.signal);
    if (diffResult.code !== 0) {
      return { ok: false, error: diffResult.stderr || "git diff failed." };
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
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = getCwd();
    const count = typeof input.count === "number" ? input.count : 10;
    const result = await runGit(
      ["log", `--max-count=${count}`, "--pretty=format:%h %s (%ar)"],
      cwd,
      ctx.signal
    );
    if (result.code !== 0) {
      return { ok: false, error: result.stderr || "git log failed." };
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
