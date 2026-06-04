import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { normalizeRelativePath, resolveAbsolutePath, truncateText } from "./workspace";

/**
 * Unified Diff Editing — SEARCH/REPLACE blocks.
 * The LLM outputs blocks like:
 *   <<<<<<< SEARCH
 *   exact old code
 *   =======
 *   new replacement code
 *   >>>>>>> REPLACE
 *
 * Multiple blocks can appear in one call. Each block is applied sequentially.
 * This is the same format used by Aider, Cursor, and Windsurf.
 */
export const applyPatchTool: ToolDefinition = {
  name: "applyPatch",
  description:
    "Edit a file using SEARCH/REPLACE blocks. Use this format:\n" +
    "<<<<<<< SEARCH\nexact old code to find\n=======\nnew replacement code\n>>>>>>> REPLACE\n\n" +
    "You can include multiple blocks. Each block must match the file EXACTLY. Read the file first with readFile.",
  inputSchema: {
    type: "object",
    required: ["path", "patch"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      patch: {
        type: "string",
        description:
          "One or more SEARCH/REPLACE blocks separated by newlines. " +
          "Each block: <<<<<<< SEARCH\\n<exact old text>\\n=======\\n<new text>\\n>>>>>>> REPLACE",
      },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.path !== "string" || typeof input.patch !== "string") {
      return { ok: false, error: "path and patch must be strings" };
    }

    const rel = normalizeRelativePath(input.path);
    const absPath = resolveAbsolutePath(rel);

    // Read current file content
    let current: string;
    let exists = true;
    try {
      current = await fs.promises.readFile(absPath, "utf-8");
    } catch {
      exists = false;
      current = "";
    }

    // Parse SEARCH/REPLACE blocks
    const blocks = parseSearchReplaceBlocks(input.patch);
    if (blocks.length === 0) {
      return { ok: false, error: "No valid SEARCH/REPLACE blocks found. Use the format:\n<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE" };
    }

    // Apply each block sequentially
    let modified = current;
    const appliedBlocks: string[] = [];
    const failedBlocks: string[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const idx = modified.indexOf(block.search);

      if (idx === -1) {
        failedBlocks.push(`Block ${i + 1}: SEARCH text not found in file`);
        continue;
      }

      // Check uniqueness (warn but allow if multiple matches)
      const secondIdx = modified.indexOf(block.search, idx + block.search.length);
      if (secondIdx !== -1) {
        failedBlocks.push(`Block ${i + 1}: SEARCH text is not unique (${countOccurrences(modified, block.search)} matches). Add more context.`);
        continue;
      }

      modified = modified.slice(0, idx) + block.replace + modified.slice(idx + block.search.length);
      appliedBlocks.push(`Block ${i + 1}: applied`);
    }

    if (failedBlocks.length > 0 && appliedBlocks.length === 0) {
      return { ok: false, error: `All blocks failed:\n${failedBlocks.join("\n")}` };
    }

    // Show diff and request approval
    if (ctx.requestApproval && exists) {
      const approved = await showDiffApproval(ctx, absPath, rel, current, modified);
      if (!approved) {
        return { ok: false, error: "User rejected the edit." };
      }
    }

    // Write the file
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, modified, "utf-8");

    const result: Record<string, unknown> = {
      path: rel,
      changed: true,
      blocksApplied: appliedBlocks.length,
      created: !exists,
    };
    if (failedBlocks.length > 0) {
      result.warnings = failedBlocks;
    }

    return { ok: true, data: result };
  },
};

export const writeFileTool: ToolDefinition = {
  name: "writeFile",
  description: "Create or fully replace a file. Shows a diff and requires approval.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "Full file content" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.path !== "string" || typeof input.content !== "string") {
      return { ok: false, error: "path and content must be strings" };
    }

    const rel = normalizeRelativePath(input.path);
    const absPath = resolveAbsolutePath(rel);

    let current = "";
    let exists = true;
    try {
      current = await fs.promises.readFile(absPath, "utf-8");
    } catch {
      exists = false;
    }

    if (ctx.requestApproval && exists) {
      const approved = await showDiffApproval(ctx, absPath, rel, current, input.content);
      if (!approved) {
        return { ok: false, error: "User rejected file write." };
      }
    }

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, input.content, "utf-8");

    return { ok: true, data: { path: rel, changed: true, created: !exists } };
  },
};

// ── Helpers ──

interface SearchReplaceBlock {
  search: string;
  replace: string;
}

function parseSearchReplaceBlocks(patch: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const regex = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(patch)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2],
    });
  }

  // Also support old format (oldText/newText) for backward compatibility
  if (blocks.length === 0) {
    try {
      const parsed = JSON.parse(patch);
      if (parsed.oldText && parsed.newText) {
        blocks.push({ search: parsed.oldText, replace: parsed.newText });
      }
    } catch {
      // Not JSON, no blocks found
    }
  }

  return blocks;
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}

async function showDiffApproval(
  ctx: ToolExecutionContext,
  originalUri: string,
  relativePath: string,
  oldContent: string,
  newContent: string,
): Promise<boolean> {
  if (!ctx.requestApproval) return false;

  try {
    const origUri = vscode.Uri.file(originalUri);
    const previewDir = vscode.Uri.joinPath(ctx.extensionContext.globalStorageUri, "previews");
    await vscode.workspace.fs.createDirectory(previewDir);
    const safeName = relativePath.replace(/[\\/:*?"<>|]/g, "_");
    const previewUri = vscode.Uri.joinPath(previewDir, `preview-${Date.now()}-${safeName}`);
    await vscode.workspace.fs.writeFile(previewUri, Buffer.from(newContent, "utf8"));
    await vscode.commands.executeCommand("vscode.diff", origUri, previewUri, `Shogo edit: ${relativePath}`);

    return ctx.requestApproval({
      id: `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: "edit",
      title: "Apply edit?",
      description: `Review the diff for ${relativePath}`,
      primaryAction: "Apply",
      secondaryAction: "Reject",
      details: { file: relativePath, diff: "Opened in editor" },
    });
  } catch {
    return false;
  }
}

export function summarizeToolData(data: unknown): string {
  return truncateText(JSON.stringify(data, null, 2), 4000);
}
