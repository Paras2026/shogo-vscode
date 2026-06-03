import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";
import { getDiagnosticsTool } from "../tools/diagnostics";
import { applyPatchTool, writeFileTool } from "../tools/editTools";
import { listFilesTool, readFileTool, searchWorkspaceTool } from "../tools/fileTools";
import { runCommandTool } from "../tools/runCommand";
import { codeIndexTool, dependencyGraphTool } from "../tools/codeIndexTools";

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
};

const PARAM_TYPES: Record<string, Record<string, "string" | "number" | "boolean">> = {
  readFile: { path: "string", maxChars: "number" },
  listFiles: { pattern: "string", max: "number" },
  searchWorkspace: { query: "string", pattern: "string", maxFiles: "number", maxMatches: "number" },
  applyPatch: { path: "string", oldText: "string", newText: "string" },
  writeFile: { path: "string", content: "string" },
  runCommand: { command: "string", timeoutMs: "number" },
  getDiagnostics: { max: "number" },
  codeIndex: { name: "string" },
  dependencyGraph: { path: "string", direction: "string" },
};

/**
 * Validates tool input parameters before execution.
 * Returns an error message if validation fails, or null if valid.
 */
export function validateToolInput(toolName: string, input: Record<string, unknown>): string | null {
  const required = REQUIRED_PARAMS[toolName];
  if (required) {
    for (const param of required) {
      if (input[param] === undefined || input[param] === null) {
        return `Missing required parameter "${param}".`;
      }
    }
  }

  const types = PARAM_TYPES[toolName];
  if (types) {
    for (const [param, expectedType] of Object.entries(types)) {
      const value = input[param];
      if (value !== undefined && value !== null) {
        if (expectedType === "string" && typeof value !== "string") {
          return `Parameter "${param}" must be a string, got ${typeof value}.`;
        }
        if (expectedType === "number" && typeof value !== "number") {
          return `Parameter "${param}" must be a number, got ${typeof value}.`;
        }
        if (expectedType === "boolean" && typeof value !== "boolean") {
          return `Parameter "${param}" must be a boolean, got ${typeof value}.`;
        }
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
    return await tool.execute(input, ctx);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown tool error" };
  }
}

export function getToolNames(): string[] {
  return toolList.map((tool) => tool.name);
}
