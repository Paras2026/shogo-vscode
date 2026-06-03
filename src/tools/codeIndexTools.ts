import type { ToolDefinition, ToolResult } from "../agent/types";
import {
  getCodeIndex,
  findSymbolsByName,
  findDependenciesOf,
  findDependentsOf,
  symbolsToString,
} from "../intelligence/astIndex";

export const codeIndexTool: ToolDefinition = {
  name: "codeIndex",
  description:
    "Search the code index for symbols (functions, classes, types, interfaces) by name. Returns where they are defined and their signatures.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "Symbol name to search for (e.g. 'useAuth', 'App', 'UserService')",
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { ok: false, error: "name must be a non-empty string" };
    }

    const index = await getCodeIndex();
    const symbols = findSymbolsByName(index, input.name.trim());

    if (symbols.length === 0) {
      return {
        ok: true,
        data: {
          name: input.name,
          found: false,
          message: `No symbol named "${input.name}" found in the code index. Try searching with searchWorkspace.`,
          indexStats: { files: index.fileCount, symbols: index.symbols.size },
        },
      };
    }

    return {
      ok: true,
      data: {
        name: input.name,
        found: true,
        symbols: symbols.slice(0, 10),
        summary: symbolsToString(symbols),
        indexStats: { files: index.fileCount, symbols: index.symbols.size },
      },
    };
  },
};

export const dependencyGraphTool: ToolDefinition = {
  name: "dependencyGraph",
  description:
    "Show what a file imports or what imports a file. Use this to understand dependencies before editing.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file path",
      },
      direction: {
        type: "string",
        description:
          '"imports" (default) shows what this file imports. "dependents" shows what imports this file.',
      },
    },
  },
  async execute(input): Promise<ToolResult> {
    if (typeof input.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }

    const index = await getCodeIndex();
    const direction = input.direction === "dependents" ? "dependents" : "imports";
    const deps = direction === "imports"
      ? findDependenciesOf(index, input.path)
      : findDependentsOf(index, input.path);

    if (deps.length === 0) {
      return {
        ok: true,
        data: {
          path: input.path,
          direction,
          dependencies: [],
          message: `No ${direction} found for ${input.path}. The file may not be indexed yet or has no ${direction}.`,
        },
      };
    }

    return {
      ok: true,
      data: {
        path: input.path,
        direction,
        dependencies: deps.map((d) => ({
          from: d.from,
          to: d.to,
          kind: d.kind,
        })),
        count: deps.length,
      },
    };
  },
};
