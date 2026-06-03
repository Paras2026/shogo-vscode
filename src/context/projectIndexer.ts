import * as vscode from "vscode";

export interface ProjectNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: ProjectNode[];
  extension?: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".cache",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode-test",
]);

const IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  ".gitignore",
  ".DS_Store",
  "Thumbs.db",
]);

const MAX_DEPTH = 6;
const MAX_FILES_PER_DIR = 50;

let cachedTree: ProjectNode | null = null;
let cachedRootUri: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000;

export async function getProjectStructure(forceRefresh = false): Promise<ProjectNode | null> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return null;

  const now = Date.now();
  if (!forceRefresh && cachedTree && cachedRootUri === root.uri.toString() && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTree;
  }

  const tree = await buildTree(root.uri, "", 0);
  cachedTree = tree;
  cachedRootUri = root.uri.toString();
  cacheTimestamp = now;
  return tree;
}

async function buildTree(baseUri: vscode.Uri, relativePath: string, depth: number): Promise<ProjectNode | null> {
  if (depth > MAX_DEPTH) return null;

  const uri = relativePath ? vscode.Uri.joinPath(baseUri, relativePath) : baseUri;
  const stat = await vscode.workspace.fs.stat(uri);

  const name = relativePath ? relativePath.split("/").pop() ?? "" : baseUri.path.split("/").pop() ?? "";
  const extension = stat.type === vscode.FileType.File ? getExtension(name) : undefined;

  if (stat.type === vscode.FileType.File) {
    if (IGNORED_FILES.has(name)) return null;
    return { name, path: relativePath, type: "file", extension };
  }

  if (stat.type === vscode.FileType.Directory) {
    if (IGNORED_DIRS.has(name)) return null;

    const children: ProjectNode[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      let fileCount = 0;

      for (const [childName, childType] of entries) {
        if (fileCount >= MAX_FILES_PER_DIR && childType === vscode.FileType.File) continue;

        const childPath = relativePath ? `${relativePath}/${childName}` : childName;
        const child = await buildTree(baseUri, childPath, depth + 1);
        if (child) {
          children.push(child);
          if (childType === vscode.FileType.File) fileCount++;
        }
      }

      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return null;
    }

    return { name, path: relativePath, type: "directory", children };
  }

  return null;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function projectTreeToString(node: ProjectNode, prefix = "", isLast = true): string {
  const connector = isLast ? "└── " : "├── ";
  const icon = node.type === "directory" ? "📁 " : "📄 ";
  const lines = [`${prefix}${connector}${icon}${node.name}`];

  if (node.children) {
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < node.children.length; i++) {
      lines.push(projectTreeToString(node.children[i], childPrefix, i === node.children.length - 1));
    }
  }

  return lines.join("\n");
}

export function flattenProjectTree(node: ProjectNode, acc: ProjectNode[] = []): ProjectNode[] {
  acc.push(node);
  if (node.children) {
    for (const child of node.children) {
      flattenProjectTree(child, acc);
    }
  }
  return acc;
}
