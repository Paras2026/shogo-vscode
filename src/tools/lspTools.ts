import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";

/**
 * LSP-powered tools that use VS Code's built-in language intelligence.
 * Works for ANY language with an installed LSP server — no custom parsing needed.
 */

export const findReferencesTool: ToolDefinition = {
  name: "findReferences",
  description:
    "Find all references to a symbol (function, class, variable) using VS Code's LSP. " +
    "Works for any language with a language server installed.",
  inputSchema: {
    type: "object",
    required: ["symbol", "file"],
    properties: {
      symbol: { type: "string", description: "Symbol name to find references for (e.g. 'handleUpload')" },
      file: { type: "string", description: "Workspace-relative file where the symbol is defined" },
      line: { type: "number", description: "Line number where the symbol appears (1-based). If omitted, searches from line 1." },
    },
  },
  async execute(input): Promise<ToolResult> {
    const symbol = typeof input.symbol === "string" ? input.symbol : "";
    const file = typeof input.file === "string" ? input.file : "";
    if (!symbol || !file) return { ok: false, error: "symbol and file are required" };

    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) return { ok: false, error: "No workspace open" };

      const fileUri = vscode.Uri.joinPath(root.uri, ...file.split("/"));
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const line = typeof input.line === "number" ? input.line - 1 : 0;

      // Find the symbol position
      const text = doc.getText();
      const lines = text.split("\n");
      let charIndex = 0;
      for (let i = 0; i < Math.min(line, lines.length); i++) {
        charIndex += lines[i].length + 1;
      }

      // Search for the symbol name starting from the line
      const symbolIdx = text.indexOf(symbol, charIndex);
      const actualIdx = symbolIdx >= 0 ? symbolIdx : text.indexOf(symbol);
      if (actualIdx < 0) {
        return { ok: false, error: `Symbol "${symbol}" not found in ${file}` };
      }

      const position = doc.positionAt(actualIdx);

      // Call VS Code's reference provider
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        fileUri,
        position
      );

      if (!references || references.length === 0) {
        return { ok: true, data: { symbol, file, references: [], message: "No references found" } };
      }

      const results = references.map((ref) => ({
        file: vscode.workspace.asRelativePath(ref.uri),
        line: ref.range.start.line + 1,
        column: ref.range.start.character + 1,
      }));

      return {
        ok: true,
        data: {
          symbol,
          definitionFile: file,
          referenceCount: results.length,
          references: results,
        },
      };
    } catch (err) {
      return { ok: false, error: `LSP reference lookup failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

export const goToDefinitionTool: ToolDefinition = {
  name: "goToDefinition",
  description:
    "Go to the definition of a symbol. Returns the file and line where the symbol is defined.",
  inputSchema: {
    type: "object",
    required: ["symbol", "file"],
    properties: {
      symbol: { type: "string", description: "Symbol name to go to definition of" },
      file: { type: "string", description: "Workspace-relative file where the symbol is used" },
      line: { type: "number", description: "Line number where the symbol appears (1-based)" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const symbol = typeof input.symbol === "string" ? input.symbol : "";
    const file = typeof input.file === "string" ? input.file : "";
    if (!symbol || !file) return { ok: false, error: "symbol and file are required" };

    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) return { ok: false, error: "No workspace open" };

      const fileUri = vscode.Uri.joinPath(root.uri, ...file.split("/"));
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const line = typeof input.line === "number" ? input.line - 1 : 0;

      const text = doc.getText();
      const lines = text.split("\n");
      let charIndex = 0;
      for (let i = 0; i < Math.min(line, lines.length); i++) {
        charIndex += lines[i].length + 1;
      }

      const symbolIdx = text.indexOf(symbol, charIndex);
      const actualIdx = symbolIdx >= 0 ? symbolIdx : text.indexOf(symbol);
      if (actualIdx < 0) {
        return { ok: false, error: `Symbol "${symbol}" not found in ${file}` };
      }

      const position = doc.positionAt(actualIdx);

      const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeDefinitionProvider",
        fileUri,
        position
      );

      if (!definitions || definitions.length === 0) {
        return { ok: true, data: { symbol, definitions: [], message: "No definition found" } };
      }

      const results = definitions.map((def) => {
        const defDoc = def.uri.fsPath;
        const relPath = vscode.workspace.asRelativePath(def.uri);
        // Read a few lines around the definition
        const startLine = def.range.start.line;
        const endLine = def.range.end.line;
        return {
          file: relPath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          fsPath: defDoc,
        };
      });

      return {
        ok: true,
        data: {
          symbol,
          definitions: results,
          count: results.length,
        },
      };
    } catch (err) {
      return { ok: false, error: `LSP definition lookup failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

export const getSymbolInfoTool: ToolDefinition = {
  name: "getSymbolInfo",
  description:
    "Get type information and documentation for a symbol using VS Code's hover provider. " +
    "Returns the type signature and any JSDoc/TSDoc comments.",
  inputSchema: {
    type: "object",
    required: ["symbol", "file"],
    properties: {
      symbol: { type: "string", description: "Symbol name to get info for" },
      file: { type: "string", description: "Workspace-relative file where the symbol appears" },
      line: { type: "number", description: "Line number (1-based)" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const symbol = typeof input.symbol === "string" ? input.symbol : "";
    const file = typeof input.file === "string" ? input.file : "";
    if (!symbol || !file) return { ok: false, error: "symbol and file are required" };

    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) return { ok: false, error: "No workspace open" };

      const fileUri = vscode.Uri.joinPath(root.uri, ...file.split("/"));
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const line = typeof input.line === "number" ? input.line - 1 : 0;

      const text = doc.getText();
      const lines = text.split("\n");
      let charIndex = 0;
      for (let i = 0; i < Math.min(line, lines.length); i++) {
        charIndex += lines[i].length + 1;
      }

      const symbolIdx = text.indexOf(symbol, charIndex);
      const actualIdx = symbolIdx >= 0 ? symbolIdx : text.indexOf(symbol);
      if (actualIdx < 0) {
        return { ok: false, error: `Symbol "${symbol}" not found in ${file}` };
      }

      const position = doc.positionAt(actualIdx);

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        fileUri,
        position
      );

      if (!hovers || hovers.length === 0) {
        return { ok: true, data: { symbol, hover: null, message: "No hover info available (is a language server running?)" } };
      }

      // Extract text content from hover
      const contents = hovers.map((hover) => {
        if (typeof hover.contents === "string") return hover.contents;
        if (Array.isArray(hover.contents)) {
          return hover.contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n");
        }
        if (hover.contents && typeof hover.contents === "object" && "value" in hover.contents) {
          return hover.contents.value;
        }
        return "";
      }).join("\n---\n");

      return {
        ok: true,
        data: {
          symbol,
          file,
          line: position.line + 1,
          hover: contents,
        },
      };
    } catch (err) {
      return { ok: false, error: `LSP hover lookup failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};

export const getDocumentSymbolsTool: ToolDefinition = {
  name: "getDocumentSymbols",
  description:
    "List all symbols (functions, classes, types, interfaces, variables) in a file using VS Code's LSP. " +
    "Returns a structured outline with line numbers.",
  inputSchema: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", description: "Workspace-relative file path" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const file = typeof input.file === "string" ? input.file : "";
    if (!file) return { ok: false, error: "file is required" };

    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) return { ok: false, error: "No workspace open" };

      const fileUri = vscode.Uri.joinPath(root.uri, ...file.split("/"));
      const doc = await vscode.workspace.openTextDocument(fileUri);

      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        fileUri
      );

      if (!symbols || symbols.length === 0) {
        return { ok: true, data: { file, symbols: [], message: "No symbols found (is a language server running?)" } };
      }

      const results = symbols.map((sym) => ({
        name: sym.name,
        kind: vscode.SymbolKind[sym.kind],
        startLine: sym.range.start.line + 1,
        endLine: sym.range.end.line + 1,
        children: sym.children?.map((child) => ({
          name: child.name,
          kind: vscode.SymbolKind[child.kind],
          startLine: child.range.start.line + 1,
          endLine: child.range.end.line + 1,
        })),
      }));

      return {
        ok: true,
        data: {
          file,
          symbolCount: results.length,
          symbols: results,
        },
      };
    } catch (err) {
      return { ok: false, error: `LSP symbol lookup failed: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  },
};
