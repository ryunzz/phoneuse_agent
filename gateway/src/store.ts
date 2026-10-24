import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateId, generateSecret, hashSecret } from './auth.js';

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly revoked: boolean;
}

export interface RigRecord {
  readonly id: string;
  readonly name: string;
  readonly hash: string;
  readonly createdAt: string;
}

interface StoreData {
  readonly keys: readonly ApiKeyRecord[];
  readonly rigs: readonly RigRecord[];
}

const EMPTY: StoreData = { keys: [], rigs: [] };

/** Repository for API keys and rigs. JSON file for the hackathon; swap for a database later. */
export interface Store {
  findKeyBySecret(secret: string): ApiKeyRecord | null;
  findRigBySecret(secret: string): RigRecord | null;
  listKeys(): readonly ApiKeyRecord[];
  listRigs(): readonly RigRecord[];
  createKey(name: string): { record: ApiKeyRecord; secret: string };
  createRig(name: string): { record: RigRecord; secret: string };
  revokeKey(id: string): ApiKeyRecord;
}

function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new Error('Name must be 1-100 characters');
  return trimmed;
}

export class JsonFileStore implements Store {
  private snapshot: StoreData;
  private mtimeMs = -1;

  constructor(private readonly file: string) {
    this.snapshot = EMPTY;
    this.reloadIfChanged();
  }

  /** Pick up keys/rigs created by the admin CLI while the gateway is running. */
  private reloadIfChanged(): void {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (mtimeMs !== this.mtimeMs) {
      this.snapshot = JsonFileStore.read(this.file);
      this.mtimeMs = mtimeMs;
    }
  }

  private get data(): StoreData {
    this.reloadIfChanged();
    return this.snapshot;
  }

  private static read(file: string): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreData>;
      return { keys: parsed.keys ?? [], rigs: parsed.rigs ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw new Error(`Could not read store ${file}: ${(error as Error).message}`);
    }
  }

  private commit(next: StoreData): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
    this.snapshot = next;
    this.mtimeMs = statSync(this.file).mtimeMs;
  }

  findKeyBySecret(secret: string): ApiKeyRecord | null {
    const hash = hashSecret(secret);
    return this.data.keys.find((key) => key.hash === hash && !key.revoked) ?? null;
  }

  findRigBySecret(secret: string): RigRecord | null {
    const hash = hashSecret(secret);
    return this.data.rigs.find((rig) => rig.hash === hash) ?? null;
  }

  listKeys(): readonly ApiKeyRecord[] {
    return this.data.keys;
  }

  listRigs(): readonly RigRecord[] {
    return this.data.rigs;
  }

  createKey(name: string): { record: ApiKeyRecord; secret: string } {
    const secret = generateSecret('pu');
    const record: ApiKeyRecord = {
      id: generateId('key'),
      name: validName(name),
      hash: hashSecret(secret),
      createdAt: new Date().toISOString(),
      revoked: false,
    };
    this.commit({ ...this.data, keys: [...this.data.keys, record] });
    return { record, secret };
  }

  createRig(name: string): { record: RigRecord; secret: string } {
    const secret = generateSecret('rig');
    const record: RigRecord = {
      id: generateId('rig'),
      name: validName(name),
      hash: hashSecret(secret),
      createdAt: new Date().toISOString(),
    };
    this.commit({ ...this.data, rigs: [...this.data.rigs, record] });
    return { record, secret };
  }

  revokeKey(id: string): ApiKeyRecord {
    const existing = this.data.keys.find((key) => key.id === id);
    if (!existing) throw new Error(`No API key ${id}`);
    const revoked = { ...existing, revoked: true };
    this.commit({ ...this.data, keys: this.data.keys.map((key) => (key.id === id ? revoked : key)) });
    return revoked;
  }
}
