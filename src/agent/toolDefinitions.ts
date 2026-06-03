/**
 * Native tool definitions for the Vercel AI SDK's streamText().
 * These JSON schemas are sent to the API, replacing the text-based tool protocol.
 * The LLM returns structured tool_use blocks instead of JSON-in-text.
 */
export const TOOL_DEFINITIONS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  readFile: {
    description:
      "Read a text file from the workspace. Returns the file content. Use this to inspect code before editing.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path (e.g. src/App.tsx)",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return. Default 8000.",
        },
      },
      required: ["path"],
    },
  },
  listFiles: {
    description:
      "List files in the workspace matching a glob pattern. Use this to discover the project structure.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern (e.g. "src/**/*.ts"). Default **/*.',
        },
        max: {
          type: "number",
          description: "Maximum files to return. Default 100.",
        },
      },
    },
  },
  searchWorkspace: {
    description:
      "Search text files for a case-insensitive string. Returns matching file paths, line numbers, and the matching line text.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive text to search for",
        },
        pattern: {
          type: "string",
          description: 'Glob to limit search scope (e.g. "src/**/*.ts")',
        },
        maxFiles: {
          type: "number",
          description: "Max files to scan. Default 200.",
        },
        maxMatches: {
          type: "number",
          description: "Max matches to return. Default 30.",
        },
      },
      required: ["query"],
    },
  },
  applyPatch: {
    description:
      "Replace an exact text block in a file. You MUST read the file first with readFile to get the exact oldText. Shows a diff and requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path",
        },
        oldText: {
          type: "string",
          description:
            "Exact existing text to replace. Must match the file content character-for-character.",
        },
        newText: {
          type: "string",
          description: "Replacement text",
        },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  writeFile: {
    description:
      "Create or fully replace a file. Shows a diff and requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path",
        },
        content: {
          type: "string",
          description: "Full file content",
        },
      },
      required: ["path", "content"],
    },
  },
  runCommand: {
    description:
      "Run a shell command in the workspace root. Returns stdout, stderr, and exit code. Requires approval for non-safe commands.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in ms. Default 120000, max 300000.",
        },
      },
      required: ["command"],
    },
  },
  getDiagnostics: {
    description:
      "Get VS Code Problems panel diagnostics (errors and warnings) for workspace files.",
    parameters: {
      type: "object",
      properties: {
        max: {
          type: "number",
          description: "Maximum diagnostics to return. Default 100.",
        },
      },
    },
  },
  codeIndex: {
    description:
      "Search the code index for symbols (functions, classes, types, interfaces) by name. Use this to find where something is defined before editing it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Symbol name to search for (e.g. 'useAuth', 'App', 'UserService')",
        },
      },
      required: ["name"],
    },
  },
  dependencyGraph: {
    description:
      "Show what a file imports or what imports a file. Use this to understand dependencies before editing.",
    parameters: {
      type: "object",
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
      required: ["path"],
    },
  },
};
