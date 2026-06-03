import * as vscode from "vscode";
import { getApiKey, setApiKey } from "./auth";
import { runAgentLoop } from "./agent/agentLoop";
import { buildConfigInstructions, loadAgentConfig } from "./agent/config";
import { SessionStore, type SessionSummary } from "./agent/sessionStore";
import type { ApprovalRequest } from "./agent/types";
import { buildSystemPrompt, gatherContext } from "./context";
import type { ChatMessage } from "./shogoClient";

const AVAILABLE_MODELS = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-4o",
  "gpt-4o-mini",
];

export class ShogoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "shogo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private currentTitle?: string;
  private readonly sessionStore: SessionStore;
  private abortController?: AbortController;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sessionStore = new SessionStore(context);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.refreshAuthState();
          this.post({ type: "models", models: AVAILABLE_MODELS });
          await this.sendSessionList();
          break;
        case "prompt":
          await this.handlePrompt(msg.text, msg.model);
          break;
        case "setKey":
          await this.handleSetKey();
          break;
        case "stop":
          this.abortController?.abort();
          this.rejectAllApprovals();
          break;
        case "approvalResponse":
          this.handleApprovalResponse(msg.id, !!msg.approved);
          break;
        case "approveAll":
          this.resolveAllApprovals(true);
          break;
        case "rejectAll":
          this.resolveAllApprovals(false);
          break;
        case "newChat":
          this.newChat();
          break;
        case "listSessions":
          await this.sendSessionList();
          break;
        case "loadSession":
          await this.handleLoadSession(msg.sessionId);
          break;
        case "exportChat":
          await this.handleExportChat();
          break;
        case "openFile":
          await this.handleOpenFile(msg.path);
          break;
      }
    });
  }

  public newChat(): void {
    this.abortController?.abort();
    this.rejectAllApprovals();
    this.history = [];
    this.currentTitle = undefined;
    this.sessionStore.reset();
    this.post({ type: "clear" });
  }

  public async refreshAuthState(): Promise<void> {
    const key = await getApiKey(this.context);
    this.post({ type: "authState", hasKey: !!key });
  }

  private async handleSetKey(): Promise<void> {
    const ok = await setApiKey(this.context);
    if (ok) {
      await this.refreshAuthState();
    }
  }

  private async handlePrompt(text: string, modelOverride?: string): Promise<void> {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      return;
    }

    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      this.post({
        type: "error",
        text: "No API key set. Click 'Set API Key' to continue.",
      });
      await this.refreshAuthState();
      return;
    }

    const config = vscode.workspace.getConfiguration("shogo");
    const model = modelOverride || config.get<string>("model", "claude-sonnet-4-5");
    const includeFile = config.get<boolean>("includeActiveFile", true);
    const apiUrl = config.get<string>("apiUrl", "");
    const agentConfig = await loadAgentConfig();

    const ctx = includeFile ? gatherContext() : { workspaceName: undefined };
    ctx.extraInstructions = buildConfigInstructions(agentConfig);

    const resolved = await this.resolveMentions(trimmed);
    const system = buildSystemPrompt(ctx);

    this.history.push({ role: "user", content: resolved });
    this.post({ type: "userMessage", text: trimmed });
    this.post({ type: "assistantStart" });

    if (!this.currentTitle) {
      this.currentTitle = trimmed.slice(0, 60).replace(/\n/g, " ");
      this.post({ type: "chatTitle", title: this.currentTitle });
    }

    this.abortController = new AbortController();
    let assistantText = "";

    try {
      assistantText = await runAgentLoop({
        apiKey,
        model,
        apiUrl: apiUrl || undefined,
        system,
        messages: this.history,
        extensionContext: this.context,
        maxSteps: agentConfig.maxToolSteps,
        signal: this.abortController.signal,
        onActivity: (text) => {
          this.post({ type: "toolActivity", text });
        },
        onFinalToken: (chunk) => {
          this.post({ type: "assistantToken", text: chunk });
        },
        onTokenUsage: (usage) => {
          this.post({ type: "tokenUsage", usage });
        },
        requestApproval: (request) => this.requestApproval(request),
      });
      this.history.push({ role: "assistant", content: assistantText });
      await this.sessionStore.save(this.history, this.currentTitle);
    } catch (err: unknown) {
      const message = this.describeError(err);
      this.post({ type: "error", text: message });
    } finally {
      this.post({ type: "assistantEnd" });
      this.abortController = undefined;
    }
  }

  private async resolveMentions(text: string): Promise<string> {
    const mentionRegex = /@([^\s@]+)/g;
    let resolved = text;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
      const filePath = match[1];
      try {
        const { normalizeRelativePath, resolveWorkspacePath } = await import("./tools/workspace");
        const rel = normalizeRelativePath(filePath);
        const uri = resolveWorkspacePath(rel);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf8");
        resolved = resolved.replace(match[0], `@${filePath}:\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        resolved = resolved.replace(match[0], `@${filePath}: [file not found]`);
      }
    }

    return resolved;
  }

  private async sendSessionList(): Promise<void> {
    const sessions = await this.sessionStore.listSessions();
    this.post({ type: "sessionList", sessions });
  }

  private async handleLoadSession(sessionId: string): Promise<void> {
    try {
      const messages = await this.sessionStore.loadSession(sessionId);
      this.history = [...messages];
      this.currentTitle = messages.find((m) => m.role === "user")?.content.slice(0, 60);
      this.post({ type: "loadHistory", messages, title: this.currentTitle });
    } catch (err) {
      this.post({ type: "error", text: `Failed to load session: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  private async handleExportChat(): Promise<void> {
    const content = this.history.map((m) => {
      const role = m.role === "user" ? "## You" : "## Shogo";
      return `${role}\n\n${m.content}`;
    }).join("\n\n---\n\n");

    const md = `# Shogo Chat\n\n${content}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("shogo-chat.md"),
      filters: { Markdown: ["md"] },
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf8"));
      vscode.window.showInformationMessage("Chat exported!");
    }
  }

  private async handleOpenFile(filePath: string): Promise<void> {
    try {
      const { normalizeRelativePath, resolveWorkspacePath } = await import("./tools/workspace");
      const rel = normalizeRelativePath(filePath);
      const uri = resolveWorkspacePath(rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (!this.view) {
      return Promise.resolve(false);
    }

    this.post({ type: "approvalRequest", request });
    return new Promise((resolve) => {
      this.pendingApprovals.set(request.id, resolve);
    });
  }

  private handleApprovalResponse(id: unknown, approved: boolean): void {
    if (typeof id !== "string") return;
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    resolve(approved);
  }

  private resolveAllApprovals(approved: boolean): void {
    for (const [id, resolve] of this.pendingApprovals) {
      resolve(approved);
      this.post({ type: "approvalResponse", id, approved });
    }
    this.pendingApprovals.clear();
  }

  private rejectAllApprovals(): void {
    for (const resolve of this.pendingApprovals.values()) {
      resolve(false);
    }
    this.pendingApprovals.clear();
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === "AbortError") return "Generation stopped.";
      const m = err.message || "";
      if (m.includes("401") || /unauthor/i.test(m)) return "Authentication failed (401). Check your Shogo API key.";
      if (m.includes("429")) return "Rate limited (429). Please wait and try again.";
      return `Error: ${m}`;
    }
    return "An unknown error occurred.";
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <style nonce="${nonce}">
    html, body { height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; min-height: 100vh;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family); }
    #messages { flex: 1 1 auto; overflow-y: auto; padding: 12px; }
    #composer { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border, #555);
      padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    #input { width: 100%; min-height: 40px; box-sizing: border-box;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, #888); border-radius: 4px; padding: 6px; }
    .composer-actions { display: flex; justify-content: flex-end; gap: 6px; }
    button { padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #auth-banner { margin: 12px; padding: 12px; border: 1px solid var(--vscode-focusBorder, #888); border-radius: 6px; }
    .hidden { display: none !important; }
  </style>
  <title>Shogo Chat</title>
</head>
<body>
  <div id="auth-banner">
    <p>Set your Shogo Cloud API key to start chatting.</p>
    <button id="set-key-btn">Set API Key</button>
  </div>
  <div id="session-panel" class="hidden">
    <div id="session-header">
      <span id="session-title-display"></span>
      <div id="session-actions">
        <button id="history-btn" title="History">☰</button>
        <button id="export-btn" title="Export">↗</button>
        <button id="clear-btn" title="New Chat">✕</button>
      </div>
    </div>
  </div>
  <div id="session-list" class="hidden"></div>
  <div id="messages"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Ask Shogo... (Enter to send)"></textarea>
    <div class="composer-actions">
      <select id="model-select" title="Model"></select>
      <button id="send-btn" title="Send">Send</button>
      <button id="stop-btn" class="hidden" title="Stop">Stop</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
