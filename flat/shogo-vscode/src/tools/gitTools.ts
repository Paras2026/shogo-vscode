import { spawn } from "child_process";
import * as os from "os";
import type { ToolDefinition, ToolResult } from "../agent/types";
import { getWorkspaceRoot, truncateText } from "./workspace";

const MAX_GIT_OUTPUT = 60000;

export const gitStatusTool: ToolDefinition = {
  name: "gitStatus",
  description: "Read git status for the current workspace. This is read-only.",
  inputSchema: {
    type: "object",
    properties: {
      porcelain: { type: "boolean", description: "Return porcelain output, default true" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const porcelain = input.porcelain !== false;
    return runGit(porcelain ? ["status", "--short", "--branch"] : ["status"]);
  },
};

export const gitDiffTool: ToolDefinition = {
  name: "gitDiff",
  description: "Read git diff for the current workspace. This is read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional path to diff" },
      staged: { type: "boolean", description: "Diff staged changes instead of working tree" },
      maxChars: { type: "number", description: "Maximum diff characters, default 60000" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const args = ["diff", "--no-ext-diff"];
    if (input.staged === true) {
      args.push("--cached");
    }
    if (typeof input.path === "string" && input.path.trim()) {
      args.push("--", input.path.trim());
    }
    const result = await runGit(args);
    if (result.ok && result.data && typeof result.data === "object") {
      const data = result.data as { stdout?: string };
      const maxChars = typeof input.maxChars === "number" ? Math.min(Math.max(input.maxChars, 1000), MAX_GIT_OUTPUT) : MAX_GIT_OUTPUT;
      data.stdout = truncateText(data.stdout ?? "", maxChars);
    }
    return result;
  },
};

async function runGit(args: string[]): Promise<ToolResult> {
  const root = getWorkspaceRoot();
  if (!root) {
    return { ok: false, error: "No workspace folder is open." };
  }

  const gitCmd = os.platform() === "win32" ? "git" : "git";

  return new Promise((resolve) => {
    const child = spawn(gitCmd, args, {
      cwd: root.uri.fsPath,
      shell: os.platform() === "win32",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_GIT_OUTPUT) {
        stdout = stdout.slice(-MAX_GIT_OUTPUT);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_GIT_OUTPUT) {
        stderr = stderr.slice(-MAX_GIT_OUTPUT);
      }
    });

    child.on("error", (error) => {
      resolve({ ok: false, error: error.message, data: { args, stdout, stderr } });
    });

    child.on("close", (code) => {
      const data = { command: `git ${args.join(" ")}`, exitCode: code, stdout, stderr };
      resolve(code === 0 ? { ok: true, data } : { ok: false, error: `git exited with code ${code}.`, data });
    });
  });
}
