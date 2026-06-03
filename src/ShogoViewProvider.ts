import * as vscode from "vscode";
import { getApiKey, setApiKey } from "./auth";
import { runAgentLoop } from "./agent/agentLoop";
import type { ApprovalRequest } from "./agent/types";
import { buildSystemPrompt, gatherSmartWorkspaceContext } from "./context";
import type { ChatMessage } from "./shogoClient";

export class ShogoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "shogo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

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
          break;
        case "prompt":
          await this.handlePrompt(msg.text);
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
      }
    });
  }

  public newChat(): void {
    this.abortController?.abort();
    this.rejectAllApprovals();
    this.history = [];
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

  private async handlePrompt(text: string): Promise<void> {
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
    const model = config.get<string>("model", "claude-sonnet-4-5");
    const includeFile = config.get<boolean>("includeActiveFile", true);
    const apiUrl = config.get<string>("apiUrl", "");

    const ctx = includeFile ? await gatherSmartWorkspaceContext(trimmed) : { workspaceName: undefined };
    const system = buildSystemPrompt(ctx);

    this.history.push({ role: "user", content: trimmed });
    this.post({ type: "userMessage", text: trimmed });
    this.post({ type: "assistantStart" });

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
        signal: this.abortController.signal,
        onActivity: (text) => {
          this.post({ type: "toolActivity", text });
        },
        onFinalToken: (chunk) => {
          this.post({ type: "assistantToken", text: chunk });
        },
        requestApproval: (request) => this.requestApproval(request),
      });
      this.history.push({ role: "assistant", content: assistantText });
    } catch (err: unknown) {
      const message = this.describeError(err);
      this.post({ type: "error", text: message });
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

  private rejectAllApprovals(): void {
    for (const resolve of this.pendingApprovals.values()) {
      resolve(false);
    }
    this.pendingApprovals.clear();
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
  <div id="messages"></div>
  <div id="composer">
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
