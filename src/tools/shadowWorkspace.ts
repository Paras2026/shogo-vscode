/**
 * Shadow Workspace — Cursor-style multi-file edit flow.
 * 
 * When a complex task begins, files are copied to .shogo/shadow/.
 * All edits happen on the shadow copies. Once done, a unified diff
 * is shown and the user accepts/discards all changes at once.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logInfo, logDebug, logWarn } from "../logger";

const SHADOW_DIR = ".shogo/shadow";

export interface ShadowEntry {
  relativePath: string;
  absolutePath: string;
  originalContent: string;
  modifiedContent: string;
}

const pendingShadows = new Map<string, ShadowEntry>();
let shadowRoot: string | undefined;

export function getShadowRoot(): string | undefined {
  return shadowRoot;
}

export function initShadowWorkspace(): void {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;
  shadowRoot = path.join(root.uri.fsPath, SHADOW_DIR);
  fs.mkdirSync(shadowRoot, { recursive: true });
  logDebug(`Shadow workspace initialized at ${shadowRoot}`);
}

export function clearShadowWorkspace(): void {
  if (shadowRoot && fs.existsSync(shadowRoot)) {
    fs.rmSync(shadowRoot, { recursive: true, force: true });
    fs.mkdirSync(shadowRoot, { recursive: true });
  }
  pendingShadows.clear();
  logDebug("Shadow workspace cleared");
}

/**
 * Copy a file into the shadow workspace for editing.
 * Returns the shadow path where edits should be applied.
 */
export async function shadowFile(relativePath: string): Promise<string | null> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root || !shadowRoot) return null;

  const absPath = path.join(root.uri.fsPath, relativePath);
  const shadowPath = path.join(shadowRoot, relativePath);

  try {
    const content = await fs.promises.readFile(absPath, "utf-8");
    await fs.promises.mkdir(path.dirname(shadowPath), { recursive: true });
    await fs.promises.writeFile(shadowPath, content, "utf-8");

    pendingShadows.set(relativePath, {
      relativePath,
      absolutePath: absPath,
      originalContent: content,
      modifiedContent: content,
    });

    logDebug(`Shadowed file: ${relativePath}`);
    return shadowPath;
  } catch (err) {
    logWarn(`Failed to shadow file ${relativePath}: ${err}`);
    return null;
  }
}

/**
 * Update the shadow copy of a file after editing.
 */
export function updateShadow(relativePath: string, newContent: string): void {
  const entry = pendingShadows.get(relativePath);
  if (entry) {
    entry.modifiedContent = newContent;
  }
}

/**
 * Check if a file is currently being shadowed.
 */
export function isShadowed(relativePath: string): boolean {
  return pendingShadows.has(relativePath);
}

/**
 * Get the content that should be written (shadow or direct).
 */
export function getShadowContent(relativePath: string): string | null {
  const entry = pendingShadows.get(relativePath);
  return entry ? entry.modifiedContent : null;
}

/**
 * Show a unified diff of ALL shadowed files and ask user to accept/discard.
 * Uses vscode.Uri.joinPath for Remote-SSH compatibility.
 * Limits open diffs to prevent tab bombing.
 */
export async function reviewShadowChanges(
  requestApproval?: (request: {
    id: string;
    kind: string;
    title: string;
    description: string;
    primaryAction: string;
    secondaryAction: string;
    details?: Record<string, unknown>;
  }) => Promise<boolean>,
): Promise<boolean> {
  if (pendingShadows.size === 0) {
    logDebug("No shadow changes to review");
    return true;
  }

  const entries = Array.from(pendingShadows.values());
  const changedFiles = entries.filter((e) => e.originalContent !== e.modifiedContent);

  if (changedFiles.length === 0) {
    logDebug("Shadow files unchanged — skipping review");
    clearShadowWorkspace();
    return true;
  }

  logInfo(`Reviewing ${changedFiles.length} shadow file changes`);

  // Tab bombing protection: if >3 files changed, show QuickPick list
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    logWarn("No workspace folder — cannot open diffs");
    clearShadowWorkspace();
    return false;
  }

  const baseUri = workspaceFolder.uri;

  if (changedFiles.length <= 3) {
    // Small change set: open diffs directly
    for (let i = 0; i < changedFiles.length; i++) {
      try {
        const origUri = vscode.Uri.joinPath(baseUri, changedFiles[i].relativePath);
        const shadowUri = vscode.Uri.joinPath(baseUri, SHADOW_DIR, changedFiles[i].relativePath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          origUri,
          shadowUri,
          `Shogo: ${changedFiles[i].relativePath} (${i + 1}/${changedFiles.length})`,
        );
      } catch (err) {
        logWarn(`Failed to open diff for ${changedFiles[i].relativePath}: ${err}`);
      }
    }
  } else {
    // Large change set: show QuickPick so user can review individually
    const picked = await vscode.window.showQuickPick(
      changedFiles.map((e) => ({
        label: `$(diff) ${e.relativePath}`,
        description: `+${e.modifiedContent.split("\n").length} lines`,
        detail: e.relativePath,
      })),
      {
        title: `Shogo: ${changedFiles.length} files changed — pick to review`,
        placeHolder: "Select a file to open diff, or press Escape to skip",
        canPickMany: true,
      },
    );

    if (picked && picked.length > 0) {
      for (const item of picked) {
        try {
          const origUri = vscode.Uri.joinPath(baseUri, item.detail!);
          const shadowUri = vscode.Uri.joinPath(baseUri, SHADOW_DIR, item.detail!);
          await vscode.commands.executeCommand("vscode.diff", origUri, shadowUri, `Shogo: ${item.detail}`);
        } catch (err) {
          logWarn(`Failed to open diff: ${err}`);
        }
      }
    }
  }

  // Ask for approval
  if (requestApproval) {
    const approved = await requestApproval({
      id: `shadow-review-${Date.now()}`,
      kind: "edit",
      title: `Apply ${changedFiles.length} file changes?`,
      description: changedFiles.map((e) => `• ${e.relativePath}`).join("\n"),
      primaryAction: "Apply All",
      secondaryAction: "Discard All",
      details: { filesChanged: changedFiles.length },
    });

    if (approved) {
      for (const entry of changedFiles) {
        await fs.promises.writeFile(entry.absolutePath, entry.modifiedContent, "utf-8");
        logInfo(`Applied shadow edit: ${entry.relativePath}`);
      }
    } else {
      logInfo("Shadow changes discarded by user");
    }

    clearShadowWorkspace();
    return approved;
  }

  clearShadowWorkspace();
  return false;
}
