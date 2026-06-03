export type CommandDecision =
  | { action: "allow"; reason: string }
  | { action: "confirm"; reason: string }
  | { action: "block"; reason: string };

const DANGEROUS_PATTERNS = [
  /\brm\s+(-\w*)?r\w*\s+/i,
  /\bRemove-Item\b[\s\S]*\b-Recurse\b[\s\S]*\b-Force\b/i,
  /\bdel\b[\s\S]*\/(s|q)\b/i,
  /\brmdir\b[\s\S]*\/s\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[\w]*f[\w]*d/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
];

const SAFE_PATTERNS = [
  /^\s*npm\s+(test|run\s+(test|lint|build|typecheck|check))\b/i,
  /^\s*pnpm\s+(test|run\s+(test|lint|build|typecheck|check))\b/i,
  /^\s*yarn\s+(test|run\s+(test|lint|build|typecheck|check))\b/i,
  /^\s*bun\s+(test|run\s+(test|lint|build|typecheck|check))\b/i,
  /^\s*npx\s+tsc\s+--noEmit\b/i,
  /^\s*bunx?\s+tsc\s+--noEmit\b/i,
  /^\s*tsc\s+--noEmit\b/i,
  /^\s*git\s+(status|diff|log|show)\b/i,
  /^\s*node\s+[-\w./\\]+\b/i,
];

const RISKY_PATTERNS = [
  /^\s*npm\s+(install|i|add)\b/i,
  /^\s*pnpm\s+(install|add)\b/i,
  /^\s*yarn\s+(install|add)\b/i,
  /^\s*bun\s+add\b/i,
  /^\s*git\s+(checkout|switch|reset|rebase|merge|commit|push|pull)\b/i,
  /\b(curl|wget|Invoke-WebRequest|iwr)\b/i,
  /\b(powershell|pwsh|bash|sh|docker)\b/i,
  /\b(rm|del|Remove-Item|rmdir)\b/i,
];

export function classifyCommand(command: string): CommandDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return { action: "block", reason: "Empty command." };
  }

  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { action: "block", reason: "Command looks destructive." };
  }

  if (SAFE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { action: "allow", reason: "Recognized safe project check command." };
  }

  if (RISKY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { action: "confirm", reason: "Command can modify files, network, git state, or the system." };
  }

  return { action: "confirm", reason: "Unknown command requires approval." };
}
