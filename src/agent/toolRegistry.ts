import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";
import { getDiagnosticsTool } from "../tools/diagnostics";
import { applyPatchTool, writeFileTool } from "../tools/editTools";
import { listFilesTool, readFileTool, searchWorkspaceTool } from "../tools/fileTools";
import { runCommandTool } from "../tools/runCommand";
import { codeIndexTool, dependencyGraphTool } from "../tools/codeIndexTools";
import { gitStatusTool, gitDiffTool, gitLogTool } from "../tools/gitTools";
import { projectMapTool } from "../tools/projectMap";
import { logInfo, logError } from "../logger";

const toolList: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchWorkspaceTool,
  getDiagnosticsTool,
  applyPatchTool,
  writeFileTool,
  runCommandTool,
  codeIndexTool,
  dependencyGraphTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  projectMapTool,
];

const tools = new Map(toolList.map((tool) => [tool.name, tool]));

const REQUIRED_PARAMS: Record<string, string[]> = {
  readFile: ["path"],
  listFiles: [],
  searchWorkspace: ["query"],
  applyPatch: ["path", "oldText", "newText"],
  writeFile: ["path", "content"],
  runCommand: ["command"],
  getDiagnostics: [],
  codeIndex: ["name"],
  dependencyGraph: ["path"],
  gitStatus: [],
  gitDiff: [],
  gitLog: [],
  projectMap: [],
};

const PARAM_TYPES: Record<string, Record<string, "string" | "number" | "boolean">> = {
  readFile: { path: "string", startLine: "number", endLine: "number", maxChars: "number" },
  listFiles: { pattern: "string", max: "number" },
  searchWorkspace: { query: "string", pattern: "string", maxFiles: "number", maxMatches: "number" },
  applyPatch: { path: "string", oldText: "string", newText: "string" },
  writeFile: { path: "string", content: "string" },
  runCommand: { command: "string", timeoutMs: "number" },
  getDiagnostics: { max: "number" },
  codeIndex: { name: "string" },
  dependencyGraph: { path: "string", direction: "string" },
  gitStatus: {},
  gitDiff: { staged: "boolean", maxLines: "number" },
  gitLog: { count: "number" },
  projectMap: { pattern: "string", maxFiles: "number", withSymbols: "boolean" },
};

/**
 * Validates tool input parameters before execution.
 * Returns an error message if validation fails, or null if valid.
 */
export function validateToolInput(toolName: string, input: Record<string, unknown>): string | null {
  const required = REQUIRED_PARAMS[toolName];
  if (required) {
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === "") {
        return `Missing required parameter "${param}".`;
      }
    }
  }

  const types = PARAM_TYPES[toolName];
  if (types) {
    for (const [param, expectedType] of Object.entries(types)) {
      const value = input[param];
      if (value === undefined || value === null) continue;

      if (expectedType === "number" && typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) {
          input[param] = num;
        } else {
          return `Parameter "${param}" must be a number, got "${value}".`;
        }
      }
      if (expectedType === "boolean" && typeof value === "string") {
        if (value === "true") { input[param] = true; }
        else if (value === "false") { input[param] = false; }
        else { return `Parameter "${param}" must be a boolean, got "${value}".`; }
      }
    }
  }

  return null;
}

export function getToolDescriptions(): string {
  return toolList
    .map((tool) => {
      const required = REQUIRED_PARAMS[tool.name] ?? [];
      const types = PARAM_TYPES[tool.name] ?? {};
      const params = Object.entries(types)
        .map(([k, v]) => {
          const reqMark = required.includes(k) ? "*" : "";
          return `${k}${reqMark}:${v}`;
        })
        .join(" ");
      return `- ${tool.name}(${params}): ${tool.description}`;
    })
    .join("\n");
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool: "${name}". Available tools: ${getToolNames().join(", ")}.` };
  }

  try {
    logInfo(`Tool executing: ${name}`);
    const result = await tool.execute(input, ctx);
    logInfo(`Tool ${name}: ${result.ok ? "ok" : "FAIL"}${result.error ? ` — ${result.error}` : ""}`);
    return result;
  } catch (error: unknown) {
    logError(`Tool ${name} threw`, error);
    return { ok: false, error: error instanceof Error ? error.message : "Unknown tool error" };
  }
}

export function getToolNames(): string[] {
  return toolList.map((tool) => tool.name);
}
