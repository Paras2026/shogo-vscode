/**
 * Background Terminal — Routes long-running commands to a visible VS Code terminal.
 * 
 * Instead of blocking the agent loop while npm install / pytest / git push runs,
 * the command is sent to a dedicated "Shogo Agent" terminal the user can watch.
 */
import * as os from "os";
import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { logInfo, logWarn, logDebug } from "../logger";
import { getWorkspaceRootPath } from "./workspace";

const TERMINAL_NAME = "⚡ Shogo Agent";

interface BackgroundJob {
  id: string;
  command: string;
  terminal: vscode.Terminal;
  startedAt: number;
}

const activeJobs = new Map<string, BackgroundJob>();

/**
 * Get or create the dedicated Shogo terminal.
 */
function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  if (existing) return existing;

  const shellPath = os.platform() === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/sh");
  return vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath,
    cwd: getWorkspaceRootPath(),
  });
}

/**
 * Kill the Shogo terminal and all background jobs.
 */
export function killBackgroundJobs(): void {
  for (const [id, job] of activeJobs) {
    try { job.terminal.dispose(); } catch {}
    activeJobs.delete(id);
  }
  logDebug("All background jobs killed");
}

/**
 * Get status of all active background jobs.
 */
export function getBackgroundJobs(): BackgroundJob[] {
  return Array.from(activeJobs.values());
}

export const runBackgroundTool: ToolDefinition = {
  name: "runBackground",
  description:
    "Run a long-running command in a visible VS Code terminal. The user can watch progress in real-time. " +
    "Use this for: npm install, npm run build, pytest, git push, docker build, or any command expected to take >10 seconds. " +
    "Returns immediately — does NOT block the agent loop.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "Shell command to run in the background terminal",
      },
      label: {
        type: "string",
        description: "Optional label for the job (shown in status)",
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return { ok: false, error: "command is required" };

    const label = typeof input.label === "string" ? input.label : command.slice(0, 50);
    const jobId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      const terminal = getOrCreateTerminal();
      terminal.show(true);

      // Platform-specific marker syntax
      const isWin = process.platform === "win32";
      const nl = isWin ? "`n" : "\\n";
      const exitExpr = isWin
        ? `$(if ($null -ne $global:LastExitCode) { $global:LastExitCode } elseif ($?) { 0 } else { 1 })`
        : "$?";

      terminal.sendText(`echo "${nl}--- SHOGO_BG_${jobId}_START ---"`);
      terminal.sendText(command);
      terminal.sendText(`echo "${nl}--- SHOGO_BG_${jobId}_EXIT=${exitExpr} ---"`);

      const job: BackgroundJob = {
        id: jobId,
        command,
        terminal,
        startedAt: Date.now(),
      };
      activeJobs.set(jobId, job);

      logInfo(`Background job started: ${jobId} — ${label}`);
      vscode.window.showInformationMessage(`⚡ Shogo running: ${label}`);

      // Watch for terminal close
      const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
          logInfo(`Background job ${jobId} terminal closed after ${elapsed}s`);
          activeJobs.delete(jobId);
          disposable.dispose();
        }
      });

      return {
        ok: true,
        data: {
          jobId,
          label,
          status: "running",
          message: `Command is running in terminal "${TERMINAL_NAME}". Watch it there.`,
        },
      };
    } catch (err) {
      logWarn(`Failed to start background job: ${err}`);
      return { ok: false, error: `Failed to open terminal: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

export const backgroundStatusTool: ToolDefinition = {
  name: "backgroundStatus",
  description: "Check the status of all background terminal jobs.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    const jobs = getBackgroundJobs();

    if (jobs.length === 0) {
      return { ok: true, data: { jobs: [], message: "No background jobs running" } };
    }

    return {
      ok: true,
      data: {
        jobs: jobs.map((j) => ({
          id: j.id,
          command: j.command,
          runningForMs: Date.now() - j.startedAt,
        })),
        count: jobs.length,
      },
    };
  },
};
