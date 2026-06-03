import * as vscode from "vscode";
import { getProjectStructure, flattenProjectTree, type ProjectNode } from "./projectIndexer";

const GIT_IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

export interface SmartContextResult {
  projectTree: string;
  relevantFiles: FileReference[];
  recentChanges: GitChange[];
  tokenEstimate: number;
}

export interface FileReference {
  path: string;
  relevance: number;
  reason: string;
}

export interface GitChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

const MAX_RELEVANT_FILES = 15;
const MAX_TREE_DEPTH_OUTPUT = 50;
const MAX_RECENT_CHANGES = 10;
const CONTEXT_TOKEN_BUDGET = 12000;

export async function gatherSmartContext(
  userMessage: string,
  activeFilePath?: string
): Promise<SmartContextResult> {
  const [projectTree, recentChanges] = await Promise.all([
    getProjectTreeFormatted(),
    getRecentGitChanges(),
  ]);

  const allFiles = await getAllSourceFiles();
  const relevantFiles = rankFilesByRelevance(userMessage, allFiles, activeFilePath);

  const tokenEstimate =
    projectTree.length / 4 +
    relevantFiles.reduce((sum, f) => sum + f.path.length / 4, 0) +
    recentChanges.reduce((sum, c) => sum + c.path.length / 4, 0);

  return { projectTree, relevantFiles, recentChanges, tokenEstimate };
}

async function getProjectTreeFormatted(): Promise<string> {
  const tree = await getProjectStructure();
  if (!tree) return "";

  const flat = flattenProjectTree(tree);
  const lines: string[] = [];
  let count = 0;

  for (const node of flat) {
    if (count >= MAX_TREE_DEPTH_OUTPUT) {
      lines.push(`  ... and ${flat.length - count} more items`);
      break;
    }
    const depth = node.path.split("/").length - 1;
    if (depth > 4) continue;
    const indent = "  ".repeat(depth);
    const icon = node.type === "directory" ? "📁" : "📄";
    lines.push(`${indent}${icon} ${node.name}`);
    count++;
  }

  return lines.join("\n");
}

async function getAllSourceFiles(): Promise<ProjectNode[]> {
  const tree = await getProjectStructure();
  if (!tree) return [];
  return flattenProjectTree(tree).filter((n) => n.type === "file" && n.extension);
}

function rankFilesByRelevance(
  query: string,
  files: ProjectNode[],
  activeFilePath?: string
): FileReference[] {
  const queryLower = query.toLowerCase();
  const queryTerms = extractQueryTerms(queryLower);

  const scored = files.map((file) => {
    let score = 0;
    const reasons: string[] = [];
    const filePath = file.path.toLowerCase();
    const fileName = file.name.toLowerCase();

    if (activeFilePath && file.path === activeFilePath) {
      score += 10;
      reasons.push("active file");
    }

    for (const term of queryTerms) {
      if (fileName.includes(term)) {
        score += 5;
        reasons.push(`name matches "${term}"`);
      }
      if (filePath.includes(term)) {
        score += 3;
        reasons.push(`path matches "${term}"`);
      }
    }

    if (isTestFile(file.path) && /test|spec|fix/i.test(queryLower)) {
      score += 4;
      reasons.push("test file for test query");
    }

    if (isConfigFile(file.path) && /config|setup|install|depend/i.test(queryLower)) {
      score += 3;
      reasons.push("config file for config query");
    }

    if (isComponentFile(file.path) && /component|ui|render|view|page/i.test(queryLower)) {
      score += 3;
      reasons.push("component for UI query");
    }

    if (isStyleFile(file.path) && /style|css|design|theme|color/i.test(queryLower)) {
      score += 3;
      reasons.push("style file for styling query");
    }

    if (isEntryFile(file.path)) {
      score += 2;
      reasons.push("entry point");
    }

    const depth = file.path.split("/").length;
    if (depth <= 2) score += 1;

    return {
      path: file.path,
      relevance: score,
      reason: reasons.length > 0 ? reasons.join("; ") : "low relevance",
    };
  });

  return scored
    .filter((f) => f.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_RELEVANT_FILES);
}

function extractQueryTerms(query: string): string[] {
  const stopwords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "don", "now", "and", "but", "or", "if", "it", "this", "that", "my",
    "your", "its", "our", "what", "which", "who", "whom", "me", "him",
    "her", "us", "them", "i", "you", "he", "she", "we", "they",
  ]);

  return query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !stopwords.has(t));
}

function isTestFile(path: string): boolean {
  return /\.(test|spec|e2e|integration)\.(ts|tsx|js|jsx)$/.test(path) ||
    path.includes("__tests__") ||
    path.includes("/test/") ||
    path.includes("/tests/");
}

function isConfigFile(path: string): boolean {
  return /(package\.json|tsconfig|webpack|vite|babel|eslint|prettier|jest|vitest|\.config\.)/i.test(path);
}

function isComponentFile(path: string): boolean {
  return /\.(tsx|jsx|vue|svelte)$/.test(path);
}

function isStyleFile(path: string): boolean {
  return /\.(css|scss|less|sass|styled|style)$/.test(path);
}

function isEntryFile(path: string): boolean {
  return /(index|main|app|server|entry)\.(ts|tsx|js|jsx)$/.test(path);
}

async function getRecentGitChanges(): Promise<GitChange[]> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return [];

  try {
    const output = await runGitCommand("git status --porcelain", root.uri.fsPath);
    if (!output) return [];

    return output
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, MAX_RECENT_CHANGES)
      .map((line) => {
        const statusChar = line.charAt(0);
        const filePath = line.slice(3).trim();
        let status: GitChange["status"] = "modified";
        if (statusChar === "A") status = "added";
        else if (statusChar === "D") status = "deleted";
        else if (statusChar === "R") status = "renamed";
        return { path: filePath, status };
      });
  } catch {
    return [];
  }
}

async function runGitCommand(command: string, cwd: string): Promise<string> {
  const { spawn } = await import("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git exited with code ${code}`));
    });
    child.on("error", reject);
    setTimeout(() => { child.kill(); reject(new Error("git timeout")); }, 5000);
  });
}
