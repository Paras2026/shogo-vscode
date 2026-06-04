import * as vscode from "vscode";
import { getApiKey, setApiKey } from "./auth";
import { runAgentLoop } from "./agent/agentLoop";
import type { ApprovalRequest } from "./agent/types";
import { buildSystemPrompt, gatherSmartWorkspaceContext } from "./context";
import type { ChatMessage } from "./shogoClient";
import { logInfo, logError, logDebug, logWarn, initLogger, showOutputChannel } from "./logger";

interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

const MAX_SESSIONS = 50;
const SESSIONS_KEY = "shogo.sessions";

export class ShogoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "shogo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private currentSessionId?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    initLogger();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    logDebug("Webview view resolved");

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
      logDebug(`Webview → Extension: ${msg.type}${msg.text ? " (\"" + String(msg.text).slice(0, 60) + "\")" : ""}${msg.model ? " model=" + msg.model : ""}`);
      switch (msg.type) {
        case "ready":
          logDebug("Webview ready — sending auth state");
          await this.refreshAuthState();
          break;
        case "prompt":
          logInfo(`Prompt received: "${(msg.text ?? "").slice(0, 80)}" model=${msg.model || "default"}`);
          await this.handlePrompt(msg.text, msg.model);
          break;
        case "setKey":
          await this.handleSetKey();
          break;
        case "stop":
          logInfo("Stop requested by user");
          this.abortController?.abort();
          this.rejectAllApprovals();
          break;
        case "approvalResponse":
          logInfo(`Approval response: id=${msg.id} approved=${msg.approved}`);
          this.handleApprovalResponse(msg.id, !!msg.approved);
          break;
        case "newChat":
          logInfo("New chat requested");
          this.newChat();
          break;
        case "openFile":
          await this.handleOpenFile(msg.path, msg.line);
          break;
        case "listSessions":
          this.handleListSessions();
          break;
        case "loadSession":
          this.handleLoadSession(msg.sessionId);
          break;
        case "deleteSession":
          this.handleDeleteSession(msg.sessionId);
          break;
        default:
          logWarn(`Unknown message type from webview: ${msg.type}`);
      }
      } catch (handlerErr) {
        logError(`Message handler crashed for type="${msg.type}"`, handlerErr);
        try {
          this.post({ type: "error", text: `Internal error: ${handlerErr}` });
        } catch {}
      }
    });
  }

  public newChat(): void {
    this.abortController?.abort();
    this.rejectAllApprovals();
    this.saveCurrentSession();
    this.history = [];
    this.currentSessionId = undefined;
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

    logInfo(`User prompt: "${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}"`);

    logDebug("Step 1: Checking API key...");
    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      logError("No API key set");
      this.post({
        type: "error",
        text: "No API key set. Click 'Set API Key' to continue.",
      });
      await this.refreshAuthState();
      return;
    }
    logDebug("Step 1 done: API key exists");

    logDebug("Step 2: Reading config...");
    const config = vscode.workspace.getConfiguration("shogo");
    const model = modelOverride || config.get<string>("model", "claude-sonnet-4-5");
    const includeFile = config.get<boolean>("includeActiveFile", true);
    const apiUrl = config.get<string>("apiUrl", "");
    logDebug(`Step 2 done: model=${model}, includeFile=${includeFile}, apiUrl=${apiUrl || "(default)"}`);

    logDebug("Step 3: Gathering workspace context...");
    let ctx;
    try {
      ctx = includeFile ? await gatherSmartWorkspaceContext(trimmed) : { workspaceName: undefined };
    } catch (ctxErr) {
      logError("Step 3 FAILED: gatherSmartWorkspaceContext threw", ctxErr);
      this.post({ type: "error", text: `Context gathering failed: ${ctxErr}` });
      this.post({ type: "assistantEnd" });
      return;
    }
    logDebug("Step 3 done: context gathered");

    logDebug("Step 4: Building system prompt...");
    const system = buildSystemPrompt(ctx);
    logDebug(`Step 4 done: system prompt ${system.length} chars`);

    this.history.push({ role: "user", content: trimmed });
    this.post({ type: "userMessage", text: trimmed });
    this.post({ type: "assistantStart" });
    logDebug("Step 5: Posted userMessage + assistantStart to webview");

    this.abortController = new AbortController();
    let assistantText = "";

    try {
      logDebug("Step 6: Calling runAgentLoop...");
      assistantText = await runAgentLoop({
        apiKey,
        model,
        apiUrl: apiUrl || undefined,
        system,
        messages: this.history,
        extensionContext: this.context,
        signal: this.abortController.signal,
        onActivity: (text) => {
          this.post({ type: "toolActivity", text });
        },
        onFinalToken: (chunk) => {
          this.post({ type: "assistantToken", text: chunk });
        },
        requestApproval: (request) => this.requestApproval(request),
      });
      logDebug(`Step 6 done: runAgentLoop returned ${assistantText.length} chars`);
      this.history.push({ role: "assistant", content: assistantText });
    } catch (err: unknown) {
      logError("Agent loop failed", err);
      const message = this.describeError(err);
      this.post({ type: "error", text: message });
      showOutputChannel();
    } finally {
      this.post({ type: "assistantEnd" });
      this.abortController = undefined;
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
    if (typeof id !== "string") {
      return;
    }
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) {
      return;
    }
    this.pendingApprovals.delete(id);
    resolve(approved);
  }

  private async handleOpenFile(filePath: string, line?: number): Promise<void> {
    logInfo(`handleOpenFile called: path="${filePath}", line=${line} (type: ${typeof line})`);
    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) {
        logError("No workspace folder found for openFile");
        return;
      }
      const fileUri = vscode.Uri.joinPath(root.uri, filePath);
      logInfo(`Opening: ${fileUri.fsPath}`);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });

      if (typeof line === "number" && line >= 1) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        logInfo(`Jumped to line ${line} in ${filePath}`);
      } else {
        logInfo(`No line number to jump to (line=${line}, type=${typeof line})`);
      }
    } catch (err) {
      logError(`Failed to open file: ${filePath}`, err);
      vscode.window.showWarningMessage(`Could not open ${filePath}`);
    }
  }

  private rejectAllApprovals(): void {
    for (const resolve of this.pendingApprovals.values()) {
      resolve(false);
    }
    this.pendingApprovals.clear();
  }

  // ── Session Persistence ──

  private getSessions(): Session[] {
    return this.context.globalState.get<Session[]>(SESSIONS_KEY, []);
  }

  private async saveSessions(sessions: Session[]): Promise<void> {
    await this.context.globalState.update(SESSIONS_KEY, sessions);
  }

  private saveCurrentSession(): void {
    if (this.history.length === 0) return;

    const sessions = this.getSessions();
    const title = this.history[0]?.content?.slice(0, 50) || "Untitled";

    if (this.currentSessionId) {
      const idx = sessions.findIndex((s) => s.id === this.currentSessionId);
      if (idx >= 0) {
        sessions[idx].messages = [...this.history];
        sessions[idx].title = title;
      }
    } else {
      const session: Session = {
        id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        messages: [...this.history],
        createdAt: Date.now(),
      };
      sessions.unshift(session);
    }

    while (sessions.length > MAX_SESSIONS) sessions.pop();
    this.saveSessions(sessions);
  }

  private handleListSessions(): void {
    const sessions = this.getSessions();
    this.post({
      type: "sessionList",
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
      })),
    });
  }

  private handleLoadSession(sessionId: string): void {
    const sessions = this.getSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      this.post({ type: "error", text: "Session not found." });
      return;
    }

    this.abortController?.abort();
    this.rejectAllApprovals();

    this.currentSessionId = session.id;
    this.history = [...session.messages];
    this.post({ type: "clear" });

    for (const msg of session.messages) {
      if (msg.role === "user") {
        this.post({ type: "userMessage", text: msg.content });
      } else if (msg.role === "assistant") {
        this.post({ type: "assistantStart" });
        this.post({ type: "assistantToken", text: msg.content });
        this.post({ type: "assistantEnd" });
      }
    }

    logInfo(`Loaded session: ${session.title} (${session.messages.length} messages)`);
  }

  private handleDeleteSession(sessionId: string): void {
    const sessions = this.getSessions().filter((s) => s.id !== sessionId);
    this.saveSessions(sessions);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = undefined;
    }
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return "Generation stopped.";
      }
      const m = err.message || "";
      if (m.includes("401") || /unauthor/i.test(m)) {
        return "Authentication failed (401). Check your Shogo API key.";
      }
      if (m.includes("429")) {
        return "Rate limited (429). Please wait and try again.";
      }
      if (m.includes("no output") || m.includes("returned no output")) {
        return `⚠️ Model unavailable: ${m}`;
      }
      if (m.includes("timed out")) {
        return `⏱️ ${m}`;
      }
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
    html, body { height: 100%; margin: 0; overflow: hidden; }
  </style>
  <title>Shogo Chat</title>
</head>
<body>
  <div id="header">
    <div id="header-left">
      <span id="header-logo">⚡ Shogo</span>
    </div>
    <div style="display:flex;gap:4px;align-items:center;">
      <button id="history-btn" title="Chat History">☰</button>
      <button id="new-chat-btn" title="New Chat">＋</button>
    </div>
  </div>
  <div id="history-drawer"></div>
  <div id="auth-banner">
    <p>Set your Shogo Cloud API key to start chatting.</p>
    <button id="set-key-btn">Set API Key</button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div class="composer-top">
      <select id="model-select">
        <option value="mimo-v2.5">Hoshi 1.0</option>
        <option value="hoshi-1.0">Hoshi 1.0 (alt ID)</option>
        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
        <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
      </select>
    </div>
    <textarea id="input" rows="2" placeholder="Ask Shogo... (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="composer-actions">
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
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
