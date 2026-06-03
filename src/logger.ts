import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Shogo Agent");
  }
}

export function logInfo(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  outputChannel?.appendLine(`[${ts}] INFO  ${msg}`);
}

export function logWarn(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  outputChannel?.appendLine(`[${ts}] WARN  ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  let detail = "";
  if (err instanceof Error) {
    detail = ` | ${err.name}: ${err.message}`;
    if (err.stack) {
      const stackLine = err.stack.split("\n").find((l) => l.includes("at "));
      if (stackLine) detail += ` @ ${stackLine.trim()}`;
    }
  } else if (err !== undefined) {
    detail = ` | ${String(err)}`;
  }
  outputChannel?.appendLine(`[${ts}] ERROR ${msg}${detail}`);
}

export function logDebug(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  outputChannel?.appendLine(`[${ts}] DEBUG ${msg}`);
}

export function showOutputChannel(): void {
  outputChannel?.show(true);
}
