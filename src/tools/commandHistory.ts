import type { ToolDefinition, ToolResult } from "../agent/types";
import { getCommandHistory } from "./runCommand";

export const commandHistoryTool: ToolDefinition = {
  name: "commandHistory",
  description: "View recent shell commands that were executed. Shows command, exit code, output, and duration. Useful for debugging or reviewing what was already run.",
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of recent commands to show. Default 10, max 50." },
      search: { type: "string", description: "Optional filter: only show commands containing this text." },
    },
  },
  async execute(input): Promise<ToolResult> {
    const count = typeof input.count === "number" ? Math.min(Math.max(input.count, 1), 50) : 10;
    const search = typeof input.search === "string" ? input.search.toLowerCase() : "";

    let history = getCommandHistory(count * 3);

    if (search) {
      history = history.filter(
        (h) => h.command.toLowerCase().includes(search) ||
          h.stdout.toLowerCase().includes(search) ||
          h.stderr.toLowerCase().includes(search)
      );
    }

    history = history.slice(0, count);

    if (history.length === 0) {
      return { ok: true, data: { message: "No commands have been executed yet.", history: [] } };
    }

    const entries = history.map((h) => ({
      command: h.command,
      exitCode: h.exitCode,
      durationMs: h.durationMs,
      timestamp: new Date(h.timestamp).toISOString(),
      stdoutPreview: h.stdout.slice(0, 500),
      stderrPreview: h.stderr.slice(0, 200),
    }));

    return {
      ok: true,
      data: {
        totalCommands: getCommandHistory(100).length,
        shown: entries.length,
        history: entries,
      },
    };
  },
};
