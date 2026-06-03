import * as vscode from "vscode";

export interface WorkspaceContext {
  workspaceName?: string;
  filePath?: string;
  language?: string;
  selection?: string;
  fullText?: string;
  extraInstructions?: string;
}

const MAX_FILE_CHARS = 4000;
const MAX_SELECTION_CHARS = 2000;

export function gatherContext(): WorkspaceContext {
  const ctx: WorkspaceContext = {};

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    ctx.workspaceName = folders[0].name;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    ctx.filePath = vscode.workspace.asRelativePath(doc.uri);
    ctx.language = doc.languageId;

    const selectedText = doc.getText(editor.selection);
    if (selectedText && selectedText.trim().length > 0) {
      ctx.selection = truncate(selectedText, MAX_SELECTION_CHARS);
    } else {
      ctx.fullText = truncate(doc.getText(), MAX_FILE_CHARS);
    }
  }

  return ctx;
}

export function buildSystemPrompt(ctx: WorkspaceContext): string {
  const parts: string[] = [
    "You are Shogo, an AI coding assistant in VS Code. Answer concisely. Use Markdown with fenced code blocks.",
    "For workspace actions, use local tools instead of claiming you performed work from text alone.",
  ];

  if (ctx.workspaceName) {
    parts.push(`The user's workspace is named "${ctx.workspaceName}".`);
  }
  if (ctx.filePath) {
    parts.push(`The active file is "${ctx.filePath}" (${ctx.language}).`);
  }
  if (ctx.selection) {
    parts.push(
      `The user has selected this code:\n\n\`\`\`${ctx.language ?? ""}\n${ctx.selection}\n\`\`\``
    );
  } else if (ctx.fullText) {
    parts.push(
      `Here is the content of the active file:\n\n\`\`\`${ctx.language ?? ""}\n${ctx.fullText}\n\`\`\``
    );
  }
  if (ctx.extraInstructions) {
    parts.push(ctx.extraInstructions);
  }

  return parts.join("\n\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "\n... [truncated]";
}
