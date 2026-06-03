import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import { normalizeRelativePath, resolveWorkspacePath } from "./workspace";

export const multiEditTool: ToolDefinition = {
  name: "multiEdit",
  description: "Edit multiple files in a single call. Each edit is {path, oldText, newText}. All edits are applied atomically after approval.",
  inputSchema: {
    type: "object",
    required: ["edits"],
    properties: {
      edits: {
        type: "array",
        description: "Array of {path, oldText, newText} objects",
        items: {
          type: "object",
          required: ["path", "oldText", "newText"],
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
        },
      },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return { ok: false, error: "edits must be a non-empty array" };
    }

    if (edits.length > 10) {
      return { ok: false, error: "Maximum 10 edits per call" };
    }

    const validated: Array<{ rel: string; uri: vscode.Uri; oldText: string; newText: string; current: string }> = [];

    for (const edit of edits) {
      if (
        typeof edit.path !== "string" ||
        typeof edit.oldText !== "string" ||
        typeof edit.newText !== "string"
      ) {
        return { ok: false, error: "Each edit must have path, oldText, and newText strings" };
      }

      const rel = normalizeRelativePath(edit.path);
      const uri = resolveWorkspacePath(rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      const current = doc.getText();
      const index = current.indexOf(edit.oldText);
      if (index === -1) {
        return { ok: false, error: `oldText not found in ${rel}` };
      }
      validated.push({ rel, uri, oldText: edit.oldText, newText: edit.newText, current });
    }

    if (!ctx.requestApproval) {
      return { ok: false, error: "No approval handler" };
    }

    const fileList = validated.map((v) => v.rel).join(", ");
    const approved = await ctx.requestApproval({
      id: `multi-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: "edit",
      title: `Edit ${validated.length} file(s)`,
      description: `Files: ${fileList}`,
      primaryAction: "Apply all edits",
      secondaryAction: "Reject",
      details: {
        files: fileList,
        count: validated.length,
      },
    });

    if (!approved) {
      return { ok: false, error: "User rejected multi-edit" };
    }

    const results: Array<{ path: string; changed: boolean }> = [];
    for (const v of validated) {
      const doc = await vscode.workspace.openTextDocument(v.uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(v.current.length));
      const next = v.current.replace(v.oldText, v.newText);
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.replace(v.uri, fullRange, next);
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) await doc.save();
      results.push({ path: v.rel, changed: ok });
    }

    return { ok: true, data: { edits: results } };
  },
};
