import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface UsageEvent {
  readonly keyId: string;
  readonly tool: string;
  readonly rigId: string | null;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly at: string;
}

export interface UsageSummary {
  readonly keyId: string;
  readonly calls: number;
  readonly failedCalls: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly rigMs: number;
  readonly byTool: Readonly<Record<string, number>>;
}

function emptySummary(keyId: string): UsageSummary {
  return { keyId, calls: 0, failedCalls: 0, images: 0, imageBytes: 0, rigMs: 0, byTool: {} };
}

function addEvent(summary: UsageSummary, event: UsageEvent): UsageSummary {
  return {
    ...summary,
    calls: summary.calls + 1,
    failedCalls: summary.failedCalls + (event.ok ? 0 : 1),
    images: summary.images + event.images,
    imageBytes: summary.imageBytes + event.imageBytes,
    rigMs: summary.rigMs + (event.rigId ? event.durationMs : 0),
    byTool: { ...summary.byTool, [event.tool]: (summary.byTool[event.tool] ?? 0) + 1 },
  };
}

/** Append-only usage ledger (JSONL) with in-memory per-key totals. */
export class UsageLedger {
  private totals = new Map<string, UsageSummary>();

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of lines) {
      try {
        this.apply(JSON.parse(line) as UsageEvent);
      } catch {
        console.warn(`[usage] skipping malformed ledger line in ${file}`);
      }
    }
  }

  private apply(event: UsageEvent): void {
    this.totals.set(event.keyId, addEvent(this.totals.get(event.keyId) ?? emptySummary(event.keyId), event));
  }

  record(event: Omit<UsageEvent, 'at'>): void {
    const full: UsageEvent = { ...event, at: new Date().toISOString() };
    appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    this.apply(full);
  }

  summary(keyId: string): UsageSummary {
    return this.totals.get(keyId) ?? emptySummary(keyId);
  }
}

/** Rough Claude image-token estimate (width*height/750), for usage reporting only. */
export function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.ceil((width * scale * height * scale) / 750);
}
