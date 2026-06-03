import { spawn } from "child_process";
import * as os from "os";
import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { classifyCommand } from "../safety/commandPolicy";
import { getWorkspaceRoot, truncateText } from "./workspace";

const MAX_OUTPUT_CHARS = 60000;
const DEFAULT_TIMEOUT_MS = 120000;
let outputChannel: vscode.OutputChannel | undefined;

function getDefaultShell(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  if (platform === "darwin") {
    return process.env.SHELL || "/bin/zsh";
  }
  return process.env.SHELL || "/bin/sh";
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("Shogo Commands");
  return outputChannel;
}

export const runCommandTool: ToolDefinition = {
  name: "runCommand",
  description: "Run a shell command in the workspace after safety approval and return stdout/stderr/exit code.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "Command line to run" },
      timeoutMs: { type: "number", description: "Optional timeout in ms, default 120000" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.command !== "string") {
      return { ok: false, error: "command must be a string" };
    }

    const command = input.command.trim();
    const decision = classifyCommand(command);
    if (decision.action === "block") {
      return { ok: false, error: `Blocked command: ${decision.reason}` };
    }

    const root = getWorkspaceRoot();
    if (!root) {
      return { ok: false, error: "No workspace folder is open." };
    }

    if (!ctx.requestApproval) {
      return { ok: false, error: "Approval UI is unavailable, so the command was not run." };
    }

    const approved = await ctx.requestApproval({
      id: createApprovalId("command"),
      kind: "command",
      title: decision.action === "allow" ? "Run safe command?" : "Run command?",
      description: command,
      primaryAction: "Run Command",
      secondaryAction: "Cancel",
      details: {
        cwd: root.uri.fsPath,
        reason: decision.reason,
        policy: decision.action,
      },
    });
    if (!approved) {
      return { ok: false, error: "User cancelled command." };
    }

    const timeoutMs = typeof input.timeoutMs === "number" ? Math.min(Math.max(input.timeoutMs, 1000), 300000) : DEFAULT_TIMEOUT_MS;
    ctx.postActivity?.(`Running command: ${command}`);
    return runCommand(command, root.uri.fsPath, timeoutMs, ctx);
  },
};

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const channel = getOutputChannel();
    channel.appendLine(`\n$ ${command}`);
    channel.show(true);

    const shell = getDefaultShell();
    const isWindows = os.platform() === "win32";
    const child = isWindows
      ? spawn(shell, ["/c", command], { cwd, env: process.env, windowsHide: true })
      : spawn(shell, ["-c", command], { cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `Command timed out after ${timeoutMs}ms.`, data: { stdout, stderr } });
    }, timeoutMs);

    ctx.signal?.addEventListener("abort", () => {
      child.kill();
      finish({ ok: false, error: "Command aborted.", data: { stdout, stderr } });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      channel.append(text);
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      channel.append(text);
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      }
    });

    child.on("error", (error) => {
      finish({ ok: false, error: error.message, data: { stdout, stderr } });
    });

    child.on("close", (code) => {
      const data = {
        command,
        exitCode: code,
        stdout: truncateText(stdout, MAX_OUTPUT_CHARS),
        stderr: truncateText(stderr, MAX_OUTPUT_CHARS),
      };
      finish(code === 0 ? { ok: true, data } : { ok: false, error: `Command exited with code ${code}.`, data });
    });
  });
}

function createApprovalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
