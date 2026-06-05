/**
 * Structured Error Recovery — analyzes tool failures and suggests recovery strategies.
 *
 * When a tool call fails, this module:
 * 1. Categorizes the error (file_not_found, permission, syntax, etc.)
 * 2. Suggests a recovery strategy
 * 3. Provides retry feedback for the LLM to self-correct
 */

import type { EnvironmentContext } from "../context/environmentContext";

export type ErrorCategory =
  | "file_not_found"
  | "permission_denied"
  | "syntax_error"
  | "type_error"
  | "command_failed"
  | "command_timeout"
  | "lsp_error"
  | "git_error"
  | "network_error"
  | "unknown";

export interface ErrorAnalysis {
  category: ErrorCategory;
  rootCause: string;
  recoveryStrategy: string;
  retryHint: string;
  shouldRetry: boolean;
  suggestedTool?: string;
}

/**
 * Analyze a tool failure and return structured recovery guidance.
 */
export function analyzeToolError(
  toolName: string,
  input: Record<string, unknown>,
  error: string,
  retryCount: number,
  env?: EnvironmentContext,
): ErrorAnalysis {
  const category = categorizeError(error);
  const analysis = buildAnalysis(category, toolName, input, error, retryCount, env);
  return analysis;
}

function categorizeError(error: string): ErrorCategory {
  const lower = error.toLowerCase();

  if (lower.includes("enoent") || lower.includes("file not found") || lower.includes("no such file")) {
    return "file_not_found";
  }
  if (lower.includes("eacces") || lower.includes("permission denied")) {
    return "permission_denied";
  }
  if (lower.includes("syntax") || lower.includes("parse") || lower.includes("unexpected token")) {
    return "syntax_error";
  }
  if (lower.includes("type") || lower.includes("cannot assign") || lower.includes("not assignable")) {
    return "type_error";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("sigterm")) {
    return "command_timeout";
  }
  if (lower.includes("exit code") || lower.includes("command failed") || lower.includes("non-zero")) {
    return "command_failed";
  }
  if (lower.includes("lsp") || lower.includes("language server") || lower.includes("no provider")) {
    return "lsp_error";
  }
  if (lower.includes("git") || lower.includes("not a git repository")) {
    return "git_error";
  }
  if (lower.includes("econnrefused") || lower.includes("network") || lower.includes("fetch")) {
    return "network_error";
  }
  return "unknown";
}

function buildAnalysis(
  category: ErrorCategory,
  toolName: string,
  input: Record<string, unknown>,
  error: string,
  retryCount: number,
  env?: EnvironmentContext,
): ErrorAnalysis {
  const maxRetries = 3;

  switch (category) {
    case "file_not_found": {
      const path = typeof input.path === "string" ? input.path : "unknown";
      return {
        category,
        rootCause: `File "${path}" does not exist at the specified path.`,
        recoveryStrategy: "Verify the path exists. Use listFiles to discover available files.",
        retryHint: `The file "${path}" was not found. Use listFiles to find the correct path, then retry.`,
        shouldRetry: retryCount < maxRetries,
        suggestedTool: "listFiles",
      };
    }

    case "permission_denied": {
      return {
        category,
        rootCause: "Permission denied — the file or directory requires elevated privileges.",
        recoveryStrategy: "Check file permissions with ls -la. May need sudo or chmod.",
        retryHint: "Permission denied. Check if the file is writable: ls -la <path>. Try chmod if needed.",
        shouldRetry: retryCount < 1, // Don't auto-retry permission errors
      };
    }

    case "syntax_error": {
      const path = typeof input.path === "string" ? input.path : "unknown";
      return {
        category,
        rootCause: `Syntax error in ${path}. The file has invalid syntax.`,
        recoveryStrategy: "Read the file, find the syntax error, and fix it.",
        retryHint: `Syntax error detected in ${path}. Read the file around the error location and fix the syntax.`,
        shouldRetry: retryCount < maxRetries,
        suggestedTool: "readFile",
      };
    }

    case "command_failed": {
      return {
        category,
        rootCause: `Command exited with non-zero exit code. ${error}`,
        recoveryStrategy: "Read the error output. Identify the root cause before retrying.",
        retryHint: `Command failed. Analyze the error output above, fix the issue, then retry with a different approach.`,
        shouldRetry: retryCount < maxRetries,
      };
    }

    case "command_timeout": {
      return {
        category,
        rootCause: "Command timed out — likely hanging on user input or taking too long.",
        recoveryStrategy: "Set CI=true to prevent interactive prompts. Increase timeout or use runBackground.",
        retryHint: "Command timed out. If it requires user input, add CI=true or --yes flag. For long commands, use runBackground.",
        shouldRetry: retryCount < 2,
        suggestedTool: "runBackground",
      };
    }

    case "lsp_error": {
      return {
        category,
        rootCause: "LSP tool failed — language server may not be running for this file type.",
        recoveryStrategy: "Fall back to searchWorkspace for text-based search.",
        retryHint: "LSP not available for this file type. Use searchWorkspace instead.",
        shouldRetry: false,
        suggestedTool: "searchWorkspace",
      };
    }

    case "git_error": {
      return {
        category,
        rootCause: "Git operation failed — may not be in a git repository.",
        recoveryStrategy: "Check git status. Initialize repo if needed.",
        retryHint: "Git operation failed. Check: git status. If not a repo, run: git init",
        shouldRetry: retryCount < 2,
      };
    }

    case "network_error": {
      return {
        category,
        rootCause: "Network error — connection refused or unreachable.",
        recoveryStrategy: "Check network connectivity. Verify the URL.",
        retryHint: "Network error. Check connectivity and verify the endpoint URL.",
        shouldRetry: retryCount < 2,
      };
    }

    default: {
      return {
        category: "unknown",
        rootCause: error,
        recoveryStrategy: "Analyze the error message and try a different approach.",
        retryHint: `Tool "${toolName}" failed: ${error.slice(0, 200)}. Try a different approach.`,
        shouldRetry: retryCount < maxRetries,
      };
    }
  }
}

/**
 * Build a retry feedback message for the LLM.
 * This is injected into the conversation when a tool fails.
 */
export function buildErrorFeedback(
  toolName: string,
  input: Record<string, unknown>,
  error: string,
  retryCount: number,
  env?: EnvironmentContext,
): string {
  const analysis = analyzeToolError(toolName, input, error, retryCount, env);

  const parts: string[] = [
    `Tool ${toolName} failed (attempt ${retryCount}/3).`,
    ``,
    `**Root Cause:** ${analysis.rootCause}`,
    `**Category:** ${analysis.category}`,
    `**Recovery:** ${analysis.recoveryStrategy}`,
  ];

  if (analysis.suggestedTool) {
    parts.push(`**Suggested tool:** ${analysis.suggestedTool}`);
  }

  parts.push(``);
  parts.push(`Do NOT blindly retry the same call. ${analysis.retryHint}`);

  if (env) {
    parts.push(``);
    parts.push(`Environment: ${env.os} (${env.platform}), Shell: ${env.shell}`);
  }

  return parts.join("\n");
}
