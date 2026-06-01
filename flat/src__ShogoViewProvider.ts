import * as vscode from "vscode";
import { getApiKey, setApiKey } from "./auth";
import { buildSystemPrompt, gatherContext } from "./context";
import { streamChat, type ChatMessage } from "./shogoClient";

export class ShogoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "shogo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;

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
          break;
      }
    });
  }

  public newChat(): void {
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

    const ctx = includeFile ? gatherContext() : { workspaceName: undefined };
    const system = buildSystemPrompt(ctx);

    this.history.push({ role: "user", content: trimmed });
    this.post({ type: "userMessage", text: trimmed });
    this.post({ type: "assistantStart" });

    this.abortController = new AbortController();
    let assistantText = "";

    try {
      assistantText = await streamChat({
        apiKey,
        model,
        apiUrl: apiUrl || undefined,
        system,
        messages: this.history,
        signal: this.abortController.signal,
        onToken: (chunk) => {
          this.post({ type: "assistantToken", text: chunk });
        },
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Shogo Chat</title>
</head>
<body>
  <div id="auth-banner" class="hidden">
    <p>Set your Shogo Cloud API key to start chatting.</p>
    <button id="set-key-btn">Set API Key</button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Ask Shogo..."></textarea>
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
