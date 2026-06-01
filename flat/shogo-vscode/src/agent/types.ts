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

export interface ToolExecutionContext {
  extensionContext: vscode.ExtensionContext;
  signal?: AbortSignal;
  postActivity?: (text: string) => void;
}

export interface ParsedToolCall {
  tool: string;
  input: Record<string, unknown>;
}
