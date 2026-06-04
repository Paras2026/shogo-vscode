/**
 * Enhanced LSP Tools — Signature help, code actions, workspace symbols.
 * These leverage VS Code's built-in language intelligence for zero-config
 * semantic understanding across any language.
 */
import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";

function getWorkspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function resolveFileUri(file: string): vscode.Uri | null {
  const root = getWorkspaceRoot();
  if (!root) return null;
  return vscode.Uri.joinPath(root, ...file.split("/"));
}

async function openDoc(fileUri: vscode.Uri): Promise<vscode.TextDocument | null> {
  try {
    return await vscode.workspace.openTextDocument(fileUri);
  } catch {
    return null;
  }
}

function findSymbolPosition(
  doc: vscode.TextDocument,
  symbol: string,
  line?: number,
): vscode.Position | null {
  const text = doc.getText();
  const lines = text.split("\n");
  
  // Start searching from the specified line (or beginning)
  const startLine = typeof line === "number" ? Math.max(0, line - 1) : 0;
  
  for (let i = startLine; i < lines.length; i++) {
    const idx = lines[i].indexOf(symbol, i === startLine ? 0 : 0);
    if (idx >= 0) {
      return new vscode.Position(i, idx);
    }
  }
  
  // If not found from start line, try from beginning
  if (startLine > 0) {
    for (let i = 0; i < startLine; i++) {
      const idx = lines[i].indexOf(symbol);
      if (idx >= 0) return new vscode.Position(i, idx);
    }
  }
  
  return null;
}

// ── Signature Help ──

export const getSignatureHelpTool: ToolDefinition = {
  name: "getSignatureHelp",
  description:
    "Get function/method signature help (parameter types, overloads) at a specific position. " +
    "Use this before calling a function to understand its parameters.",
  inputSchema: {
    type: "object",
    required: ["file", "line"],
    properties: {
      file: { type: "string", description: "Workspace-relative file path" },
      line: { type: "number", description: "Line number (1-based) where the function call appears" },
      character: { type: "number", description: "Column number (1-based). Default: position of the symbol" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const file = typeof input.file === "string" ? input.file : "";
    const line = typeof input.line === "number" ? input.line : 1;
    if (!file) return { ok: false, error: "file is required" };

    const fileUri = resolveFileUri(file);
    if (!fileUri) return { ok: false, error: "No workspace open" };

    const doc = await openDoc(fileUri);
    if (!doc) return { ok: false, error: `Cannot open ${file}` };

    try {
      const pos = new vscode.Position(line - 1, typeof input.character === "number" ? input.character - 1 : 0);
      
      const signatures = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        "vscode.executeSignatureHelpProvider",
        fileUri,
        pos,
      );

      if (!signatures || signatures.signatures.length === 0) {
        return { ok: true, data: { file, line, signatures: [], message: "No signature help available (is a language server running?)" } };
      }

      const results = signatures.signatures.map((sig) => ({
        label: sig.label,
        documentation: typeof sig.documentation === "string" ? sig.documentation : 
          (sig.documentation && "value" in sig.documentation) ? sig.documentation.value : "",
        parameters: sig.parameters.map((param) => ({
          label: typeof param.label === "string" ? param.label : param.label[0],
          documentation: param.documentation ? 
            (typeof param.documentation === "string" ? param.documentation : param.documentation.value) : "",
        })),
        activeParameter: signatures.activeParameter,
      }));

      return { ok: true, data: { file, line, signatures: results } };
    } catch (err) {
      return { ok: false, error: `Signature help failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

// ── Code Actions (Refactoring, Quick Fixes) ──

export const getCodeActionsTool: ToolDefinition = {
  name: "getCodeActions",
  description:
    "Get available code actions (refactoring, quick fixes, source actions) at a specific location. " +
    "Returns actions like: rename, extract method, implement interface, add import, etc.",
  inputSchema: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", description: "Workspace-relative file path" },
      line: { type: "number", description: "Line number (1-based). Default: 1" },
      length: { type: "number", description: "Selection length in characters. Default: entire line" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const file = typeof input.file === "string" ? input.file : "";
    if (!file) return { ok: false, error: "file is required" };

    const fileUri = resolveFileUri(file);
    if (!fileUri) return { ok: false, error: "No workspace open" };

    const doc = await openDoc(fileUri);
    if (!doc) return { ok: false, error: `Cannot open ${file}` };

    try {
      const line = typeof input.line === "number" ? Math.max(0, input.line - 1) : 0;
      const lineText = doc.lineAt(line).text;
      const len = typeof input.length === "number" ? input.length : lineText.length;
      
      const range = new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, Math.min(len, lineText.length)),
      );

      const context: vscode.CodeActionContext = {
        diagnostics: vscode.languages.getDiagnostics(fileUri).filter((d) => range.intersection(d.range)),
        only: undefined,
      };

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        fileUri,
        range,
      );

      if (!actions || actions.length === 0) {
        return { ok: true, data: { file, line: line + 1, actions: [], message: "No code actions available" } };
      }

      const results = actions.map((action) => ({
        title: action.title,
        kind: action.kind?.value || "unknown",
        isPreferred: action.isPreferred || false,
        command: action.command ? {
          title: action.command.title,
          command: action.command.command,
          arguments: action.command.arguments,
        } : undefined,
      }));

      return { ok: true, data: { file, line: line + 1, actionCount: results.length, actions: results } };
    } catch (err) {
      return { ok: false, error: `Code actions failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

// ── Workspace Symbols (search across all files) ──

export const getWorkspaceSymbolsTool: ToolDefinition = {
  name: "getWorkspaceSymbols",
  description:
    "Search for symbols (functions, classes, types, variables) across the entire workspace. " +
    "More powerful than getDocumentSymbols which only searches one file.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Symbol name to search for (supports fuzzy matching)" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query) return { ok: false, error: "query is required" };

    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query,
      );

      if (!symbols || symbols.length === 0) {
        return { ok: true, data: { query, symbols: [], message: "No workspace symbols found" } };
      }

      const results = symbols.slice(0, 50).map((sym) => ({
        name: sym.name,
        kind: vscode.SymbolKind[sym.kind],
        containerName: sym.containerName,
        file: vscode.workspace.asRelativePath(sym.location.uri),
        line: sym.location.range.start.line + 1,
      }));

      return {
        ok: true,
        data: {
          query,
          totalFound: symbols.length,
          symbols: results,
        },
      };
    } catch (err) {
      return { ok: false, error: `Workspace symbol search failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

// ── Type Hierarchy (what extends/implements this) ──

export const getTypeHierarchyTool: ToolDefinition = {
  name: "getTypeHierarchy",
  description:
    "Get the type hierarchy for a symbol — what it extends, what extends it, what it implements. " +
    "Useful for understanding class/interface relationships.",
  inputSchema: {
    type: "object",
    required: ["file", "line"],
    properties: {
      file: { type: "string", description: "Workspace-relative file path" },
      line: { type: "number", description: "Line number (1-based) where the class/interface is defined" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const file = typeof input.file === "string" ? input.file : "";
    const line = typeof input.line === "number" ? input.line : 1;
    if (!file) return { ok: false, error: "file and line are required" };

    const fileUri = resolveFileUri(file);
    if (!fileUri) return { ok: false, error: "No workspace open" };

    const doc = await openDoc(fileUri);
    if (!doc) return { ok: false, error: `Cannot open ${file}` };

    try {
      // Get document symbols and find the one at the given line
      const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        fileUri,
      );

      if (!docSymbols) return { ok: true, data: { message: "No symbols found" } };

      // Find symbol at the given line
      let targetSymbol: vscode.DocumentSymbol | undefined;
      function findAtLine(syms: vscode.DocumentSymbol[]): void {
        for (const sym of syms) {
          if (sym.range.start.line === line - 1) {
            targetSymbol = sym;
            return;
          }
          if (sym.children?.length) findAtLine(sym.children);
        }
      }
      findAtLine(docSymbols);

      if (!targetSymbol) {
        return { ok: true, data: { message: `No symbol found at line ${line}` } };
      }

      // Get type hierarchy via VS Code command (available in some LSPs)
      const position = targetSymbol.selectionRange.start;
      
      // Try the type hierarchy command (may not be available in all LSPs)
      let hierarchy: unknown;
      try {
        hierarchy = await vscode.commands.executeCommand(
          "vscode.provideTypeHierarchySupertypes",
          fileUri,
          position,
        );
      } catch {
        // Type hierarchy not supported by this LSP
      }

      const supers = Array.isArray(hierarchy) ? (hierarchy as vscode.Location[]).map((loc) => ({
        file: vscode.workspace.asRelativePath(loc.uri),
        line: loc.range.start.line + 1,
      })) : [];

      return {
        ok: true,
        data: {
          symbol: targetSymbol.name,
          kind: vscode.SymbolKind[targetSymbol.kind],
          file,
          line,
          superTypes: supers,
          children: targetSymbol.children?.map((c) => ({
            name: c.name,
            kind: vscode.SymbolKind[c.kind],
            startLine: c.range.start.line + 1,
          })) || [],
        },
      };
    } catch (err) {
      return { ok: false, error: `Type hierarchy failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};
