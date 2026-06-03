import * as vscode from "vscode";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../agent/types";
import { normalizeRelativePath, resolveWorkspacePath, truncateText } from "./workspace";

export const applyPatchTool: ToolDefinition = {
  name: "applyPatch",
  description: "Replace exact oldText with newText in a workspace file after showing a VS Code diff and asking for approval.",
  inputSchema: {
    type: "object",
    required: ["path", "oldText", "newText"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      oldText: { type: "string", description: "Exact existing text to replace" },
      newText: { type: "string", description: "Replacement text" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.path !== "string" || typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return { ok: false, error: "path, oldText, and newText must be strings" };
    }

    const rel = normalizeRelativePath(input.path);
    const uri = resolveWorkspacePath(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const current = doc.getText();
    const index = current.indexOf(input.oldText);
    if (index === -1) {
      return { ok: false, error: "oldText was not found exactly in the target file." };
    }
    if (current.indexOf(input.oldText, index + input.oldText.length) !== -1) {
      return { ok: false, error: "oldText is not unique. Provide more surrounding context." };
    }

    const next = `${current.slice(0, index)}${input.newText}${current.slice(index + input.oldText.length)}`;
    ctx.postActivity?.(`Previewing edit: ${rel}`);
    const approved = await previewAndApprove(ctx, uri, rel, next, "Apply Shogo edit", "Replace exact text block");
    if (!approved) {
      return { ok: false, error: "User rejected edit." };
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(current.length));
    edit.replace(uri, fullRange, next);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      return { ok: false, error: "VS Code rejected the workspace edit." };
    }
    await doc.save();
    return { ok: true, data: { path: rel, changed: true } };
  },
};

export const writeFileTool: ToolDefinition = {
  name: "writeFile",
  description: "Create or replace a workspace text file after showing a diff and asking for approval.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "New full file content" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (typeof input.path !== "string" || typeof input.content !== "string") {
      return { ok: false, error: "path and content must be strings" };
    }

    const rel = normalizeRelativePath(input.path);
    const uri = resolveWorkspacePath(rel);
    let current = "";
    let exists = true;
    try {
      current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      exists = false;
    }

    ctx.postActivity?.(`${exists ? "Previewing file replacement" : "Previewing new file"}: ${rel}`);
    const approved = await previewAndApprove(
      ctx,
      uri,
      rel,
      input.content,
      exists ? "Apply Shogo file update" : "Create Shogo file",
      exists ? "Replace full file content" : "Create new file"
    );
    if (!approved) {
      return { ok: false, error: "User rejected file write." };
    }

    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(current.length));
      edit.replace(uri, fullRange, input.content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        return { ok: false, error: "VS Code rejected the workspace edit." };
      }
      await doc.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(input.content, "utf8"));
    }

    return { ok: true, data: { path: rel, changed: true, created: !exists } };
  },
};

async function previewAndApprove(
  ctx: ToolExecutionContext,
  originalUri: vscode.Uri,
  relativePath: string,
  nextContent: string,
  actionLabel: string,
  changeType: string
): Promise<boolean> {
  if (!ctx.requestApproval) {
    return false;
  }

  await vscode.workspace.fs.createDirectory(ctx.extensionContext.globalStorageUri);
  const safeName = relativePath.replace(/[\\/:*?"<>|]/g, "_");
  const previewUri = vscode.Uri.joinPath(ctx.extensionContext.globalStorageUri, `preview-${Date.now()}-${safeName}`);
  await vscode.workspace.fs.writeFile(previewUri, Buffer.from(nextContent, "utf8"));
  await vscode.commands.executeCommand("vscode.diff", originalUri, previewUri, `Shogo edit preview: ${relativePath}`);

  return ctx.requestApproval({
    id: createApprovalId("edit"),
    kind: "edit",
    title: "Apply edit?",
    description: `Review the opened diff for ${relativePath}.`,
    primaryAction: actionLabel,
    secondaryAction: "Reject",
    details: {
      file: relativePath,
      change: changeType,
      diff: "Opened in editor",
    },
  });
}

function createApprovalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function summarizeToolData(data: unknown): string {
  return truncateText(JSON.stringify(data, null, 2), 4000);
}
