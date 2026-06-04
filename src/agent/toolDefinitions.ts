/**
 * Native tool definitions for the Vercel AI SDK's streamText().
 * These JSON schemas are sent to the API, replacing the text-based tool protocol.
 * The LLM returns structured tool_use blocks instead of JSON-in-text.
 */
export const TOOL_DEFINITIONS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  readFile: {
    description:
      "Read a text file from the workspace. Returns content with line numbers. For large files (500+ lines), ALWAYS use startLine/endLine to read only the section you need — never read the entire file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path (e.g. src/App.tsx)",
        },
        startLine: {
          type: "number",
          description:
            "First line to read (1-based). Use for large files. Default: 1.",
        },
        endLine: {
          type: "number",
          description:
            "Last line to read (1-based, inclusive). Use with startLine for large files. Default: 200 or end of file.",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return. Default 12000.",
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
      "Edit a file using SEARCH/REPLACE blocks. Use format: <<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE. You can have multiple blocks. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path",
        },
        patch: {
          type: "string",
          description:
            "SEARCH/REPLACE blocks: <<<<<<< SEARCH\\nexact old text\\n=======\\nnew text\\n>>>>>>> REPLACE",
        },
      },
      required: ["path", "patch"],
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
  gitStatus: {
    description:
      "Show the working tree status. Lists modified, added, deleted, and untracked files.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  gitDiff: {
    description:
      "Show unstaged file changes. Set staged=true to see staged changes instead. Returns a summary and the full diff.",
    parameters: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "Show staged changes instead of unstaged. Default false.",
        },
        maxLines: {
          type: "number",
          description: "Max diff lines to return. Default 200.",
        },
      },
    },
  },
  gitLog: {
    description:
      "Show recent git commits with hash, message, and time ago.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show. Default 10.",
        },
      },
    },
  },
  projectMap: {
    description:
      "Scan the workspace and return a lightweight project map with file paths, line counts, and exported symbols. Use this FIRST on large codebases to understand structure before reading individual files.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'Optional glob to filter files. Default: all source files. Example: "src/**/*.ts"',
        },
        maxFiles: {
          type: "number",
          description: "Maximum files to index. Default 200.",
        },
        withSymbols: {
          type: "boolean",
          description:
            "Include exported symbol names. Default true. Set false for faster scan.",
        },
      },
    },
  },
  buildCallGraph: {
    description:
      "Build a call graph showing which functions call which. Run this first before impactAnalysis, deadCode, or callChain. Cached for 30 seconds.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Optional glob filter. Example: "src/**/*.ts"',
        },
      },
    },
  },
  impactAnalysis: {
    description:
      "Find what would break if you change a function. Walks the call graph backwards to find all callers and their callers. Use before making risky changes.",
    parameters: {
      type: "object",
      properties: {
        function: {
          type: "string",
          description: "Function name to analyze",
        },
        depth: {
          type: "number",
          description: "Max depth to traverse. Default 4.",
        },
      },
      required: ["function"],
    },
  },
  deadCode: {
    description:
      "Find functions that are never called by anything else. Identifies unused code that can be safely removed.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  callChain: {
    description:
      "Trace the execution path from one function to another. Shows how the code flows between them.",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Starting function name",
        },
        to: {
          type: "string",
          description: "Target function name",
        },
        maxDepth: {
          type: "number",
          description: "Max chain depth. Default 6.",
        },
      },
      required: ["from", "to"],
    },
  },
  findReferences: {
    description:
      "Find all references to a symbol using VS Code's Language Server. Works for any language with an LSP installed.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name to find references for" },
        file: { type: "string", description: "File where the symbol is defined" },
        line: { type: "number", description: "Line where the symbol appears (1-based)" },
      },
      required: ["symbol", "file"],
    },
  },
  goToDefinition: {
    description:
      "Go to the definition of a symbol. Returns the file and line where it's defined.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name" },
        file: { type: "string", description: "File where the symbol is used" },
        line: { type: "number", description: "Line number (1-based)" },
      },
      required: ["symbol", "file"],
    },
  },
  getSymbolInfo: {
    description:
      "Get type information and docs for a symbol using VS Code's hover provider.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name" },
        file: { type: "string", description: "File where the symbol appears" },
        line: { type: "number", description: "Line number (1-based)" },
      },
      required: ["symbol", "file"],
    },
  },
  getDocumentSymbols: {
    description:
      "List all symbols (functions, classes, types) in a file using VS Code's LSP. Returns structured outline with line numbers.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative file path" },
      },
      required: ["file"],
    },
  },
  getSignatureHelp: {
    description: "Get function signature help (parameter types, overloads) at a specific position.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative file path" },
        line: { type: "number", description: "Line number (1-based)" },
        character: { type: "number", description: "Column number (1-based)" },
      },
      required: ["file", "line"],
    },
  },
  getCodeActions: {
    description: "Get available code actions (refactoring, quick fixes) at a location.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative file path" },
        line: { type: "number", description: "Line number (1-based)" },
        length: { type: "number", description: "Selection length" },
      },
      required: ["file"],
    },
  },
  getWorkspaceSymbols: {
    description: "Search for symbols across the entire workspace. More powerful than getDocumentSymbols.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name to search for" },
      },
      required: ["query"],
    },
  },
  getTypeHierarchy: {
    description: "Get type hierarchy — what extends/implements a class or interface.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative file path" },
        line: { type: "number", description: "Line where the class/interface is defined" },
      },
      required: ["file", "line"],
    },
  },
  runBackground: {
    description: "Run a long command in a visible VS Code terminal. Use for npm install, build, test, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        label: { type: "string", description: "Optional label" },
      },
      required: ["command"],
    },
  },
  backgroundStatus: {
    description: "Check status of all background terminal jobs.",
    parameters: { type: "object", properties: {} },
  },
};
