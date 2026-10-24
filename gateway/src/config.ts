import path from 'node:path';

export interface Config {
  readonly host: string;
  readonly port: number;
  /** Base URL clients use to reach this gateway; live-feed links are built from it. */
  readonly publicUrl: string;
  readonly dataDir: string;
  readonly limits: Limits;
}

export interface Limits {
  readonly mcpRequestsPerMinute: number;
  readonly leaseIdleMs: number;
  readonly rigOnlineMs: number;
  readonly commandTimeoutMs: number;
  readonly settleMs: number;
  readonly liveTokenMs: number;
  readonly maxFrameBytes: number;
  readonly maxJsonBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  mcpRequestsPerMinute: 120,
  leaseIdleMs: 10 * 60_000,
  rigOnlineMs: 40_000,
  commandTimeoutMs: 20_000,
  settleMs: 700,
  liveTokenMs: 30 * 60_000,
  maxFrameBytes: 2_000_000,
  maxJsonBytes: 1_000_000,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got ${env.PORT}`);
  }
  const host = env.HOST ?? '127.0.0.1';
  const publicUrl = (env.PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) {
    throw new Error('PUBLIC_URL must start with http:// or https://');
  }
  return {
    host,
    port,
    publicUrl,
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    limits: DEFAULT_LIMITS,
  };
}
