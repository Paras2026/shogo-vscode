import type { ToolResult } from "./types";

interface CacheEntry {
  result: ToolResult;
  timestamp: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 100;

export class ToolCache {
  private cache = new Map<string, CacheEntry>();

  private makeKey(tool: string, input: Record<string, unknown>): string {
    return `${tool}:${JSON.stringify(input)}`;
  }

  get(tool: string, input: Record<string, unknown>): ToolResult | undefined {
    const key = this.makeKey(tool, input);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(tool: string, input: Record<string, unknown>, result: ToolResult): void {
    const key = this.makeKey(tool, input);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}
