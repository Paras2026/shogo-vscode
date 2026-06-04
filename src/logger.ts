import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

let outputChannel: vscode.OutputChannel | undefined;
let logFile: string | undefined;

export function initLogger(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Shogo Agent");
  }
  try {
    const logDir = path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".shogo-logs"
    );
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    logFile = path.join(logDir, `shogo-${date}.log`);
  } catch {
    // File logging is best-effort
  }
}

function writeToFile(line: string): void {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + "\n", { flag: "a" });
  } catch {
    // Best-effort
  }
}

export function logInfo(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] INFO  ${msg}`;
  outputChannel?.appendLine(line);
  writeToFile(line);
}

export function logWarn(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] WARN  ${msg}`;
  outputChannel?.appendLine(line);
  writeToFile(line);
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
  const line = `[${ts}] ERROR ${msg}${detail}`;
  outputChannel?.appendLine(line);
  writeToFile(line);
}

export function logDebug(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] DEBUG ${msg}`;
  outputChannel?.appendLine(line);
  writeToFile(line);
}

export function getLogFile(): string | undefined {
  return logFile;
}

export function showOutputChannel(): void {
  outputChannel?.show(true);
}
