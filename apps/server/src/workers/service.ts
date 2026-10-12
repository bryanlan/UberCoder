import { createHash, randomUUID } from 'node:crypto';
import type { WorkerCard, WorkerPanelSnapshot } from '@agent-console/shared';
import type { WorkerEvidence } from './evidence.js';
import type { SummaryRunner } from './runtime.js';
import { ZERO_WORKER_USAGE } from './runtime.js';
import { WorkerSummaryAudit, type SummaryAuditRecord } from './audit.js';
import { WorkerSnapshotStore, type CachedWorkerSummary, type SavedWorkerSnapshot } from './snapshot-store.js';

interface EvidenceSource {
  roster(): Promise<WorkerEvidence[]>;
  collect(worker: WorkerEvidence): Promise<WorkerEvidence>;
}
const fingerprint = (w: WorkerEvidence) => createHash('sha256').update(JSON.stringify({ task: w.task,
  actions: w.actions.map((a) => a.text), peers: w.peers })).digest('hex');

export class WorkerPanelService {
  private readonly summaries = new Map<string, CachedWorkerSummary>();
  private saved: SavedWorkerSnapshot | null = null;
  private loaded?: Promise<void>;
  private savedContent = '';
  private snapshotError: string | null = null;
  private job?: Promise<void>;
  private error: string | null = null;
  private auditFailed = false;
  private stopped = false;
  private generation = 0;
  constructor(private readonly source: EvidenceSource, private readonly runner: SummaryRunner,
    private readonly audit: WorkerSummaryAudit, private readonly store: WorkerSnapshotStore, private enabled = true,
    private readonly clock: () => number = Date.now,
    private readonly persistEnabled: (enabled: boolean) => void = () => {}) {}

  private date() { return new Date(this.clock()).toISOString().slice(0, 10); }
  private async loadSnapshot() {
    this.loaded ??= (async () => {
      try {
        this.saved = await this.store.read();
        if (this.saved) {
          for (const { id, ...entry } of this.saved.cached) this.summaries.set(id, entry);
          this.savedContent = JSON.stringify({ workers: this.saved.workers, cached: this.saved.cached });
        }
      } catch { this.snapshotError = 'Saved worker information is unavailable. Tracking can still be switched off.'; }
    })();
    await this.loaded;
  }

  private async saveSnapshot(cards = this.saved?.workers): Promise<void> {
    if (!cards) return;
    const workers = cards.map((card) => {
      const cached = this.summaries.get(card.id);
      return { ...card, summary: cached?.summary ?? card.summary, summaryAt: cached?.updatedAt ?? card.summaryAt,
        stale: Boolean(cached && (cached.stale || cached.sourceTask !== card.task)) };
    });
    const cached = [...this.summaries].map(([id, entry]) => ({ id, ...entry }));
    const content = JSON.stringify({ workers, cached });
    if (content === this.savedContent) return;
    this.saved = { version: 1, updatedAt: new Date(this.clock()).toISOString(), workers, cached };
    this.savedContent = content;
    try { await this.store.save(this.saved); this.snapshotError = null; }
    catch {
      if (this.savedContent === content) this.savedContent = '';
      this.snapshotError = 'Latest worker information could not be saved; it may be older after a restart.';
    }
  }
  private async loadAudit() {
    if (this.auditFailed) return;
    try { await this.audit.load(this.date()); }
    catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; }
  }

  async snapshot(): Promise<WorkerPanelSnapshot> {
    await this.loadSnapshot();
    await this.loadAudit();
    const generation = this.generation;
    const roster = this.enabled ? await this.source.roster() : [];
    if (this.enabled && generation === this.generation) await this.saveSnapshot(roster.map((w) => {
      const cached = this.summaries.get(w.id);
      return { id: w.id, projectSlug: w.projectSlug, projectName: w.projectName, provider: w.provider,
        conversationRef: w.conversationRef, title: w.title, working: w.working, task: w.task,
        summary: cached?.summary ?? null, summaryAt: cached?.updatedAt ?? null, stale: Boolean(cached && (cached.stale || cached.sourceTask !== w.task)) };
    }));
    return { workers: this.saved?.workers ?? [], snapshotAt: this.saved?.updatedAt ?? null,
      workingCount: this.enabled ? (this.saved?.workers.filter((w) => w.working).length ?? 0) : 0, generating: Boolean(this.job),
      enabled: this.enabled && !this.auditFailed, trackingEnabled: this.enabled,
      error: this.snapshotError ?? this.error, usage: this.audit.snapshot(this.date()) };
  }

  async setTracking(enabled: boolean): Promise<WorkerPanelSnapshot> {
    this.persistEnabled(enabled);
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      this.generation++;
      if (!enabled) this.runner.cancel();
    }
    if (!enabled) {
      await this.loadSnapshot();
      await this.saveSnapshot();
      await this.store.settled().catch(() => {}); // Off still takes effect if storage fails; snapshot reports the failure.
    }
    return this.snapshot();
  }

  async refresh(intervalMinutes: number): Promise<WorkerPanelSnapshot> {
    const admittedAt = this.clock();
    await this.loadAudit();
    await this.loadSnapshot();
    if (!this.stopped && this.enabled && !this.auditFailed && !this.job
      && admittedAt - this.audit.lastAttemptAt >= Math.max(1, intervalMinutes) * 60_000 - 1_000) {
      // Reserve before asynchronous evidence collection: all tabs share one in-flight batch.
      const job = this.generate(admittedAt).catch(() => { this.error = 'Worker summaries are unavailable.'; });
      this.job = job;
      void job.finally(() => { if (this.job === job) this.job = undefined; });
    }
    return this.snapshot();
  }

  private async generate(admittedAt: number): Promise<void> {
    const generation = this.generation;
    const cancelled = () => this.stopped || !this.enabled || generation !== this.generation;
    const roster = (await this.source.roster()).filter((w) => w.working).sort((a, b) =>
      (Date.parse(this.summaries.get(a.id)?.updatedAt ?? '') || 0) - (Date.parse(this.summaries.get(b.id)?.updatedAt ?? '') || 0));
    const evidence: WorkerEvidence[] = [];
    for (const worker of roster) {
      if (cancelled()) return;
      const detail = await this.source.collect(worker);
      if (cancelled()) return;
      const cached = this.summaries.get(worker.id);
      if (cached?.fingerprint === fingerprint(detail)) continue;
      if (cached) cached.stale = true;
      evidence.push(detail);
      if (evidence.length === 16) break;
    }
    if (!evidence.length || cancelled()) return;
    // A worker can finish during collection; suppress summaries if nobody is still working.
    const workingIds = new Set((await this.source.roster()).filter((w) => w.working).map((w) => w.id));
    const batch = evidence.filter((w) => workingIds.has(w.id));
    if (!batch.length || cancelled()) return;
    const started = admittedAt; // Cadence starts at request admission, before asynchronous evidence collection.
    const record: SummaryAuditRecord = { id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: null,
      status: 'started', model: 'gpt-6-luna', effort: 'low', workerIds: batch.map((w) => w.id), durationMs: null, usage: null };
    // No paid call may start without a durable audit entry.
    try { await this.audit.record(record); }
    catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; return; }
    try {
      if (cancelled()) { record.status = 'cancelled'; record.usage = { ...ZERO_WORKER_USAGE }; return; }
      const result = await this.runner.run(batch, record.id);
      record.usage = result.usage;
      if (cancelled()) { record.status = 'cancelled'; return; }
      if (!result.summaries) throw new Error('Invalid or incomplete worker summary.');
      record.status = 'completed'; this.error = null;
      for (const summary of result.summaries) {
        const worker = batch.find((w) => w.id === summary.id)!;
        const { id, ...text } = summary;
        this.summaries.delete(summary.id);
        this.summaries.set(id, { fingerprint: fingerprint(worker), sourceTask: worker.task, summary: text,
          updatedAt: new Date(this.clock()).toISOString(), stale: false });
      }
      while (this.summaries.size > 128) this.summaries.delete(this.summaries.keys().next().value!);
      await this.saveSnapshot();
    } catch {
      record.status = cancelled() ? 'cancelled' : 'failed';
      if (!cancelled()) this.error = 'Worker summaries are unavailable.';
    } finally {
      record.finishedAt = new Date(this.clock()).toISOString(); record.durationMs = Math.max(0, this.clock() - started);
      try { await this.audit.record(record); }
      catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; }
    }
  }

  async stop(): Promise<void> { this.stopped = true; this.runner.stop(); await this.job; await this.store.settled().catch(() => {}); }
  async settled(): Promise<void> { await this.job; }
}
