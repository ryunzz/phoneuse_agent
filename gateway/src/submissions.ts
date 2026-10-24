import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Recordings come from the iPhone app; the gateway never infers actions from them. */
export const RECORDING_SOURCE = 'screen_recording_import';
export const CONSENT_VERSION = '2026-10-24';
export const DEFAULT_TASKS_FILE = fileURLToPath(new URL('../tasks.json', import.meta.url));

export class SubmissionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  version: z.number().int().positive(),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  targetApp: z.string().min(1).max(60),
  estimatedMinutes: z.number().positive().max(60),
  startingConditions: z.string().max(500),
  steps: z.array(z.string().min(1).max(300)).min(1).max(20),
  evidence: z.string().max(500),
  notes: z.string().max(500).default(''),
  /** Shown only when configured; the seed catalog has none. */
  reward: z.object({ amount: z.number().positive(), unit: z.string().min(1).max(16) }).nullable().default(null),
});

export type Task = z.infer<typeof taskSchema>;

export function loadTasks(file = DEFAULT_TASKS_FILE): readonly Task[] {
  const tasks = z.array(taskSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error(`Duplicate task ids in ${file}`);
  return tasks;
}

export const createSubmissionSchema = z.object({
  attemptId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  taskVersion: z.number().int().positive(),
  consentVersion: z.literal(CONSENT_VERSION),
  consentedAt: z.string().datetime({ offset: true }),
  outcome: z.enum(['succeeded', 'failed', 'blocked']),
  note: z.string().max(2000).default(''),
  durationSeconds: z.number().min(0).max(3600),
  device: z.object({
    model: z.string().min(1).max(64),
    systemVersion: z.string().min(1).max(32),
    locale: z.string().min(1).max(64),
  }).strict(),
}).strict();

export const reviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approved'), reason: z.string().max(2000).default('') }).strict(),
  z.object({ decision: z.literal('rejected'), reason: z.string().trim().min(1, 'A rejection needs a reason').max(2000) }).strict(),
]);

export type SubmissionState = 'awaiting_media' | 'uploaded' | 'pending_review' | 'approved' | 'rejected';

export interface Review {
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
  readonly at: string;
}

export interface Media {
  readonly file: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly uploadedAt: string;
}

export interface Submission {
  readonly id: string;
  readonly attemptId: string;
  readonly contributorId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskTitle: string;
  readonly consent: { readonly version: string; readonly at: string };
  readonly outcome: 'succeeded' | 'failed' | 'blocked';
  readonly note: string;
  /** Reported by the app from the video file; not re-measured on the Mac. */
  readonly durationSeconds: number;
  readonly device: { readonly model: string; readonly systemVersion: string; readonly locale: string };
  readonly recordingSource: string;
  readonly state: SubmissionState;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly media: Media | null;
  readonly reviews: readonly Review[];
}

export const VIDEO_TYPES: Readonly<Record<string, string>> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

const COMPLETED: readonly SubmissionState[] = ['pending_review', 'approved', 'rejected'];

/** One directory per submission: meta.json plus the media file. */
export class SubmissionStore {
  private readonly byId = new Map<string, Submission>();

  constructor(private readonly dir: string, private readonly tasks: readonly Task[]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const meta = path.join(dir, entry.name, 'meta.json');
      if (entry.isDirectory() && existsSync(meta)) {
        const record = JSON.parse(readFileSync(meta, 'utf8')) as Submission;
        this.byId.set(record.id, record);
      }
    }
  }

  listTasks(): readonly Task[] {
    return this.tasks;
  }

  private save(next: Submission): Submission {
    const folder = path.join(this.dir, next.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temp = path.join(folder, `meta.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, path.join(folder, 'meta.json'));
    this.byId.set(next.id, next);
    return next;
  }

  /** Owner check that hides other contributors' submissions behind a 404. */
  owned(id: string, contributorId: string): Submission {
    const record = this.byId.get(id);
    if (!record || record.contributorId !== contributorId) throw new SubmissionError(404, 'No such submission');
    return record;
  }

  get(id: string): Submission {
    const record = this.byId.get(id);
    if (!record) throw new SubmissionError(404, 'No such submission');
    return record;
  }

  /** Idempotent on (contributor, attemptId): a retried create returns the existing record. */
  create(contributorId: string, input: z.infer<typeof createSubmissionSchema>): { record: Submission; created: boolean } {
    for (const record of this.byId.values()) {
      if (record.attemptId === input.attemptId) {
        if (record.contributorId !== contributorId) throw new SubmissionError(409, 'attemptId already used');
        return { record, created: false };
      }
    }
    const task = this.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new SubmissionError(404, 'No such task');
    if (task.version !== input.taskVersion) throw new SubmissionError(409, 'Task has changed; reload the task list');
    const record = this.save({
      id: `sub_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      attemptId: input.attemptId,
      contributorId,
      taskId: task.id,
      taskVersion: task.version,
      taskTitle: task.title,
      consent: { version: input.consentVersion, at: input.consentedAt },
      outcome: input.outcome,
      note: input.note,
      durationSeconds: input.durationSeconds,
      device: input.device,
      recordingSource: RECORDING_SOURCE,
      state: 'awaiting_media',
      createdAt: new Date().toISOString(),
      completedAt: null,
      media: null,
      reviews: [],
    });
    return { record, created: true };
  }

  /** Where an upload streams before attachMedia moves it into place. */
  uploadTarget(id: string, contributorId: string): string {
    const record = this.owned(id, contributorId);
    if (COMPLETED.includes(record.state)) throw new SubmissionError(409, 'Submission is already complete');
    return path.join(this.dir, id, `upload.${randomBytes(6).toString('hex')}.tmp`);
  }

  attachMedia(id: string, contributorId: string, temp: string, contentType: string, bytes: number, sha256: string): Submission {
    const record = this.owned(id, contributorId);
    if (COMPLETED.includes(record.state)) {
      rmSync(temp, { force: true });
      throw new SubmissionError(409, 'Submission is already complete');
    }
    const file = `media.${VIDEO_TYPES[contentType]}`;
    if (record.media && record.media.file !== file) rmSync(path.join(this.dir, id, record.media.file), { force: true });
    renameSync(temp, path.join(this.dir, id, file));
    return this.save({ ...record, state: 'uploaded', media: { file, contentType, bytes, sha256, uploadedAt: new Date().toISOString() } });
  }

  /** Enters the review queue only when the stored file matches the checksum the app computed. */
  complete(id: string, contributorId: string, sha256: string): Submission {
    const record = this.owned(id, contributorId);
    if (COMPLETED.includes(record.state)) {
      if (record.media?.sha256 !== sha256) throw new SubmissionError(409, 'Submission was completed with a different file');
      return record;
    }
    if (!record.media || !existsSync(this.mediaPath(record))) throw new SubmissionError(409, 'Upload the recording first');
    if (record.media.sha256 !== sha256) throw new SubmissionError(409, 'Checksum mismatch; upload the recording again');
    return this.save({ ...record, state: 'pending_review', completedAt: new Date().toISOString() });
  }

  review(id: string, decision: z.infer<typeof reviewSchema>): Submission {
    const record = this.get(id);
    if (!COMPLETED.includes(record.state)) throw new SubmissionError(409, 'Submission is not complete yet');
    const entry: Review = { decision: decision.decision, reason: decision.reason, at: new Date().toISOString() };
    return this.save({ ...record, state: decision.decision, reviews: [...record.reviews, entry] });
  }

  mediaPath(record: Submission): string {
    if (!record.media) throw new SubmissionError(404, 'No recording uploaded');
    return path.join(this.dir, record.id, record.media.file);
  }

  forContributor(contributorId: string): Submission[] {
    return [...this.byId.values()]
      .filter((record) => record.contributorId === contributorId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Review queue: completed submissions only, newest first, plus totals. */
  queue(): { submissions: Submission[]; stats: Record<string, number> } {
    const submissions = [...this.byId.values()]
      .filter((record) => COMPLETED.includes(record.state))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    const count = (state: SubmissionState) => submissions.filter((record) => record.state === state).length;
    const reviewed = count('approved') + count('rejected');
    return {
      submissions,
      stats: {
        total: submissions.length,
        pending: count('pending_review'),
        approved: count('approved'),
        rejected: count('rejected'),
        reviewRate: submissions.length ? reviewed / submissions.length : 0,
        reportedFailed: submissions.filter((record) => record.outcome === 'failed').length,
        reportedBlocked: submissions.filter((record) => record.outcome === 'blocked').length,
        unfinishedUploads: this.byId.size - submissions.length,
      },
    };
  }
}
