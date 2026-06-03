import * as vscode from "vscode";
import { gatherSmartContext, type SmartContextResult } from "./context/smartContext";

export interface WorkspaceContext {
  workspaceName?: string;
  filePath?: string;
  language?: string;
  selection?: string;
  fullText?: string;
  smartContext?: SmartContextResult;
}

const MAX_FILE_CHARS = 8000;
const MAX_SELECTION_CHARS = 4000;

export async function gatherContext(): Promise<WorkspaceContext> {
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

export async function gatherSmartWorkspaceContext(userMessage: string): Promise<WorkspaceContext> {
  const ctx = await gatherContext();

  try {
    ctx.smartContext = await gatherSmartContext(userMessage, ctx.filePath);
  } catch {
    ctx.smartContext = undefined;
  }

  return ctx;
}

export function buildSystemPrompt(ctx: WorkspaceContext): string {
  const parts: string[] = [
    "You are Shogo, an AI coding assistant in VS Code. Answer concisely. Use Markdown with fenced code blocks.",
    "When editing files, you MUST read them first. Never guess file contents.",
    "Always use tools (readFile, applyPatch, etc.) to inspect and modify the workspace.",
  ];

  if (ctx.workspaceName) {
    parts.push(`The user's workspace is named "${ctx.workspaceName}".`);
  }

  if (ctx.smartContext) {
    const sc = ctx.smartContext;

    if (sc.projectTree) {
      parts.push(`PROJECT STRUCTURE:\n\`\`\`\n${sc.projectTree}\n\`\`\``);
    }

    if (sc.relevantFiles.length > 0) {
      const fileList = sc.relevantFiles
        .map((f) => `  - ${f.path} (${f.reason})`)
        .join("\n");
      parts.push(`RELEVANT FILES (ranked by relevance to your query):\n${fileList}`);
    }

    if (sc.recentChanges.length > 0) {
      const changeList = sc.recentChanges
        .map((c) => `  - ${c.status}: ${c.path}`)
        .join("\n");
      parts.push(`RECENT GIT CHANGES:\n${changeList}`);
    }
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

  return parts.join("\n\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "\n... [truncated]";
}
