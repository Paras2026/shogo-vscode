import * as vscode from "vscode";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "import";
  path: string;
  line: number;
  column: number;
  signature?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "import" | "dynamic-import" | "require";
}

export interface CodeIndex {
  symbols: Map<string, CodeSymbol[]>;
  dependencies: DependencyEdge[];
  fileCount: number;
  lastUpdated: number;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  "__pycache__", ".cache", ".venv", "venv", "target", "vendor",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
]);

const MAX_INDEX_FILES = 500;
const CACHE_TTL_MS = 60000;

let cachedIndex: CodeIndex | null = null;
let cacheRootUri: string | null = null;
let cacheTimestamp = 0;

export async function getCodeIndex(forceRefresh = false): Promise<CodeIndex> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return emptyIndex();

  const now = Date.now();
  if (!forceRefresh && cachedIndex && cacheRootUri === root.uri.toString() && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedIndex;
  }

  const symbols: Map<string, CodeSymbol[]> = new Map();
  const dependencies: DependencyEdge[] = [];
  let fileCount = 0;

  await walkDirectory(root.uri, "", symbols, dependencies, 0, (count) => {
    fileCount = count;
  });

  cachedIndex = { symbols, dependencies, fileCount, lastUpdated: now };
  cacheRootUri = root.uri.toString();
  cacheTimestamp = now;
  return cachedIndex;
}

async function walkDirectory(
  baseUri: vscode.Uri,
  relativePath: string,
  symbols: Map<string, CodeSymbol[]>,
  dependencies: DependencyEdge[],
  depth: number,
  onFileCount: (count: number) => void
): Promise<void> {
  if (depth > 6) return;

  const uri = relativePath ? vscode.Uri.joinPath(baseUri, relativePath) : baseUri;
  let entries: [string, vscode.FileType][];

  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return;
  }

  let fileCount = 0;

  for (const [name, type] of entries) {
    if (IGNORED_DIRS.has(name)) continue;

    const childPath = relativePath ? `${relativePath}/${name}` : name;

    if (type === vscode.FileType.Directory) {
      await walkDirectory(baseUri, childPath, symbols, dependencies, depth + 1, onFileCount);
    } else if (type === vscode.FileType.File) {
      const ext = name.substring(name.lastIndexOf("."));
      if (!CODE_EXTENSIONS.has(ext)) continue;
      fileCount++;

      try {
        const fileUri = vscode.Uri.joinPath(baseUri, childPath);
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString("utf8");
        const fileSymbols = extractSymbols(content, childPath, ext);
        if (fileSymbols.length > 0) {
          symbols.set(childPath, fileSymbols);
        }
        const fileDeps = extractDependencies(content, childPath, ext);
        dependencies.push(...fileDeps);
      } catch {
        continue;
      }

      if (fileCount >= MAX_INDEX_FILES) break;
    }
  }

  onFileCount(fileCount);
}

function extractSymbols(content: string, filePath: string, ext: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      symbols.push(...extractTSSymbols(line, lineNum, filePath));
    } else if (ext === ".py") {
      symbols.push(...extractPythonSymbols(line, lineNum, filePath));
    } else if (ext === ".go") {
      symbols.push(...extractGoSymbols(line, lineNum, filePath));
    }
  }

  return symbols;
}

function extractTSSymbols(line: string, lineNum: number, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const col = 0;

  const funcMatch = line.match(
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
  );
  if (funcMatch) {
    symbols.push({
      name: funcMatch[1],
      kind: "function",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  const arrowMatch = line.match(
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+)?\s*=\s*(?:async\s*)?\(/
  );
  if (arrowMatch) {
    symbols.push({
      name: arrowMatch[1],
      kind: "function",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  const classMatch = line.match(
    /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/
  );
  if (classMatch) {
    symbols.push({
      name: classMatch[1],
      kind: "class",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  const interfaceMatch = line.match(
    /^(?:export\s+)?interface\s+(\w+)/
  );
  if (interfaceMatch) {
    symbols.push({
      name: interfaceMatch[1],
      kind: "interface",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  const typeMatch = line.match(
    /^(?:export\s+)?type\s+(\w+)/
  );
  if (typeMatch) {
    symbols.push({
      name: typeMatch[1],
      kind: "type",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  const constMatch = line.match(
    /^(?:export\s+)?const\s+(\w+)\s*[:=]/
  );
  if (constMatch && !arrowMatch) {
    symbols.push({
      name: constMatch[1],
      kind: "variable",
      path: filePath,
      line: lineNum,
      column: col,
      signature: line.trim().slice(0, 200),
    });
  }

  return symbols;
}

function extractPythonSymbols(line: string, lineNum: number, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
  if (funcMatch) {
    symbols.push({
      name: funcMatch[1],
      kind: "function",
      path: filePath,
      line: lineNum,
      column: 0,
      signature: line.trim().slice(0, 200),
    });
  }

  const classMatch = line.match(/^class\s+(\w+)/);
  if (classMatch) {
    symbols.push({
      name: classMatch[1],
      kind: "class",
      path: filePath,
      line: lineNum,
      column: 0,
      signature: line.trim().slice(0, 200),
    });
  }

  return symbols;
}

function extractGoSymbols(line: string, lineNum: number, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  const funcMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
  if (funcMatch) {
    symbols.push({
      name: funcMatch[1],
      kind: "function",
      path: filePath,
      line: lineNum,
      column: 0,
      signature: line.trim().slice(0, 200),
    });
  }

  const structMatch = line.match(/^type\s+(\w+)\s+struct/);
  if (structMatch) {
    symbols.push({
      name: structMatch[1],
      kind: "class",
      path: filePath,
      line: lineNum,
      column: 0,
      signature: line.trim().slice(0, 200),
    });
  }

  return symbols;
}

function extractDependencies(content: string, filePath: string, ext: string): DependencyEdge[] {
  const deps: DependencyEdge[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      const importMatch = line.match(
        /import\s+(?:.*from\s+)?["']([^"']+)["']/
      );
      if (importMatch && isRelativePath(importMatch[1])) {
        deps.push({
          from: filePath,
          to: resolveRelative(filePath, importMatch[1]),
          kind: "import",
        });
      }

      const dynamicMatch = line.match(
        /import\s*\(\s*["']([^"']+)["']\s*\)/
      );
      if (dynamicMatch && isRelativePath(dynamicMatch[1])) {
        deps.push({
          from: filePath,
          to: resolveRelative(filePath, dynamicMatch[1]),
          kind: "dynamic-import",
        });
      }

      const requireMatch = line.match(
        /require\s*\(\s*["']([^"']+)["']\s*\)/
      );
      if (requireMatch && isRelativePath(requireMatch[1])) {
        deps.push({
          from: filePath,
          to: resolveRelative(filePath, requireMatch[1]),
          kind: "require",
        });
      }
    } else if (ext === ".py") {
      const importMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(\S+)/);
      if (importMatch) {
        const module = importMatch[1] || importMatch[2];
        if (module.startsWith(".")) {
          deps.push({
            from: filePath,
            to: resolveRelative(filePath, module),
            kind: "import",
          });
        }
      }
    } else if (ext === ".go") {
      const importMatch = line.match(/"([^"]+)"/);
      if (importMatch && !importMatch[1].includes(".") && isRelativePath(importMatch[1])) {
        deps.push({
          from: filePath,
          to: importMatch[1],
          kind: "import",
        });
      }
    }
  }

  return deps;
}

function isRelativePath(importPath: string): boolean {
  return importPath.startsWith("./") || importPath.startsWith("../");
}

function resolveRelative(from: string, importPath: string): string {
  const fromDir = from.substring(0, from.lastIndexOf("/"));
  const parts = (fromDir + "/" + importPath).split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }

  let result = resolved.join("/");
  if (!result.match(/\.\w+$/)) {
    const candidates = [".ts", ".tsx", ".js", ".jsx", ".py", ".go"];
    for (const ext of candidates) {
      result = result + ext;
      break;
    }
  }

  return result;
}

export function findSymbolsByName(index: CodeIndex, name: string): CodeSymbol[] {
  const results: CodeSymbol[] = [];
  for (const [, symbols] of index.symbols) {
    for (const sym of symbols) {
      if (sym.name === name || sym.name.toLowerCase() === name.toLowerCase()) {
        results.push(sym);
      }
    }
  }
  return results;
}

export function findDependenciesOf(index: CodeIndex, filePath: string): DependencyEdge[] {
  return index.dependencies.filter((dep) => dep.from === filePath);
}

export function findDependentsOf(index: CodeIndex, filePath: string): DependencyEdge[] {
  return index.dependencies.filter((dep) => dep.to === filePath);
}

export function symbolsToString(symbols: CodeSymbol[], maxCount = 30): string {
  return symbols
    .slice(0, maxCount)
    .map((s) => `  [${s.kind}] ${s.name} in ${s.path}:${s.line} ${s.signature ? `- ${s.signature}` : ""}`)
    .join("\n");
}

function emptyIndex(): CodeIndex {
  return { symbols: new Map(), dependencies: [], fileCount: 0, lastUpdated: 0 };
}
