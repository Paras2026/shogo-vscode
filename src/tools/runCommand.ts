import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { classifyCommand } from "../safety/commandPolicy";
import { getWorkspaceRoot, getWorkspaceRootPath, truncateText } from "./workspace";

const MAX_OUTPUT_CHARS = 60000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CONSECUTIVE_ERRORS = 5;
let outputChannel: vscode.OutputChannel | undefined;

// ── Headless environment flags ──
const HEADLESS_ENV: Record<string, string> = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  VISUAL: "",
  EDITOR: "true",
  npm_config_yes: "true",
  PIP_NO_INPUT: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
};

function getDefaultShell(): string {
  const platform = os.platform();
  if (platform === "win32") {
    const comspec = process.env.COMSPEC;
    if (comspec) return comspec;
    const candidates = [
      "powershell.exe", "pwsh.exe",
      process.env.SYSTEMROOT ? `${process.env.SYSTEMROOT}\\System32\\cmd.exe` : null,
      "cmd.exe",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      try { require("fs").accessSync(c); return c; } catch { continue; }
    }
    return "cmd.exe";
  }
  if (platform === "darwin") return process.env.SHELL || "/bin/zsh";
  return process.env.SHELL || "/bin/sh";
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("Shogo Commands");
  return outputChannel;
}

// ── Persistent Shell ──
class PersistentShell {
  private process: ChildProcess | null = null;
  private cwd: string;
  private consecutiveErrors = 0;
  private commandId = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  start(): void {
    this.stop();
    const shell = getDefaultShell();
    const isWin = os.platform() === "win32";
    const env = { ...process.env, ...HEADLESS_ENV };

    this.process = isWin
      ? spawn(shell, [], { cwd: this.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(shell, [], { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    this.process.on("error", () => { this.consecutiveErrors++; });
    this.process.on("exit", () => { this.process = null; });
  }

  stop(): void {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }

  reset(): void {
    this.stop();
    this.consecutiveErrors = 0;
    this.start();
  }

  async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!this.isAlive() || this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      this.reset();
    }

    return new Promise((resolve) => {
      const marker = `__SHOGO_DONE_${++this.commandId}__`;
      const isWin = os.platform() === "win32";
      const wrappedCmd = isWin ? `${command} & echo ${marker}` : `${command}; echo $?; echo ${marker}`;

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      };

      const timer = setTimeout(() => {
        this.process?.kill();
        this.consecutiveErrors++;
        finish(-1);
      }, timeoutMs);

      const onAbort = () => {
        this.process?.kill();
        finish(-1);
      };
      signal?.addEventListener("abort", onAbort);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stdout.includes(marker)) return;
        stdout += text;
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stdout = stdout.slice(-MAX_OUTPUT_CHARS);
        }
      };

      const onErrData = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_CHARS) {
          stderr = stderr.slice(-MAX_OUTPUT_CHARS);
        }
      };

      this.process!.stdout?.on("data", onData);
      this.process!.stderr?.on("data", onErrData);

      this.process!.stdin?.write(wrappedCmd + "\n");

      // Watch for marker in stdout
      const checkInterval = setInterval(() => {
        if (stdout.includes(marker)) {
          clearInterval(checkInterval);
          this.process!.stdout?.removeListener("data", onData);
          this.process!.stderr?.removeListener("data", onErrData);

          // Extract exit code if available
          const markerIdx = stdout.indexOf(marker);
          const beforeMarker = stdout.slice(0, markerIdx);
          const lines = beforeMarker.split("\n");
          let exitCode = 0;

          // On Unix, we echo $? before the marker
          if (!isWin && lines.length >= 2) {
            const possibleCode = parseInt(lines[lines.length - 2].trim(), 10);
            if (!isNaN(possibleCode)) {
              exitCode = possibleCode;
              lines.splice(lines.length - 2, 1);
            }
          }

          stdout = lines.join("\n").trim();
          finish(exitCode);
        }
      }, 50);

      // Safety timeout for the interval
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!settled) {
          this.process?.stdout?.removeListener("data", onData);
          this.process?.stderr?.removeListener("data", onErrData);
          finish(stdout.includes(marker) ? 0 : -1);
        }
      }, timeoutMs + 1000);
    });
  }

  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }
}

// Global persistent shell instance
let globalShell: PersistentShell | null = null;

function getShell(): PersistentShell {
  if (!globalShell) {
    const root = getWorkspaceRootPath() || process.cwd();
    globalShell = new PersistentShell(root);
    globalShell.start();
  }
  return globalShell;
}

export const runCommandTool: ToolDefinition = {
  name: "runCommand",
  description: "Run a shell command in the workspace. Commands share state (cd persists between calls).",
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
      id: `command-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    const timeoutMs = typeof input.timeoutMs === "number"
      ? Math.min(Math.max(input.timeoutMs, 1000), 300000)
      : DEFAULT_TIMEOUT_MS;

    ctx.postActivity?.(`Running command: ${command}`);
    const channel = getOutputChannel();
    channel.appendLine(`\n$ ${command}`);
    channel.show(true);

    const shell = getShell();
    const result = await shell.execute(command, timeoutMs, ctx.signal);

    const stdoutTruncated = truncateText(result.stdout, MAX_OUTPUT_CHARS);
    const stderrTruncated = truncateText(result.stderr, MAX_OUTPUT_CHARS);

    if (result.stderr) {
      channel.append(result.stderr);
    }
    channel.appendLine(stdoutTruncated);

    const data = {
      command,
      exitCode: result.code,
      stdout: stdoutTruncated,
      stderr: stderrTruncated,
    };

    if (result.code === 0) {
      return { ok: true, data };
    } else {
      return { ok: false, error: `Command exited with code ${result.code}.`, data };
    }
  },
};
