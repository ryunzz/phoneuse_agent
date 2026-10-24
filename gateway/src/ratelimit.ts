/** Fixed-window per-key rate limiter. */
export class RateLimiter {
  private windows = new Map<string, { readonly start: number; readonly count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const current = this.windows.get(key);
    const window = current && now - current.start < this.windowMs ? current : { start: now, count: 0 };
    if (window.count >= this.max) return false;
    this.windows.set(key, { ...window, count: window.count + 1 });
    return true;
  }
}
