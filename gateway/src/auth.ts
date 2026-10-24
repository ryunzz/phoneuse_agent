import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type SecretKind = 'pu' | 'rig';

/** Secrets are shown once at creation; only their SHA-256 is stored. */
export function generateSecret(kind: SecretKind): string {
  return `${kind}_${randomBytes(24).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function bearerToken(req: IncomingMessage, kind: SecretKind): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1].startsWith(`${kind}_`) || match[1].length > 200) return null;
  return match[1];
}
