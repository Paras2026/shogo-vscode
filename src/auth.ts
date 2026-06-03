import * as vscode from "vscode";

const SECRET_KEY = "shogo.apiKey";

export async function getApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setApiKey(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: "Shogo API Key",
    prompt: "Paste your Shogo Cloud API key (starts with shogo_sk_)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "shogo_sk_...",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "API key cannot be empty";
      }
      if (!value.startsWith("shogo_sk_")) {
        return "Expected a key starting with 'shogo_sk_'";
      }
      return undefined;
    },
  });

  if (!key) {
    return false;
  }

  await context.secrets.store(SECRET_KEY, key.trim());
  return true;
}

export async function clearApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}
