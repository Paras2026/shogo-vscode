import * as vscode from "vscode";
import type { ChatMessage } from "../shogoClient";
import { getWorkspaceRoot } from "../tools/workspace";

interface SessionSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class SessionStore {
  private sessionId = createSessionId();
  private createdAt = new Date().toISOString();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public reset(): void {
    this.sessionId = createSessionId();
    this.createdAt = new Date().toISOString();
  }

  public async save(messages: ChatMessage[], title?: string): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const snapshot: SessionSnapshot = {
      id: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      title,
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

  public async listSessions(): Promise<SessionSummary[]> {
    const dir = await this.getHistoryDirectory();
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const sessions: SessionSummary[] = [];
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        try {
          const uri = vscode.Uri.joinPath(dir, name);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const snapshot = JSON.parse(Buffer.from(bytes).toString("utf8")) as SessionSnapshot;
          sessions.push({
            id: snapshot.id,
            title: snapshot.title ?? generateTitleFromMessages(snapshot.messages),
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            messageCount: snapshot.messages.length,
          });
        } catch {
          continue;
        }
      }
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sessions;
    } catch {
      return [];
    }
  }

  public async loadSession(sessionId: string): Promise<ChatMessage[]> {
    const dir = await this.getHistoryDirectory();
    const uri = vscode.Uri.joinPath(dir, `${sessionId}.json`);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const snapshot = JSON.parse(Buffer.from(bytes).toString("utf8")) as SessionSnapshot;
    this.sessionId = snapshot.id;
    this.createdAt = snapshot.createdAt;
    return snapshot.messages;
  }

  public async exportSessionMarkdown(sessionId: string): Promise<string | undefined> {
    const dir = await this.getHistoryDirectory();
    const uri = vscode.Uri.joinPath(dir, `${sessionId}.md`);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return undefined;
    }
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

function generateTitleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "Empty chat";
  const text = firstUser.content.slice(0, 60).replace(/\n/g, " ");
  return text.length < firstUser.content.length ? text + "…" : text;
}

function renderMarkdown(snapshot: SessionSnapshot): string {
  const lines = [
    `# Shogo Chat ${snapshot.title ?? snapshot.id}`,
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
