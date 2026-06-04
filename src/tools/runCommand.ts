import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { classifyCommand } from "../safety/commandPolicy";
import { getWorkspaceRoot, getWorkspaceRootPath, truncateText } from "./workspace";

const MAX_OUTPUT_CHARS = 60000;
const DEFAULT_TIMEOUT_MS = 120000;
let outputChannel: vscode.OutputChannel | undefined;

const HEADLESS_ENV: Record<string, string> = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "true",
  VISUAL: "",
  EDITOR: "true",
  npm_config_yes: "true",
  PIP_NO_INPUT: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
};

// ── Command History (Feature: f1) ──
interface HistoryEntry {
  timestamp: number;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const commandHistory: HistoryEntry[] = [];
const MAX_HISTORY = 50;

function addToHistory(entry: HistoryEntry): void {
  commandHistory.unshift(entry);
  if (commandHistory.length > MAX_HISTORY) commandHistory.pop();
}

export function getCommandHistory(count?: number): HistoryEntry[] {
  return commandHistory.slice(0, count ?? 20);
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("Shogo Commands");
  return outputChannel;
}

// ── Two-Strategy Shell ──
// Windows: Persistent PowerShell PTY (dir + env + module state preserved)
// Linux/Mac: Persistent bash/zsh shell (same concept)

function isWindows(): boolean {
  return os.platform() === "win32";
}

/**
 * PersistentPowerShell — keeps a single PowerShell process alive.
 * Preserves: current directory, environment variables, loaded modules,
 * PSReadLine history, and tab completion state across all commands.
 */
class PersistentPowerShell {
  private process: ChildProcess | null = null;
  private cwd: string;
  private consecutiveErrors = 0;
  private commandId = 0;

  constructor(cwd: string) { this.cwd = cwd; }

  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  start(): void {
    this.stop();
    const env = { ...process.env, ...HEADLESS_ENV };
    this.process = spawn("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
    ], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.on("error", () => { this.consecutiveErrors++; });
    this.process.on("exit", () => { this.process = null; });

    // Send a silent init command to verify the shell is alive
    this.process.stdin?.write('Write-Output "__SHOGO_PTY_READY__"\n');
  }

  stop(): void {
    if (this.process) {
      try { this.process.stdin?.write("exit\n"); } catch {}
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }

  reset(): void { this.stop(); this.consecutiveErrors = 0; this.start(); }

  async execute(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!this.isAlive() || this.consecutiveErrors >= 5) this.reset();

    return new Promise((resolve) => {
      const marker = `__SHOGO_DONE_${++this.commandId}__`;
      // PowerShell: wrap in try/finally to guarantee marker is always emitted
      const wrappedCmd = `try { ${command} } finally { Write-Output "${marker}" }`;

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
      const onAbort = () => { this.process?.kill(); finish(-1); };
      signal?.addEventListener("abort", onAbort);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (stdout.length > MAX_OUTPUT_CHARS) stdout = stdout.slice(-MAX_OUTPUT_CHARS);
      };
      const onErrData = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_CHARS) stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      };

      this.process!.stdout?.on("data", onData);
      this.process!.stderr?.on("data", onErrData);
      this.process!.stdin?.write(wrappedCmd + "\n");

      const checkInterval = setInterval(() => {
        if (stdout.includes(marker)) {
          clearInterval(checkInterval);
          this.process!.stdout?.removeListener("data", onData);
          this.process!.stderr?.removeListener("data", onErrData);

          // Extract everything before the marker
          const markerIdx = stdout.indexOf(marker);
          const beforeMarker = stdout.slice(0, markerIdx).trim();
          stdout = beforeMarker;
          finish(0); // try/finally always exits cleanly
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (!settled) {
          this.process!.stdout?.removeListener("data", onData);
          this.process!.stderr?.removeListener("data", onErrData);
          this.reset(); // Process is likely hung, restart it
          finish(stdout.includes(marker) ? 0 : -1);
        }
      }, timeoutMs + 1000);
    });
  }
}

// Linux/Mac: Persistent shell for state preservation
class PersistentShell {
  private process: ChildProcess | null = null;
  private cwd: string;
  private consecutiveErrors = 0;
  private commandId = 0;

  constructor(cwd: string) { this.cwd = cwd; }

  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  start(): void {
    this.stop();
    const shell = process.env.SHELL || "/bin/sh";
    const env = { ...process.env, ...HEADLESS_ENV };
    this.process = spawn(shell, [], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.on("error", () => { this.consecutiveErrors++; });
    this.process.on("exit", () => { this.process = null; });
  }

  stop(): void {
    if (this.process) { try { this.process.kill(); } catch {} this.process = null; }
  }

  reset(): void { this.stop(); this.consecutiveErrors = 0; this.start(); }

  async execute(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!this.isAlive() || this.consecutiveErrors >= 5) this.reset();

    return new Promise((resolve) => {
      const marker = `__SHOGO_DONE_${++this.commandId}__`;
      const wrappedCmd = `${command}; __exit=$?; echo $__exit; echo ${marker}`;

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
      const onAbort = () => { this.process?.kill(); finish(-1); };
      signal?.addEventListener("abort", onAbort);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (stdout.length > MAX_OUTPUT_CHARS) stdout = stdout.slice(-MAX_OUTPUT_CHARS);
      };
      const onErrData = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_CHARS) stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      };

      this.process!.stdout?.on("data", onData);
      this.process!.stderr?.on("data", onErrData);
      this.process!.stdin?.write(wrappedCmd + "\n");

      const checkInterval = setInterval(() => {
        if (stdout.includes(marker)) {
          clearInterval(checkInterval);
          this.process!.stdout?.removeListener("data", onData);
          this.process!.stderr?.removeListener("data", onErrData);

          const markerIdx = stdout.indexOf(marker);
          const beforeMarker = stdout.slice(0, markerIdx);
          const lines = beforeMarker.split("\n");
          let exitCode = 0;
          if (lines.length >= 2) {
            const possibleCode = parseInt(lines[lines.length - 2].trim(), 10);
            if (!isNaN(possibleCode)) { exitCode = possibleCode; lines.splice(lines.length - 2, 1); }
          }
          stdout = lines.join("\n").trim();
          finish(exitCode);
        }
      }, 50);

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
}

let globalShell: PersistentShell | null = null;
let globalWinShell: PersistentPowerShell | null = null;

function getShell(): PersistentShell | PersistentPowerShell {
  if (isWindows()) {
    if (!globalWinShell) {
      const root = getWorkspaceRootPath() || process.cwd();
      globalWinShell = new PersistentPowerShell(root);
      globalWinShell.start();
    }
    return globalWinShell;
  }
  if (!globalShell) {
    const root = getWorkspaceRootPath() || process.cwd();
    globalShell = new PersistentShell(root);
    globalShell.start();
  }
  return globalShell;
}

// ── Main Tool ──
export const runCommandTool: ToolDefinition = {
  name: "runCommand",
  description:
    "Run a shell command. On Windows uses PowerShell; on Linux/Mac uses persistent shell (cd persists). " +
    "Use the `cwd` parameter to run commands in a subdirectory WITHOUT using `cd`. " +
    "IMPORTANT: On Windows, do NOT use bash syntax like `&&` or `&`. Use `;` instead, or run separate commands. " +
    "Do NOT use `cd dir && command` — use `cwd` parameter instead.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "Command line to run" },
      cwd: { type: "string", description: "Working directory (workspace-relative path). Use this instead of 'cd'." },
      timeoutMs: { type: "number", description: "Optional timeout in ms, default 120000" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.command !== "string") return { ok: false, error: "command must be a string" };

    let command = input.command.trim();

    // ── PowerShell command normalization ──
    if (isWindows()) {
      // Convert: cmd1 && cmd2 → cmd1; if ($?) { cmd2 }
      // This makes && work correctly on PowerShell 5.1+
      command = command.replace(
        /(\S+(?:\s+\S+)*)\s*&&\s*(.+)/g,
        (_match: string, cmd1: string, cmd2: string) => `${cmd1.trim()}; if ($?) { ${cmd2.trim()} }`,
      );
    }

    // Strip leading `cd <dir> &&` or `cd <dir>;` — use cwd parameter instead
    const cdPattern = /^\s*cd\s+([^\s&;|]+)\s*[&;|]\s*/i;
    const cdMatch = command.match(cdPattern);
    if (cdMatch) {
      command = command.slice(cdMatch[0].length).trim();
    }

    // Determine working directory
    let workingDir: string;
    const root = getWorkspaceRoot();
    if (!root) return { ok: false, error: "No workspace folder is open." };

    if (typeof input.cwd === "string" && input.cwd.trim()) {
      const path = require("path");
      workingDir = path.join(root.uri.fsPath, input.cwd.trim());
    } else if (cdMatch) {
      const path = require("path");
      workingDir = path.join(root.uri.fsPath, cdMatch[1]);
    } else {
      workingDir = root.uri.fsPath;
    }
    const decision = classifyCommand(command);
    if (decision.action === "block") return { ok: false, error: `Blocked command: ${decision.reason}` };

    if (!root) return { ok: false, error: "No workspace folder is open." };
    if (!ctx.requestApproval) return { ok: false, error: "Approval UI is unavailable." };

    const approved = await ctx.requestApproval({
      id: `command-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: "command",
      title: decision.action === "allow" ? "Run safe command?" : "Run command?",
      description: command,
      primaryAction: "Run Command",
      secondaryAction: "Cancel",
      details: { cwd: workingDir, reason: decision.reason, policy: decision.action },
    });
    if (!approved) return { ok: false, error: "User cancelled command." };

    const timeoutMs = typeof input.timeoutMs === "number"
      ? Math.min(Math.max(input.timeoutMs, 1000), 300000)
      : DEFAULT_TIMEOUT_MS;

    ctx.postActivity?.(`Running command: ${command}`);
    const channel = getOutputChannel();
    channel.appendLine(`\n$ ${command}`);
    channel.show(true);

    const startTime = Date.now();
    const shell = getShell();
    // For persistent shells, cd actually persists — send cd + command together
    let execCommand = command;
    if (workingDir && workingDir !== (getWorkspaceRootPath() || process.cwd())) {
      const relativeCwd = require("path").relative(getWorkspaceRootPath() || process.cwd(), workingDir);
      if (relativeCwd) {
        const cdPrefix = isWindows() ? `Set-Location "${workingDir}"; ` : `cd "${workingDir}" && `;
        execCommand = `${cdPrefix}${command}`;
      }
    }
    const result = await shell.execute(execCommand, timeoutMs, ctx.signal);

    const durationMs = Date.now() - startTime;

    // Record in command history
    addToHistory({
      timestamp: Date.now(),
      command,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    });

    const stdoutTruncated = truncateText(result.stdout, MAX_OUTPUT_CHARS);
    const stderrTruncated = truncateText(result.stderr, MAX_OUTPUT_CHARS);

    if (result.stderr) channel.append(result.stderr);
    channel.appendLine(stdoutTruncated);

    const data = {
      command,
      exitCode: result.code,
      stdout: stdoutTruncated,
      stderr: stderrTruncated,
      durationMs,
      platform: isWindows() ? "windows" : "unix",
    };

    if (result.code === 0) return { ok: true, data };
    else return { ok: false, error: `Command exited with code ${result.code}.`, data };
  },
};
