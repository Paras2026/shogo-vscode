import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";
import { getDiagnosticsTool } from "../tools/diagnostics";
import { applyPatchTool, writeFileTool } from "../tools/editTools";
import { listFilesTool, readFileTool, searchWorkspaceTool } from "../tools/fileTools";
import { runCommandTool } from "../tools/runCommand";

const toolList: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchWorkspaceTool,
  getDiagnosticsTool,
  applyPatchTool,
  writeFileTool,
  runCommandTool,
];

const tools = new Map(toolList.map((tool) => [tool.name, tool]));

export function getToolDescriptions(): string {
  return toolList
    .map((tool) => `- ${tool.name}: ${tool.description}\n  inputSchema: ${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
}

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool: ${name}` };
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
