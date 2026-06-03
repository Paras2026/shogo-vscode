import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";
import { getDiagnosticsTool } from "../tools/diagnostics";
import { applyPatchTool, writeFileTool } from "../tools/editTools";
import { listFilesTool, readFileTool, searchWorkspaceTool } from "../tools/fileTools";
import { gitDiffTool, gitStatusTool } from "../tools/gitTools";
import { indexWorkspaceTool, searchIndexTool } from "../tools/indexTools";
import { multiEditTool } from "../tools/multiEditTool";
import { runCommandTool } from "../tools/runCommand";

const toolList: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchWorkspaceTool,
  indexWorkspaceTool,
  searchIndexTool,
  gitStatusTool,
  gitDiffTool,
  getDiagnosticsTool,
  applyPatchTool,
  writeFileTool,
  multiEditTool,
  runCommandTool,
];

const tools = new Map(toolList.map((tool) => [tool.name, tool]));

export function getToolDescriptions(): string {
  return toolList
    .map((tool) => {
      const req = (tool.inputSchema as Record<string, unknown>).required;
      const props = (tool.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
      const params = props
        ? Object.entries(props).map(([k, v]) => {
            const reqMark = Array.isArray(req) && req.includes(k) ? "*" : "";
            return `${k}${reqMark}:${v.type ?? "any"}`;
          }).join(" ")
        : "";
      return `- ${tool.name}(${params}): ${tool.description}`;
    })
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
