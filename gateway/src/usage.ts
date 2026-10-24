import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Base tokens charged per successful call, on top of the image tokens it returns. */
export const DEFAULT_PRICING: Readonly<Record<string, number>> = {
  phone_screenshot: 50,
  phone_tap: 100,
  phone_scroll: 100,
  phone_type: 100,
  phone_home: 100,
  phone_live_feed: 200,
  phone_connect: 0,
  phone_disconnect: 0,
  phone_task_done: 0,
  rigs_list: 0,
  usage_get: 0,
};

export interface UsageEvent {
  readonly keyId: string;
  readonly tool: string;
  readonly rigId: string | null;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly imageTokens: number;
  readonly tokens: number;
  readonly at: string;
}

export type UsageInput = Omit<UsageEvent, 'at' | 'tokens'>;

export interface ToolUsage {
  readonly calls: number;
  readonly tokens: number;
}

export interface RecentCall {
  readonly tool: string;
  readonly ok: boolean;
  readonly tokens: number;
  readonly imageTokens: number;
  readonly durationMs: number;
  readonly at: string;
}

export interface UsageSummary {
  readonly keyId: string;
  readonly calls: number;
  readonly failedCalls: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly rigMs: number;
  readonly tokens: number;
  readonly imageTokens: number;
  readonly byTool: Readonly<Record<string, ToolUsage>>;
}

export interface UsageReport extends UsageSummary {
  readonly recent: readonly RecentCall[];
  readonly perMinute: readonly { readonly minute: string; readonly tokens: number }[];
  readonly pricing: Readonly<Record<string, number>>;
}

const RECENT_LIMIT = 50;
const WINDOW_MINUTES = 60;
const MINUTE = 60_000;

function emptySummary(keyId: string): UsageSummary {
  return { keyId, calls: 0, failedCalls: 0, images: 0, imageBytes: 0, rigMs: 0, tokens: 0, imageTokens: 0, byTool: {} };
}

function addEvent(summary: UsageSummary, event: UsageEvent): UsageSummary {
  const tool = summary.byTool[event.tool] ?? { calls: 0, tokens: 0 };
  return {
    ...summary,
    calls: summary.calls + 1,
    failedCalls: summary.failedCalls + (event.ok ? 0 : 1),
    images: summary.images + event.images,
    imageBytes: summary.imageBytes + event.imageBytes,
    rigMs: summary.rigMs + (event.rigId ? event.durationMs : 0),
    tokens: summary.tokens + event.tokens,
    imageTokens: summary.imageTokens + event.imageTokens,
    byTool: { ...summary.byTool, [event.tool]: { calls: tool.calls + 1, tokens: tool.tokens + event.tokens } },
  };
}

/** Older ledger lines predate token metering; treat their missing fields as zero. */
function normalize(raw: Partial<UsageEvent>): UsageEvent | null {
  if (typeof raw.keyId !== 'string' || typeof raw.tool !== 'string' || typeof raw.at !== 'string') return null;
  return {
    keyId: raw.keyId,
    tool: raw.tool,
    rigId: raw.rigId ?? null,
    ok: raw.ok === true,
    durationMs: raw.durationMs ?? 0,
    images: raw.images ?? 0,
    imageBytes: raw.imageBytes ?? 0,
    imageTokens: raw.imageTokens ?? 0,
    tokens: raw.tokens ?? 0,
    at: raw.at,
  };
}

/** Append-only usage ledger (JSONL) with in-memory per-key totals and a recent window. */
export class UsageLedger {
  private totals = new Map<string, UsageSummary>();
  private windows = new Map<string, readonly UsageEvent[]>();

  constructor(
    private readonly file: string,
    readonly pricing: Readonly<Record<string, number>> = DEFAULT_PRICING,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of lines) {
      try {
        const event = normalize(JSON.parse(line) as Partial<UsageEvent>);
        if (event) this.apply(event);
      } catch {
        console.warn(`[usage] skipping malformed ledger line in ${file}`);
      }
    }
  }

  private apply(event: UsageEvent): void {
    this.totals.set(event.keyId, addEvent(this.totals.get(event.keyId) ?? emptySummary(event.keyId), event));
    const cutoff = this.now() - WINDOW_MINUTES * MINUTE;
    const kept = (this.windows.get(event.keyId) ?? []).filter((item) => Date.parse(item.at) >= cutoff);
    this.windows.set(event.keyId, [...kept, event].slice(-2000));
  }

  /** Tokens billed for a call: base price plus image tokens, and nothing for failures. */
  price(event: UsageInput): number {
    return event.ok ? (this.pricing[event.tool] ?? 0) + event.imageTokens : 0;
  }

  record(event: UsageInput): UsageEvent {
    const full: UsageEvent = { ...event, tokens: this.price(event), at: new Date(this.now()).toISOString() };
    appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    this.apply(full);
    return full;
  }

  summary(keyId: string): UsageSummary {
    return this.totals.get(keyId) ?? emptySummary(keyId);
  }

  report(keyId: string): UsageReport {
    const events = this.windows.get(keyId) ?? [];
    const currentMinute = Math.floor(this.now() / MINUTE);
    const buckets = new Map<number, number>();
    for (const event of events) {
      const minute = Math.floor(Date.parse(event.at) / MINUTE);
      buckets.set(minute, (buckets.get(minute) ?? 0) + event.tokens);
    }
    const perMinute = Array.from({ length: WINDOW_MINUTES }, (_, index) => {
      const minute = currentMinute - (WINDOW_MINUTES - 1) + index;
      return { minute: new Date(minute * MINUTE).toISOString(), tokens: buckets.get(minute) ?? 0 };
    });
    const recent = events
      .slice(-RECENT_LIMIT)
      .reverse()
      .map(({ tool, ok, tokens, imageTokens, durationMs, at }) => ({ tool, ok, tokens, imageTokens, durationMs, at }));
    return { ...this.summary(keyId), recent, perMinute, pricing: this.pricing };
  }
}

/** Rough Claude image-token estimate (width*height/750 after downscaling to 1568px), for metering. */
export function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.ceil((width * scale * height * scale) / 750);
}

/** Read width/height from a baseline or progressive JPEG's SOF marker; null if not found. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrameHeader) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}
