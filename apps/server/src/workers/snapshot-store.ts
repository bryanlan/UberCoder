import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { privateDirectory } from './audit.js';

const summary = z.object({ task: z.string().max(180), latest: z.string().max(180), coordination: z.string().max(180) }).strict();
const cached = z.object({ id: z.string().min(1).max(256), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTask: z.string().max(180), summary, updatedAt: z.string().datetime(), stale: z.boolean() }).strict();
const worker = z.object({ id: z.string().min(1).max(256), projectSlug: z.string().min(1).max(256),
  projectName: z.string().max(512), provider: z.enum(['codex', 'claude']), conversationRef: z.string().min(1).max(4096),
  title: z.string().max(4096), working: z.boolean(), task: z.string().max(180), summary: summary.nullable(),
  summaryAt: z.string().datetime().nullable(), stale: z.boolean() }).strict();
const schema = z.object({ version: z.literal(1), updatedAt: z.string().datetime(),
  workers: z.array(worker).max(512), cached: z.array(cached).max(128) }).strict();
export type SavedWorkerSnapshot = z.infer<typeof schema>;
export type CachedWorkerSummary = Omit<SavedWorkerSnapshot['cached'][number], 'id'>;
const MAX_BYTES = 2 * 1024 * 1024;

/** One private latest snapshot, separate from the content-free token audit. */
export class WorkerSnapshotStore {
  private pending: Promise<void> = Promise.resolve();
  private readonly file: string;
  constructor(private readonly directory: string) { this.file = path.join(directory, 'latest.json'); }

  private async checkFile(): Promise<void> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Saved worker snapshot is unavailable.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async read(): Promise<SavedWorkerSnapshot | null> {
    await privateDirectory(this.directory);
    await this.checkFile();
    try { return schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  save(snapshot: SavedWorkerSnapshot): Promise<void> {
    const text = JSON.stringify(schema.parse(snapshot)) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Saved worker snapshot exceeded its limit.');
    const job = this.pending.catch(() => {}).then(async () => {
      await privateDirectory(this.directory); await this.checkFile();
      const temporary = path.join(this.directory, `latest-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        await this.checkFile();
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.pending = job;
    return job;
  }

  async settled(): Promise<void> { await this.pending; }
}
