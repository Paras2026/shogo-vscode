import * as vscode from "vscode";
import { getWorkspaceRoot, truncateText } from "../tools/workspace";

export interface AgentConfig {
  approvalMode: "ask" | "auto-readonly";
  maxToolSteps: number;
  preferredSearch: "workspace" | "index";
  autoIndex: boolean;
  rules?: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  approvalMode: "ask",
  maxToolSteps: 16,
  preferredSearch: "workspace",
  autoIndex: false,
};

export async function loadAgentConfig(): Promise<AgentConfig> {
  const root = getWorkspaceRoot();
  if (!root) {
    return DEFAULT_CONFIG;
  }

  const config = { ...DEFAULT_CONFIG };
  try {
    const agentUri = vscode.Uri.joinPath(root.uri, ".shogo", "agent.json");
    const raw = Buffer.from(await vscode.workspace.fs.readFile(agentUri)).toString("utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (parsed.approvalMode === "ask" || parsed.approvalMode === "auto-readonly") {
      config.approvalMode = parsed.approvalMode;
    }
    if (typeof parsed.maxToolSteps === "number") {
      config.maxToolSteps = Math.min(Math.max(parsed.maxToolSteps, 1), 32);
    }
    if (parsed.preferredSearch === "workspace" || parsed.preferredSearch === "index") {
      config.preferredSearch = parsed.preferredSearch;
    }
    if (typeof parsed.autoIndex === "boolean") {
      config.autoIndex = parsed.autoIndex;
    }
  } catch {
    // Config is optional.
  }

  try {
    const rulesUri = vscode.Uri.joinPath(root.uri, ".shogo", "rules.md");
    const rules = Buffer.from(await vscode.workspace.fs.readFile(rulesUri)).toString("utf8").trim();
    if (rules) {
      config.rules = truncateText(rules, 8000);
    }
  } catch {
    // Rules are optional.
  }

  return config;
}

export function buildConfigInstructions(config: AgentConfig): string {
  const parts = [
    `Agent config: approvalMode=${config.approvalMode}, maxToolSteps=${config.maxToolSteps}, preferredSearch=${config.preferredSearch}, autoIndex=${config.autoIndex}.`,
    "Respect .shogo/rules.md when present. If rules conflict with the user's current explicit request, ask for clarification before changing files.",
  ];

  if (config.rules) {
    parts.push(`Workspace rules from .shogo/rules.md:\n\n${config.rules}`);
  }

  return parts.join("\n\n");
}
