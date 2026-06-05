/**
 * Project Memory — persistent learning that survives across sessions.
 *
 * Stored at .shogo/memory/project.json in the workspace.
 * Loaded at session start, updated after each task.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logInfo, logDebug, logWarn } from "../logger";

export interface Learning {
  id: string;
  category: "architecture" | "pattern" | "error" | "preference" | "convention" | "dependency";
  content: string;
  source: string; // file path or tool call that produced this learning
  confidence: number; // 0-1, higher = more certain
  timestamp: number;
  timesConfirmed: number;
}

export interface ProjectMemoryData {
  projectName: string;
  lastUpdated: number;
  learnings: Learning[];
  errorPatterns: ErrorPattern[];
  projectConventions: string[];
}

export interface ErrorPattern {
  pattern: string;
  solution: string;
  occurrences: number;
  lastSeen: number;
}

const MEMORY_DIR = ".shogo";
const MEMORY_FILE = ".shogo/memory/project.json";
const MAX_LEARNINGS = 200;
const MAX_ERROR_PATTERNS = 50;

let cachedMemory: ProjectMemoryData | null = null;

function getMemoryPath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  return path.join(root, MEMORY_FILE);
}

/**
 * Load project memory from disk. Returns empty memory if file doesn't exist.
 */
export function loadProjectMemory(): ProjectMemoryData {
  if (cachedMemory) return cachedMemory;

  const memPath = getMemoryPath();
  if (!memPath || !fs.existsSync(memPath)) {
    cachedMemory = createEmptyMemory();
    return cachedMemory;
  }

  try {
    const raw = fs.readFileSync(memPath, "utf-8");
    const data = JSON.parse(raw) as ProjectMemoryData;
    cachedMemory = data;
    logDebug(`Loaded project memory: ${data.learnings.length} learnings, ${data.errorPatterns.length} error patterns`);
    return data;
  } catch (err) {
    logWarn(`Failed to load project memory: ${err}`);
    cachedMemory = createEmptyMemory();
    return cachedMemory;
  }
}

/**
 * Save project memory to disk.
 */
export function saveProjectMemory(data: ProjectMemoryData): void {
  const memPath = getMemoryPath();
  if (!memPath) return;

  try {
    const dir = path.dirname(memPath);
    fs.mkdirSync(dir, { recursive: true });
    data.lastUpdated = Date.now();
    fs.writeFileSync(memPath, JSON.stringify(data, null, 2), "utf-8");
    cachedMemory = data;
    logDebug(`Saved project memory: ${data.learnings.length} learnings`);
  } catch (err) {
    logWarn(`Failed to save project memory: ${err}`);
  }
}

/**
 * Add a learning to project memory.
 */
export function addLearning(
  category: Learning["category"],
  content: string,
  source: string,
  confidence: number = 0.8,
): void {
  const memory = loadProjectMemory();

  // Check for duplicate/similar learning
  const existing = memory.learnings.find(
    (l) => l.category === category && l.content.toLowerCase() === content.toLowerCase()
  );

  if (existing) {
    existing.timesConfirmed++;
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    existing.timestamp = Date.now();
    logDebug(`Confirmed existing learning: ${content.slice(0, 50)}`);
  } else {
    const learning: Learning = {
      id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category,
      content,
      source,
      confidence,
      timestamp: Date.now(),
      timesConfirmed: 1,
    };
    memory.learnings.push(learning);

    // Trim old low-confidence learnings if over capacity
    if (memory.learnings.length > MAX_LEARNINGS) {
      memory.learnings.sort((a, b) => {
        const scoreA = a.confidence * (1 + a.timesConfirmed * 0.1);
        const scoreB = b.confidence * (1 + b.timesConfirmed * 0.1);
        return scoreB - scoreA;
      });
      memory.learnings = memory.learnings.slice(0, MAX_LEARNINGS);
    }
  }

  saveProjectMemory(memory);
}

/**
 * Record an error pattern with its solution.
 */
export function recordErrorPattern(pattern: string, solution: string): void {
  const memory = loadProjectMemory();

  const existing = memory.errorPatterns.find(
    (ep) => ep.pattern.toLowerCase() === pattern.toLowerCase()
  );

  if (existing) {
    existing.occurrences++;
    existing.lastSeen = Date.now();
    // Update solution if the new one is more detailed
    if (solution.length > existing.solution.length) {
      existing.solution = solution;
    }
  } else {
    memory.errorPatterns.push({
      pattern,
      solution,
      occurrences: 1,
      lastSeen: Date.now(),
    });

    if (memory.errorPatterns.length > MAX_ERROR_PATTERNS) {
      memory.errorPatterns.sort((a, b) => b.occurrences - a.occurrences);
      memory.errorPatterns = memory.errorPatterns.slice(0, MAX_ERROR_PATTERNS);
    }
  }

  saveProjectMemory(memory);
}

/**
 * Get learnings as a formatted string for injection into context.
 */
export function formatMemoryForContext(): string {
  const memory = loadProjectMemory();
  if (memory.learnings.length === 0 && memory.errorPatterns.length === 0) {
    return "";
  }

  const parts: string[] = ["## Project Memory (persisted across sessions)"];

  if (memory.learnings.length > 0) {
    parts.push("");
    parts.push("### Learnings");
    const sorted = [...memory.learnings].sort(
      (a, b) => b.confidence * (1 + b.timesConfirmed * 0.1) - a.confidence * (1 + a.timesConfirmed * 0.1)
    );
    for (const l of sorted.slice(0, 30)) {
      parts.push(`- [${l.category}] ${l.content} (confirmed ${l.timesConfirmed}x)`);
    }
  }

  if (memory.errorPatterns.length > 0) {
    parts.push("");
    parts.push("### Known Error Patterns");
    for (const ep of memory.errorPatterns.slice(0, 15)) {
      parts.push(`- **${ep.pattern}** → ${ep.solution} (seen ${ep.occurrences}x)`);
    }
  }

  if (memory.projectConventions.length > 0) {
    parts.push("");
    parts.push("### Project Conventions");
    for (const c of memory.projectConventions) {
      parts.push(`- ${c}`);
    }
  }

  return parts.join("\n");
}

/**
 * Reset the cache (for testing or after external modifications).
 */
export function resetMemoryCache(): void {
  cachedMemory = null;
}

function createEmptyMemory(): ProjectMemoryData {
  const root = vscode.workspace.workspaceFolders?.[0];
  return {
    projectName: root?.name ?? "unknown",
    lastUpdated: Date.now(),
    learnings: [],
    errorPatterns: [],
    projectConventions: [],
  };
}
