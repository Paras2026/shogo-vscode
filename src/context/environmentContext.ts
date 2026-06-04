import * as os from "os";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { logDebug, logWarn } from "../logger";

/**
 * Detects the runtime environment once and caches it.
 * Provides OS, shell, installed tools, and terminal state
 * so the LLM knows exactly what environment it's operating in.
 */
export interface EnvironmentContext {
  os: string;
  platform: string;
  arch: string;
  shell: string;
  shellPath: string;
  cwd: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
  pythonVersion: string | null;
  javaVersion: string | null;
  hasRipgrep: boolean;
  hasMake: boolean;
  hasDocker: boolean;
  hasCargo: boolean;
  hasGo: boolean;
  activeTerminals: string[];
  activeTerminalShell: string | null;
  environmentVars: Record<string, string>;
  isRemoteSSH: boolean;
  isWSL: boolean;
  isContainer: boolean;
}

let cachedEnv: EnvironmentContext | null = null;

export async function getEnvironmentContext(): Promise<EnvironmentContext> {
  if (cachedEnv) return cachedEnv;

  const platform = os.platform();
  const arch = os.arch();
  const osType = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  const shell = process.env.SHELL || process.env.COMSPEC || "unknown";
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Detect environment type
  const isWSL = platform === "linux" && (os.release().toLowerCase().includes("microsoft") || !!process.env.WSL_DISTRO_NAME);
  const isRemoteSSH = !!process.env.VSCODE_GIT_IPC_HANDLE || !!process.env.SSH_CLIENT || !!process.env.SSH_TTY;
  const isContainer = !!(process.env.CONTAINER || process.env.DOCKER || process.env.KUBERNETES_SERVICE_HOST);

  // Detect terminals
  const terminals = vscode.window.terminals.map((t) => t.name);
  const activeTerminal = vscode.window.activeTerminal;
  const activeTerminalShell = activeTerminal?.creationOptions && typeof activeTerminal.creationOptions === "object"
    ? (activeTerminal.creationOptions as { shellPath?: string }).shellPath || null
    : null;

  // Detect installed tools in parallel
  const [nodeVersion, npmVersion, gitVersion, pythonVersion, javaVersion,
    hasRipgrep, hasMake, hasDocker, hasCargo, hasGo
  ] = await Promise.all([
    detectTool("node", ["--version"]),
    detectTool("npm", ["--version"]),
    detectTool("git", ["--version"]),
    detectTool("python3", ["--version"]).then(v => v || detectTool("python", ["--version"])),
    detectTool("java", ["-version"]),
    detectTool("rg", ["--version"]),
    detectTool("make", ["--version"]),
    detectTool("docker", ["--version"]),
    detectTool("cargo", ["--version"]),
    detectTool("go", ["version"]),
  ]);

  // Key environment vars (safe subset)
  const envVars: Record<string, string> = {};
  const safeKeys = ["PATH", "HOME", "USER", "SHELL", "COMSPEC", "LANG", "LC_ALL", "NODE_ENV", "CI", "EDITOR", "VISUAL"];
  for (const key of safeKeys) {
    if (process.env[key]) envVars[key] = process.env[key]!;
  }

  cachedEnv = {
    os: osType,
    platform,
    arch,
    shell: require("path").basename(shell),
    shellPath: shell,
    cwd,
    nodeVersion,
    npmVersion,
    gitVersion,
    pythonVersion,
    javaVersion,
    hasRipgrep,
    hasMake,
    hasDocker,
    hasCargo,
    hasGo,
    activeTerminals: terminals,
    activeTerminalShell,
    environmentVars: envVars,
    isRemoteSSH,
    isWSL,
    isContainer,
  };

  logDebug(`Environment detected: ${osType} ${arch}, shell=${cachedEnv.shell}, SSH=${isRemoteSSH}, WSL=${isWSL}`);
  return cachedEnv;
}

/**
 * Format environment context for injection into the LLM system prompt.
 */
export function formatEnvironmentForPrompt(env: EnvironmentContext): string {
  const lines: string[] = [];

  lines.push("## Runtime Environment");
  lines.push(`- OS: ${env.os} (${env.platform} ${env.arch})`);

  if (env.isRemoteSSH) lines.push("- **Connection: Remote SSH**");
  if (env.isWSL) lines.push("- **Connection: WSL (Windows Subsystem for Linux)**");
  if (env.isContainer) lines.push("- **Connection: Container/Docker**");

  lines.push(`- Shell: ${env.shell} (${env.shellPath})`);
  lines.push(`- Working directory: ${env.cwd}`);

  const tools: string[] = [];
  if (env.nodeVersion) tools.push(`Node.js ${env.nodeVersion}`);
  if (env.npmVersion) tools.push(`npm ${env.npmVersion}`);
  if (env.gitVersion) tools.push(`git ${env.gitVersion}`);
  if (env.pythonVersion) tools.push(`Python ${env.pythonVersion}`);
  if (env.javaVersion) tools.push(`Java`);
  if (env.hasRipgrep) tools.push("ripgrep (rg)");
  if (env.hasMake) tools.push("make");
  if (env.hasDocker) tools.push("Docker");
  if (env.hasCargo) tools.push("Rust/Cargo");
  if (env.hasGo) tools.push("Go");

  if (tools.length > 0) {
    lines.push(`- Installed tools: ${tools.join(", ")}`);
  }

  if (env.activeTerminals.length > 0) {
    lines.push(`- Open terminals: ${env.activeTerminals.join(", ")}`);
  }

  // Platform-specific guidance
  lines.push("");
  lines.push("### Platform Rules");
  if (env.os === "Windows") {
    lines.push("- Use PowerShell or cmd commands. NOT bash.");
    lines.push("- Path separators: backslash (\\). Use forward slash in code but backslash in shell.");
    lines.push("- Common commands: dir, type, copy, move, del, powershell Get-ChildItem");
    lines.push("- DO NOT use: ls, cat, grep, chmod, which, apt, brew");
  } else {
    lines.push("- Use bash/sh commands.");
    lines.push("- Path separators: forward slash (/).");
    lines.push("- Common commands: ls, cat, grep, find, chmod, which");
    if (env.os === "Linux") {
      lines.push("- Package managers: apt (Debian/Ubuntu), yum/dnf (RHEL/Fedora), apk (Alpine)");
    }
    if (env.os === "macOS") {
      lines.push("- Package managers: brew (Homebrew)");
    }
  }

  return lines.join("\n");
}

/**
 * Build environment-aware error context for tool failures.
 * Tells the LLM WHY a tool failed based on the environment.
 */
export function buildEnvironmentErrorContext(env: EnvironmentContext, toolName: string, error: string): string {
  const parts: string[] = [`Environment: ${env.os} (${env.platform} ${env.arch}), Shell: ${env.shell}`];

  if (env.isRemoteSSH) parts.push("Connection: Remote SSH");
  if (env.isWSL) parts.push("Connection: WSL");

  // Diagnose common failures
  if (error.includes("ENOENT")) {
    if (env.os === "Windows") {
      parts.push("Diagnosis: File or command not found. On Windows, use 'where' instead of 'which'. Check if the command exists in PATH.");
    } else {
      parts.push("Diagnosis: File or command not found. Use 'which' or 'find' to locate it.");
    }
  }

  if (error.includes("EACCES") || error.includes("Permission denied")) {
    parts.push("Diagnosis: Permission denied. May need elevated privileges or file permissions.");
  }

  if (error.includes("spawn") && error.includes("ENOENT")) {
    const cmd = error.match(/spawn (\S+)/)?.[1] || "unknown";
    if (env.os === "Windows") {
      parts.push(`Diagnosis: Command "${cmd}" not found. On Windows, try: where ${cmd}`);
    } else {
      parts.push(`Diagnosis: Command "${cmd}" not found. On ${env.os}, try: which ${cmd}`);
    }
  }

  if (error.includes("SIGTERM") || error.includes("timeout")) {
    parts.push("Diagnosis: Command timed out or was killed. May be hanging on user input. Set CI=true to prevent interactive prompts.");
  }

  if (error.includes("not a git repository")) {
    parts.push("Diagnosis: Not inside a git repository. Git operations require a .git directory.");
  }

  if (toolName === "runCommand" && env.os === "Windows" && error.includes("bash")) {
    parts.push("Diagnosis: Tried to use bash on Windows. Use PowerShell or cmd instead.");
  }

  if (toolName === "findReferences" || toolName === "goToDefinition" || toolName === "getSymbolInfo") {
    parts.push("Diagnosis: LSP tool failed. Check that a language server is installed for this file type.");
    if (!env.nodeVersion) parts.push("Node.js is not installed — TypeScript/JavaScript LSP requires it.");
  }

  return parts.join("\n");
}

// ── Helpers ──

async function detectTool(name: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(name, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      env: { ...process.env, CI: "true" },
    });
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    proc.on("close", () => {
      const version = stdout.trim().split("\n")[0];
      resolve(version || null);
    });
    proc.on("error", () => resolve(null));
  });
}
