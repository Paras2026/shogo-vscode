/**
 * Token Budget Guard — prevents runaway API spend.
 *
 * Tracks input/output tokens and dollar cost per task.
 * Warns at 75% (configurable), pauses at 100% and requires approval.
 */

export interface BudgetConfig {
  enabled: boolean;
  limitTokens: number;
  limitDollars: number;
  warnAtPercent: number;
  hardStopPercent: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface BudgetCheckResult {
  action: "continue" | "warn" | "pause";
  reason?: string;
  usage: Usage;
  percentUsed: number;
}

export interface BudgetSummary {
  usage: Usage;
  config: BudgetConfig;
  percentUsed: number;
  approvalCount: number;
  toolCallsAtLastApproval: number;
}

interface ApprovalCheckpoint {
  timestamp: number;
  usage: Usage;
  percentUsed: number;
}

export const MODEL_PRICING: Record<string, { inputPerToken: number; outputPerToken: number }> = {
  "claude-sonnet-4-5":   { inputPerToken: 3e-6,   outputPerToken: 15e-6 },
  "claude-sonnet-4-6":   { inputPerToken: 3e-6,   outputPerToken: 15e-6 },
  "claude-opus-4-5":     { inputPerToken: 15e-6,  outputPerToken: 75e-6 },
  "claude-opus-4-6":     { inputPerToken: 15e-6,  outputPerToken: 75e-6 },
  "claude-haiku-4-5-20251001": { inputPerToken: 0.8e-6, outputPerToken: 4e-6 },
  "claude-haiku-3-5":    { inputPerToken: 0.8e-6, outputPerToken: 4e-6 },
  "gpt-4o":              { inputPerToken: 2.5e-6, outputPerToken: 10e-6 },
  "gpt-4o-mini":         { inputPerToken: 0.15e-6,outputPerToken: 0.6e-6 },
  "mimo-v2.5":           { inputPerToken: 3e-6,   outputPerToken: 15e-6 },
  "hoshi-1.0":           { inputPerToken: 3e-6,   outputPerToken: 15e-6 },
};

const DEFAULT_CONFIG: BudgetConfig = {
  enabled: true,
  limitTokens: 100000,
  limitDollars: 5.0,
  warnAtPercent: 75,
  hardStopPercent: 100,
};

export class TokenBudget {
  private config: BudgetConfig;
  private usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 };
  private approvalHistory: ApprovalCheckpoint[] = [];
  private continuationApproved = false;
  private warningShown = false;
  private toolCallsSinceLastApproval = 0;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Track token usage from a completed LLM streaming response.
   * Call this after every streamChat() completes.
   */
  trackUsage(model: string, inputTokens: number, outputTokens: number): void {
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
    this.usage.totalTokens += inputTokens + outputTokens;

    const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-5"];
    const cost = inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken;
    this.usage.totalCost += cost;
    this.toolCallsSinceLastApproval++;
  }

  /**
   * Check if the budget needs attention.
   * Call this after every LLM call.
   */
  check(): BudgetCheckResult {
    if (!this.config.enabled) {
      return { action: "continue", usage: this.usage, percentUsed: 0 };
    }

    const percentUsed = (this.usage.totalCost / this.config.limitDollars) * 100;

    // Hard stop — require approval
    if (percentUsed >= this.config.hardStopPercent && !this.continuationApproved) {
      return {
        action: "pause",
        reason: "hard_stop",
        usage: this.usage,
        percentUsed,
      };
    }

    // Warning — approaching limit
    if (percentUsed >= this.config.warnAtPercent && !this.warningShown) {
      this.warningShown = true;
      return {
        action: "warn",
        reason: "approaching_limit",
        usage: this.usage,
        percentUsed,
      };
    }

    return { action: "continue", usage: this.usage, percentUsed };
  }

  /**
   * User approved continuation — reset the pause state.
   */
  approve(): void {
    this.continuationApproved = true;
    this.warningShown = false;
    this.toolCallsSinceLastApproval = 0;
    this.approvalHistory.push({
      timestamp: Date.now(),
      usage: { ...this.usage },
      percentUsed: (this.usage.totalCost / this.config.limitDollars) * 100,
    });
  }

  /**
   * Increase the budget limit (user chose "Increase Budget").
   */
  increaseLimit(additionalDollars: number): void {
    this.config.limitDollars += additionalDollars;
    this.config.limitTokens = Math.round(this.config.limitTokens * (1 + additionalDollars / this.config.limitDollars));
    this.approve(); // Also resets the pause state
  }

  /**
   * Get a summary for the approval UI.
   */
  getSummary(): BudgetSummary {
    return {
      usage: { ...this.usage },
      config: { ...this.config },
      percentUsed: (this.usage.totalCost / this.config.limitDollars) * 100,
      approvalCount: this.approvalHistory.length,
      toolCallsAtLastApproval: this.toolCallsSinceLastApproval,
    };
  }

  /**
   * Get remaining budget in dollars.
   */
  getRemaining(): number {
    return Math.max(0, this.config.limitDollars - this.usage.totalCost);
  }

  /**
   * Get usage formatted as a human-readable string.
   */
  formatUsage(): string {
    return `$${this.usage.totalCost.toFixed(4)} / $${this.config.limitDollars.toFixed(2)} (${Math.round((this.usage.totalCost / this.config.limitDollars) * 100)}%) — ${this.usage.totalTokens.toLocaleString()} tokens`;
  }

  /**
   * Check if budget is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reset for a new task.
   */
  reset(): void {
    this.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 };
    this.approvalHistory = [];
    this.continuationApproved = false;
    this.warningShown = false;
    this.toolCallsSinceLastApproval = 0;
  }
}
