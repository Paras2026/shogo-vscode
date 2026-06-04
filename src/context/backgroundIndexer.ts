/**
 * Background Indexer — Spawns a detached ripgrep process to build a persistent
 * project map. Runs once on extension activate, refreshes on file changes.
 * 
 * The agent reads .shogo/project_map.json instead of calling projectMap every time.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logInfo, logDebug, logWarn } from "../logger";

const INDEX_DIR = ".shogo";
const INDEX_FILE = "project_map.json";
const REFRESH_DEBOUNCE_MS = 5000;

export interface ProjectMapEntry {
  path: string;
  lines: number;
  symbols: string[];
  language: string;
}

export interface ProjectMap {
  generatedAt: number;
  workspaceRoot: string;
  fileCount: number;
  totalLines: number;
  files: ProjectMapEntry[];
  directoryTree: string;
}

let cachedMap: ProjectMap | undefined;
let indexerRunning = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let watcher: vscode.FileSystemWatcher | undefined;

function getIndexDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return undefined;
  return path.join(root.uri.fsPath, INDEX_DIR);
}

function getIndexPath(): string | undefined {
  const dir = getIndexDir();
  return dir ? path.join(dir, INDEX_FILE) : undefined;
}

/**
 * Load the cached project map from disk (synchronous, fast).
 */
export function loadProjectMap(): ProjectMap | undefined {
  if (cachedMap) return cachedMap;

  const indexPath = getIndexPath();
  if (!indexPath || !fs.existsSync(indexPath)) return undefined;

  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    cachedMap = JSON.parse(raw) as ProjectMap;
    logDebug(`Loaded project map: ${cachedMap.fileCount} files, ${cachedMap.totalLines} lines`);
    return cachedMap;
  } catch {
    return undefined;
  }
}

/**
 * Get the cached project map or trigger a refresh.
 */
export function getProjectMap(): ProjectMap | undefined {
  return cachedMap;
}

/**
 * Build directory tree string from the project map.
 */
function buildDirectoryTree(files: ProjectMapEntry[]): string {
  const tree: Record<string, unknown> = {};
  for (const file of files) {
    const parts = file.path.split(/[/\\]/);
    let current = tree;
    for (const part of parts) {
      if (!current[part]) current[part] = {};
      current = current[part] as Record<string, unknown>;
    }
  }
  return renderTree(tree, "", true);
}

function renderTree(node: Record<string, unknown>, prefix: string, isLast: boolean): string {
  const lines: string[] = [];
  const entries = Object.keys(node).sort();
  
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    const isLastEntry = i === entries.length - 1;
    const connector = isLastEntry ? "└── " : "├── ";
    lines.push(`${prefix}${connector}${name}`);
    
    if (Object.keys(node[name] as Record<string, unknown>).length > 0) {
      const newPrefix = prefix + (isLastEntry ? "    " : "│   ");
      lines.push(renderTree(node[name] as Record<string, unknown>, newPrefix, isLastEntry));
    }
  }
  
  return lines.join("\n");
}

/**
 * Get file language from extension.
 */
function getLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript-react",
    ".js": "javascript", ".jsx": "javascript-react",
    ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".rb": "ruby", ".php": "php",
    ".css": "css", ".scss": "scss", ".html": "html",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".md": "markdown", ".sql": "sql", ".sh": "shell",
    ".vue": "vue", ".svelte": "svelte",
  };
  return map[ext] || ext.slice(1) || "unknown";
}

/**
 * Extract exported symbols from file content using regex (fast).
 */
function extractSymbols(content: string, language: string): string[] {
  const symbols: string[] = [];
  
  // JS/TS: export function/class/const/type/interface
  if (["typescript", "typescript-react", "javascript", "javascript-react"].includes(language)) {
    const patterns = [
      /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
      /export\s+(?:default\s+)?class\s+(\w+)/g,
      /export\s+(?:const|let|var)\s+(\w+)/g,
      /export\s+type\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+enum\s+(\w+)/g,
    ];
    for (const p of patterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(content)) !== null) {
        if (!symbols.includes(m[1])) symbols.push(m[1]);
      }
    }
  }

  // Python
  if (language === "python") {
    const patterns = [
      /def\s+(\w+)\s*\(/g,
      /class\s+(\w+)/g,
    ];
    for (const p of patterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(content)) !== null) {
        if (!symbols.includes(m[1]) && !m[1].startsWith("_")) symbols.push(m[1]);
      }
    }
  }

  // Rust
  if (language === "rust") {
    const patterns = [
      /pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+(\w+)/g,
    ];
    for (const p of patterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(content)) !== null) {
        if (!symbols.includes(m[1])) symbols.push(m[1]);
      }
    }
  }

  // Go
  if (language === "go") {
    const patterns = [
      /func\s+(?:\([^)]+\)\s+)?(\w+)/g,
      /type\s+(\w+)/g,
    ];
    for (const p of patterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(content)) !== null) {
        if (!symbols.includes(m[1])) symbols.push(m[1]);
      }
    }
  }

  return symbols.slice(0, 50); // Cap per file
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go",
  ".java", ".rb", ".php", ".css", ".scss", ".html",
  ".vue", ".svelte", ".md", ".json", ".yaml", ".yml",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "coverage", ".vscode", "__pycache__", ".cache",
  "out", "target", ".shogo",
]);

const MAX_DEPTH = 6;
const MAX_FILE_SIZE = 500_000;

/**
 * Cross-platform recursive file walker using Node.js fs.
 * Works identically on Windows, Linux, and macOS.
 */
function walkDir(dirPath: string, depth: number, results: string[]): void {
  if (depth > MAX_DEPTH) return;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, depth + 1, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              results.push(fullPath);
            }
          } catch {}
        }
      }
    }
  } catch {}
}

/**
 * Run the background indexer using native Node.js fs (cross-platform).
 */
async function runIndexer(): Promise<void> {
  if (indexerRunning) return;

  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;

  const indexPath = getIndexPath();
  if (!indexPath) return;

  const dir = getIndexDir()!;
  fs.mkdirSync(dir, { recursive: true });

  indexerRunning = true;
  const startTime = Date.now();
  logInfo("Background indexer started");

  try {
    const rootPath = root.uri.fsPath;
    const files: ProjectMapEntry[] = [];

    // Cross-platform: uses Node.js fs.readdirSync instead of Unix `find`
    const absolutePaths: string[] = [];
    walkDir(rootPath, 0, absolutePaths);

    const filePaths = absolutePaths.map((abs) => path.relative(rootPath, abs));

    // Process files in batches for memory efficiency
    const BATCH_SIZE = 50;
    let totalLines = 0;

    for (let i = 0; i < Math.min(filePaths.length, 2000); i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      for (const relativePath of batch) {
        try {
          const absPath = path.join(rootPath, relativePath);
          const stat = fs.statSync(absPath);
          if (stat.size > 500000) continue; // Skip very large files
          
          const content = fs.readFileSync(absPath, "utf-8");
          const lineCount = content.split("\n").length;
          const language = getLanguage(relativePath);
          const symbols = extractSymbols(content, language);

          files.push({ path: relativePath, lines: lineCount, symbols, language });
          totalLines += lineCount;
        } catch {}
      }
    }

    const map: ProjectMap = {
      generatedAt: Date.now(),
      workspaceRoot: rootPath,
      fileCount: files.length,
      totalLines,
      files,
      directoryTree: buildDirectoryTree(files),
    };

    // Write to disk
    fs.writeFileSync(indexPath, JSON.stringify(map, null, 2), "utf-8");
    cachedMap = map;

    const elapsed = Date.now() - startTime;
    logInfo(`Background indexer completed: ${files.length} files, ${totalLines} lines in ${elapsed}ms`);
  } catch (err) {
    logError(`Background indexer failed: ${err}`);
  } finally {
    indexerRunning = false;
  }
}

function logError(msg: string, err?: unknown): void {
  logWarn(`${msg}${err ? `: ${err}` : ""}`);
}

/**
 * Initialize the background indexer — call on extension activate.
 */
export function initBackgroundIndexer(): void {
  // Load existing index immediately
  loadProjectMap();

  // Run indexer in background
  setTimeout(() => runIndexer(), 1000);

  // Watch for file changes and debounce refresh
  watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,py,rs,go,java}");
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      logDebug("File changes detected — refreshing index");
      runIndexer();
    }, REFRESH_DEBOUNCE_MS);
  };
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
}

/**
 * Dispose the indexer watcher.
 */
export function disposeBackgroundIndexer(): void {
  watcher?.dispose();
  if (refreshTimer) clearTimeout(refreshTimer);
}
