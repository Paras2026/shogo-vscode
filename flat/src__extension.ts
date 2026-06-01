import * as vscode from "vscode";
import { clearApiKey, setApiKey } from "./auth";
import { ShogoViewProvider } from "./ShogoViewProvider";

export function activate(context: vscode.ExtensionContext): void {
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
}

export function deactivate(): void {
  // nothing to clean up
}
