import * as vscode from "vscode";
import { gatherSmartContext, type SmartContextResult } from "./context/smartContext";
import { getEnvironmentContext, formatEnvironmentForPrompt, type EnvironmentContext } from "./context/environmentContext";
import { getProjectMap } from "./context/backgroundIndexer";
import { logWarn, logDebug } from "./logger";

export interface WorkspaceContext {
  workspaceName?: string;
  filePath?: string;
  language?: string;
  selection?: string;
  fullText?: string;
  smartContext?: SmartContextResult;
  environment?: EnvironmentContext;
}

const MAX_FILE_CHARS = 8000;
const MAX_SELECTION_CHARS = 4000;

// Cache: smart context only needs to run once per workspace session
let cachedSmartContext: SmartContextResult | undefined = undefined;
let smartContextFetched = false;

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

  // Detect environment (cached after first call)
  try {
    ctx.environment = await getEnvironmentContext();
  } catch {
    ctx.environment = undefined;
  }

  // Return cached smart context if already fetched
  if (smartContextFetched) {
    ctx.smartContext = cachedSmartContext;
    return ctx;
  }

  try {
    ctx.smartContext = await Promise.race([
      gatherSmartContext(userMessage, ctx.filePath),
      new Promise<undefined>((resolve) =>
        setTimeout(() => {
          logWarn("Smart context gathering timed out after 2s — skipping");
          resolve(undefined);
        }, 2000)
      ),
    ]);

    // Cache the result so subsequent messages don't wait
    if (ctx.smartContext) {
      cachedSmartContext = ctx.smartContext;
      smartContextFetched = true;
      logDebug("Smart context cached for session");
    }
  } catch {
    ctx.smartContext = undefined;
  }

  return ctx;
}

export function buildSystemPrompt(ctx: WorkspaceContext): string {
  // Use the new production system prompt if available
  try {
    const { buildFullSystemPrompt } = require("./agent/systemPrompt");
    return buildFullSystemPrompt(ctx);
  } catch {
    // Fallback to legacy prompt if import fails
  }

  const parts: string[] = [
    "You are Shogo, an AI coding assistant in VS Code. Answer concisely. Use Markdown with fenced code blocks.",
    "When editing files, you MUST read them first. Never guess file contents.",
    "Always use tools (readFile, applyPatch, etc.) to inspect and modify the workspace.",
    "",
    "## Large Codebase Rules (500+ line files)",
    "- NEVER read an entire large file at once. Use readFile with startLine/endLine.",
    "- For large projects: call projectMap FIRST to understand the structure, then searchWorkspace to find relevant code, then readFile with line ranges.",
    "- When editing a function, read only 20-30 lines around it, not the whole file.",
    "- Use the line numbers in readFile output to target applyPatch precisely.",
    "- Workflow: projectMap -> searchWorkspace -> readFile(startLine, endLine) -> applyPatch",
    "",
    "## Code Graph Tools",
    "- buildCallGraph: Build the call graph first before using graph tools",
    "- impactAnalysis(function): Find what breaks if you change a function",
    "- deadCode: Find unused functions that can be removed",
    "- callChain(from, to): Trace execution path between two functions",
  ];

  if (ctx.workspaceName) {
    parts.push(`The user's workspace is named "${ctx.workspaceName}".`);
  }

  if (ctx.environment) {
    parts.push(formatEnvironmentForPrompt(ctx.environment));
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

  // Use background indexer data (instant, pre-cached)
  const projectMap = getProjectMap();
  if (projectMap) {
    const topExports = projectMap.files
      .filter((f) => f.symbols.length > 0)
      .slice(0, 100)
      .map((f) => `  ${f.path} [${f.language}, ${f.lines}L] → ${f.symbols.slice(0, 8).join(", ")}`)
      .join("\n");
    if (topExports) {
      parts.push(`PRE-INDEXED PROJECT MAP (${projectMap.fileCount} files, ${projectMap.totalLines} lines):\n${topExports}`);
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
