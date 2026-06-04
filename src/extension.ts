import * as vscode from "vscode";
import * as fs from "fs";
import { clearApiKey, setApiKey } from "./auth";
import { ShogoViewProvider } from "./ShogoViewProvider";
import { getLogFile, initLogger, logInfo, logDebug } from "./logger";
import { getEnvironmentContext } from "./context/environmentContext";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger();
  logInfo("Extension activating");

  // Detect environment at startup (cached for all subsequent calls)
  logDebug("Detecting environment...");
  const env = await getEnvironmentContext();
  logDebug(`Environment ready: ${env.os} ${env.arch}, shell=${env.shell}, SSH=${env.isRemoteSSH}`);

  const provider = new ShogoViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ShogoViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shogo.setApiKey", async () => {
      const ok = await setApiKey(context);
      if (ok) {
        await provider.refreshAuthState();
        vscode.window.showInformationMessage("Shogo API key saved.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shogo.clearApiKey", async () => {
      await clearApiKey(context);
      await provider.refreshAuthState();
      vscode.window.showInformationMessage("Shogo API key cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shogo.newChat", () => {
      provider.newChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shogo.showLogs", async () => {
      const logFile = getLogFile();
      if (logFile && fs.existsSync(logFile)) {
        const doc = await vscode.workspace.openTextDocument(logFile);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage("No Shogo log file found yet. Send a message first.");
      }
    })
  );

  logInfo("Extension activated — all commands registered");
}
