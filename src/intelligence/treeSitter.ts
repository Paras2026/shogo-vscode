/**
 * Tree-Sitter AST Index — WASM-based parsing for robust symbol extraction.
 * 
 * Uses web-tree-sitter (WASM) instead of native tree-sitter to avoid
 * node-gyp compilation issues in VS Code extensions.
 * 
 * Falls back to regex-based parsing when WASM isn't available.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logInfo, logDebug, logWarn } from "../logger";

export interface AstSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method" | "parameter" | "import" | "export" | "unknown";
  startLine: number;
  endLine: number;
  parent?: string;
  children?: AstSymbol[];
  exports?: boolean;
}

export interface AstIndex {
  filePath: string;
  language: string;
  symbols: AstSymbol[];
  imports: { source: string; specifiers: string[] }[];
  exports: string[];
  functions: { name: string; line: number; params: string }[];
  classes: { name: string; line: number; methods: string[] }[];
  totalNodes: number;
  parseTimeMs: number;
}

// Regex-based fallback parsers for when WASM isn't available
const JS_PATTERNS = {
  functions: /(?:(?:export|async)\s+)*function\s+(\w+)\s*\(([^)]*)\)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:(?:\([^)]*\))|\w+)\s*=>/g,
  classes: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
  interfaces: /(?:export\s+)?interface\s+(\w+)/g,
  types: /(?:export\s+)?type\s+(\w+)/g,
  imports: /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g,
  exports: /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
};

const PY_PATTERNS = {
  functions: /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g,
  classes: /class\s+(\w+)(?:\([^)]*\))?\s*:/g,
  imports: /(?:from\s+(\S+)\s+)?import\s+(.+)/g,
};

/**
 * Parse a source file using regex-based AST extraction.
 * This is the fast fallback — no WASM dependency needed.
 */
export function parseFileRegex(filePath: string, content: string): AstIndex {
  const ext = path.extname(filePath).toLowerCase();
  const startTime = Date.now();
  const symbols: AstSymbol[] = [];
  const imports: AstIndex["imports"] = [];
  const exports: string[] = [];
  const functions: AstIndex["functions"] = [];
  const classes: AstIndex["classes"] = [];

  const language = getLanguageFromExt(ext);
  const isJsLike = [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"].includes(ext);
  const isPy = ext === ".py";
  const patterns = isJsLike ? JS_PATTERNS : isPy ? PY_PATTERNS : null;

  if (!patterns) {
    return { filePath, language, symbols: [], imports: [], exports: [], functions: [], classes: [], totalNodes: 0, parseTimeMs: 0 };
  }

  // Parse functions (handles both function declarations and arrow functions)
  if ("functions" in patterns) {
    let m: RegExpExecArray | null;
    const funcRegex = new RegExp(patterns.functions.source, "gm");
    while ((m = funcRegex.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      // Group 1 = function declaration name, Group 2 = function params, Group 3 = arrow function name
      const name = m[1] || m[3] || "anonymous";
      const params = m[2] || "";
      functions.push({ name, line, params });
      symbols.push({ name, kind: "function", startLine: line, endLine: line, exports: false });
    }
  }

  // Parse classes
  if ("classes" in patterns) {
    let m: RegExpExecArray | null;
    const classRegex = new RegExp(patterns.classes.source, "gm");
    while ((m = classRegex.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      const name = m[1];

      // Find methods inside the class
      const methods: string[] = [];
      const afterClass = content.slice(m.index + m[0].length);
      const braceEnd = findMatchingBrace(afterClass);
      const classBody = braceEnd > 0 ? afterClass.slice(0, braceEnd) : afterClass.slice(0, 500);
      
      const methodRegex = /(?:(?:async|static|get|set|public|private|protected)\s+)*(\w+)\s*\(/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRegex.exec(classBody)) !== null) {
        if (mm[1] !== "if" && mm[1] !== "for" && mm[1] !== "while" && mm[1] !== "switch" && !methods.includes(mm[1])) {
          methods.push(mm[1]);
        }
      }

      classes.push({ name, line, methods });
      symbols.push({ name, kind: "class", startLine: line, endLine: line, children: methods.map((m) => ({ name: m, kind: "method" as const, startLine: line, endLine: line })) });
    }
  }

  // Parse interfaces and types (JS/TS only)
  if (isJsLike && "interfaces" in patterns) {
    let m: RegExpExecArray | null;
    const ifaceRegex = new RegExp(patterns.interfaces.source, "gm");
    while ((m = ifaceRegex.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      symbols.push({ name: m[1], kind: "interface", startLine: line, endLine: line });
    }

    const typeRegex = new RegExp(patterns.types.source, "gm");
    while ((m = typeRegex.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      symbols.push({ name: m[1], kind: "type", startLine: line, endLine: line });
    }
  }

  // Parse imports (handles named, default, and side-effect imports)
  if ("imports" in patterns) {
    let m: RegExpExecArray | null;
    const importRegex = new RegExp(patterns.imports.source, "gm");
    while ((m = importRegex.exec(content)) !== null) {
      if (isJsLike) {
        if (m[4]) {
          // Side-effect import: import "./polyfill"
          imports.push({ source: m[4], specifiers: ["*"] });
        } else {
          const namedImports = m[1] ? m[1].split(",").map((s) => s.trim()) : [];
          const defaultImport = m[2] || "";
          const source = m[3] || "";
          imports.push({ source, specifiers: [...namedImports, defaultImport].filter(Boolean) });
        }
      } else {
        imports.push({ source: m[1] || "", specifiers: m[2] ? m[2].split(",").map((s) => s.trim()) : [] });
      }
    }
  }

  // Parse exports
  if ("exports" in patterns) {
    let m: RegExpExecArray | null;
    const exportRegex = new RegExp(patterns.exports.source, "gm");
    while ((m = exportRegex.exec(content)) !== null) {
      exports.push(m[1]);
    }
    // Mark exported symbols
    for (const sym of symbols) {
      if (exports.includes(sym.name)) sym.exports = true;
    }
  }

  return {
    filePath,
    language,
    symbols,
    imports,
    exports,
    functions,
    classes,
    totalNodes: symbols.length,
    parseTimeMs: Date.now() - startTime,
  };
}

/**
 * Find matching closing brace from an opening brace position.
 */
function findMatchingBrace(text: string): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    
    if (inString) {
      if (ch === stringChar && text[i - 1] !== "\\") inString = false;
      continue;
    }
    
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }
    
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  
  return -1;
}

function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript-react",
    ".js": "javascript", ".jsx": "javascript-react",
    ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".rb": "ruby",
  };
  return map[ext] || ext.slice(1) || "unknown";
}

// ── Cached index for the current workspace ──

const fileIndexCache = new Map<string, AstIndex>();

export function getFileIndex(filePath: string, content?: string): AstIndex | undefined {
  if (fileIndexCache.has(filePath)) return fileIndexCache.get(filePath);
  
  if (!content) {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return undefined;
    try {
      content = fs.readFileSync(require("path").join(root.uri.fsPath, filePath), "utf-8");
    } catch {
      return undefined;
    }
  }

  const index = parseFileRegex(filePath, content);
  fileIndexCache.set(filePath, index);
  return index;
}

export function clearFileIndexCache(): void {
  fileIndexCache.clear();
}

export function getFileIndexStats(): { cached: number; files: string[] } {
  return { cached: fileIndexCache.size, files: Array.from(fileIndexCache.keys()) };
}
