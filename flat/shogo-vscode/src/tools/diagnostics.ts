import * as vscode from "vscode";
import type { ToolDefinition, ToolResult } from "../agent/types";
import { asRelative } from "./workspace";

function severityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}

export const getDiagnosticsTool: ToolDefinition = {
  name: "getDiagnostics",
  description: "Read current VS Code Problems diagnostics for workspace files.",
  inputSchema: {
    type: "object",
    properties: {
      max: { type: "number", description: "Maximum diagnostics to return, default 100" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const max = typeof input.max === "number" ? Math.min(Math.max(input.max, 1), 500) : 100;
    const diagnostics: Array<{
      path: string;
      line: number;
      character: number;
      severity: string;
      source?: string;
      code?: string | number;
      message: string;
    }> = [];

    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
      const path = asRelative(uri);
      for (const diagnostic of entries) {
        diagnostics.push({
          path,
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          severity: severityName(diagnostic.severity),
          source: diagnostic.source,
          code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
          message: diagnostic.message,
        });
        if (diagnostics.length >= max) {
          return { ok: true, data: { diagnostics } };
        }
      }
    }

    return { ok: true, data: { diagnostics } };
  },
};
