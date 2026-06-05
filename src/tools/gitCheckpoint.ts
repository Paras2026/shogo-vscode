/**
 * Git Checkpoint System — replaces the old shadow workspace approach.
 *
 * Creates real git commits before major edits so we can rollback on failure.
 * Checkpoints are tracked in .shogo/checkpoints.json.
 */
import { spawn } from "child_process";
import * as vscode from "vscode";
import { logInfo, logDebug, logWarn } from "../logger";

export interface Checkpoint {
  hash: string;
  description: string;
  timestamp: number;
  filesChanged: string[];
}

const CHECKPOINTS_FILE = ".shogo/checkpoints.json";

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });
    child.on("error", () => {
      resolve({ stdout: "", stderr: "git not available", code: 1 });
    });
  });
}

/**
 * Check if the workspace is a git repository.
 */
export async function isGitRepo(): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], root);
  return result.code === 0 && result.stdout === "true";
}

/**
 * Initialize a git repo if one doesn't exist (for non-git projects).
 */
export async function initGitRepo(): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;

  const exists = await isGitRepo();
  if (exists) return true;

  logInfo("No git repo found — initializing one for checkpoints");
  const result = await runGit(["init"], root);
  return result.code === 0;
}

/**
 * Create a checkpoint commit with all current changes.
 */
export async function createCheckpoint(description: string): Promise<Checkpoint | null> {
  const root = getWorkspaceRoot();
  if (!root) return null;

  // Ensure git repo exists
  const hasGit = await initGitRepo();
  if (!hasGit) {
    logWarn("Cannot create checkpoint: git not available");
    return null;
  }

  // Stage all changes
  const addResult = await runGit(["add", "-A"], root);
  if (addResult.code !== 0) {
    logWarn(`git add failed: ${addResult.stderr}`);
    return null;
  }

  // Check if there's anything to commit
  const statusResult = await runGit(["diff", "--cached", "--quiet"], root);
  if (statusResult.code === 0) {
    // No changes to commit (exit code 0 means no diff)
    logDebug("No changes to checkpoint — skipping");
    return null;
  }

  // Commit
  const commitResult = await runGit(
    ["commit", "-m", `checkpoint: ${description}`, "--allow-empty"],
    root
  );
  if (commitResult.code !== 0) {
    logWarn(`git commit failed: ${commitResult.stderr}`);
    return null;
  }

  // Get the commit hash
  const hashResult = await runGit(["rev-parse", "HEAD"], root);
  const hash = hashResult.stdout || "unknown";

  // Get list of changed files
  const filesResult = await runGit(["diff", "--name-only", "HEAD~1", "HEAD"], root);
  const filesChanged = filesResult.code === 0
    ? filesResult.stdout.split("\n").filter(Boolean)
    : [];

  const checkpoint: Checkpoint = {
    hash,
    description,
    timestamp: Date.now(),
    filesChanged,
  };

  logInfo(`Checkpoint created: ${hash.slice(0, 8)} — ${description} (${filesChanged.length} files)`);

  return checkpoint;
}

/**
 * Rollback to a specific checkpoint by reverting the commit.
 */
export async function rollbackToCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;

  logInfo(`Rolling back to checkpoint: ${checkpoint.hash.slice(0, 8)} — ${checkpoint.description}`);

  // Soft reset to the commit before the checkpoint
  const result = await runGit(
    ["revert", "--no-edit", checkpoint.hash],
    root
  );

  if (result.code !== 0) {
    logWarn(`git revert failed: ${result.stderr}`);

    // Fallback: hard reset
    const hardResult = await runGit(
      ["reset", "--hard", `${checkpoint.hash}~1`],
      root
    );

    if (hardResult.code !== 0) {
      logError(`Hard reset also failed: ${hardResult.stderr}`);
      return false;
    }

    logInfo("Used hard reset fallback for rollback");
    return true;
  }

  logInfo(`Rollback complete: reverted ${checkpoint.hash.slice(0, 8)}`);
  return true;
}

function logError(msg: string, err?: unknown): void {
  logWarn(`${msg}${err ? `: ${err}` : ""}`);
}
