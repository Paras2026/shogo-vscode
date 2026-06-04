import * as vscode from "vscode";
import { spawn } from "child_process";
import * as os from "os";

export interface ProjectNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: ProjectNode[];
  extension?: string;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  "__pycache__", ".cache", ".venv", "venv", "target", "vendor",
  ".gradle", ".idea", ".vscode-test", ".shogo-logs",
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  ".gitignore", ".DS_Store", "Thumbs.db", ".env", ".env.local",
]);

let cachedTree: ProjectNode | null = null;
let cachedRootPath: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000;

export async function getProjectStructure(forceRefresh = false): Promise<ProjectNode | null> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return null;

  const rootPath = root.uri.fsPath;
  const now = Date.now();
  if (!forceRefresh && cachedTree && cachedRootPath === rootPath && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTree;
  }

  const tree = await buildTreeFast(rootPath);
  if (tree) {
    cachedTree = tree;
    cachedRootPath = rootPath;
    cacheTimestamp = now;
  }
  return tree;
}

async function buildTreeFast(rootPath: string): Promise<ProjectNode | null> {
  const platform = os.platform();
  const ignoreArgs = [
    ...Array.from(IGNORED_DIRS).map((d) => `-name ${d} -prune`),
    ...Array.from(IGNORED_FILES).map((f) => `-name ${f}`),
  ].join(" -o ");

  const cmd = platform === "win32"
    ? `cmd /c "dir /s /b /a-d "${rootPath}" 2>nul"`
    : `find "${rootPath}" -maxdepth 6 \\( ${ignoreArgs} \\) -prune -o -print 2>/dev/null | head -2000`;

  try {
    const output = await runCommand(cmd, 5000);
    const lines = output.split("\n").filter((l) => l.trim());

    const rootNode: ProjectNode = {
      name: rootPath.split(/[\\/]/).pop() || rootPath,
      path: "",
      type: "directory",
      children: [],
    };

    const nodeMap = new Map<string, ProjectNode>();
    nodeMap.set("", rootNode);

    for (const line of lines) {
      const relativePath = line.startsWith(rootPath)
        ? line.slice(rootPath.length + 1).replace(/\\/g, "/")
        : line.replace(/\\/g, "/");

      if (!relativePath) continue;

      const parts = relativePath.split("/");
      const fileName = parts[parts.length - 1];

      if (IGNORED_FILES.has(fileName)) continue;
      if (parts.some((p) => IGNORED_DIRS.has(p))) continue;

      let parentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        const prevPath = parentPath;
        parentPath = parentPath ? `${parentPath}/${seg}` : seg;

        if (!nodeMap.has(parentPath)) {
          const dirNode: ProjectNode = {
            name: seg,
            path: prevPath ? `${prevPath}/${seg}` : seg,
            type: "directory",
            children: [],
          };
          nodeMap.set(parentPath, dirNode);
          const parent = nodeMap.get(prevPath);
          if (parent?.children) parent.children.push(dirNode);
        }
      }

      const extension = getExtension(fileName);
      const fileNode: ProjectNode = {
        name: fileName,
        path: relativePath,
        type: "file",
        extension,
      };
      const parent = nodeMap.get(parentPath);
      if (parent?.children) parent.children.push(fileNode);
    }

    for (const node of nodeMap.values()) {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
    }

    return rootNode;
  } catch {
    return buildTreeSlow(rootPath);
  }
}

async function buildTreeSlow(rootPath: string): Promise<ProjectNode | null> {
  try {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    return await buildTreeVscApi(root.uri, "", 0);
  } catch {
    return null;
  }
}

async function buildTreeVscApi(baseUri: vscode.Uri, relativePath: string, depth: number): Promise<ProjectNode | null> {
  if (depth > 6) return null;

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
      for (const [childName, childType] of entries) {
        const childPath = relativePath ? `${relativePath}/${childName}` : childName;
        const child = await buildTreeVscApi(baseUri, childPath, depth + 1);
        if (child) children.push(child);
      }
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch { return null; }
    return { name, path: relativePath, type: "directory", children };
  }

  return null;
}

function runCommand(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeoutMs);
    child.on("close", () => { clearTimeout(timer); resolve(stdout.trim()); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
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
