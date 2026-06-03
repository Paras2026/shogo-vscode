import * as vscode from "vscode";
import type { ChatMessage } from "../shogoClient";
import { getWorkspaceRoot } from "../tools/workspace";

interface SessionSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export class SessionStore {
  private sessionId = createSessionId();
  private createdAt = new Date().toISOString();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public reset(): void {
    this.sessionId = createSessionId();
    this.createdAt = new Date().toISOString();
  }

  public async save(messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const snapshot: SessionSnapshot = {
      id: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      messages,
    };

    const dir = await this.getHistoryDirectory();
    await vscode.workspace.fs.createDirectory(dir);
    const jsonUri = vscode.Uri.joinPath(dir, `${this.sessionId}.json`);
    const mdUri = vscode.Uri.joinPath(dir, `${this.sessionId}.md`);
    await vscode.workspace.fs.writeFile(jsonUri, Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"));
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(renderMarkdown(snapshot), "utf8"));
    await this.context.workspaceState.update("shogo.lastSessionId", this.sessionId);
  }

  private async getHistoryDirectory(): Promise<vscode.Uri> {
    const root = getWorkspaceRoot();
    if (root) {
      return vscode.Uri.joinPath(root.uri, ".shogo", "history");
    }
    return vscode.Uri.joinPath(this.context.globalStorageUri, "history");
  }
}

function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `chat-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderMarkdown(snapshot: SessionSnapshot): string {
  const lines = [
    `# Shogo Chat ${snapshot.id}`,
    "",
    `Created: ${snapshot.createdAt}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
  ];

  for (const message of snapshot.messages) {
    lines.push(`## ${message.role === "user" ? "User" : "Shogo"}`, "", message.content, "");
  }

  return lines.join("\n");
}
