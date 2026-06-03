import * as vscode from "vscode";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export type ApprovalKind = "command" | "edit";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  primaryAction: string;
  secondaryAction?: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface ToolExecutionContext {
  extensionContext: vscode.ExtensionContext;
  signal?: AbortSignal;
  postActivity?: (text: string) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
}
