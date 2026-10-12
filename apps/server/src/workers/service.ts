import { createHash, randomUUID } from 'node:crypto';
import type { WorkerPanelSnapshot, WorkerSummary } from '@agent-console/shared';
import type { WorkerEvidence } from './evidence.js';
import type { SummaryRunner } from './runtime.js';
import { WorkerSummaryAudit, type SummaryAuditRecord } from './audit.js';

interface EvidenceSource {
  roster(): Promise<WorkerEvidence[]>;
  collect(worker: WorkerEvidence): Promise<WorkerEvidence>;
}
type CachedSummary = { fingerprint: string; sourceTask: string; summary: WorkerSummary; updatedAt: string; stale: boolean };
const fingerprint = (w: WorkerEvidence) => createHash('sha256').update(JSON.stringify({ task: w.task,
  actions: w.actions.map((a) => a.text), peers: w.peers })).digest('hex');

export class WorkerPanelService {
  private readonly summaries = new Map<string, CachedSummary>();
  private job?: Promise<void>;
  private error: string | null = null;
  private auditFailed = false;
  private stopped = false;
  constructor(private readonly source: EvidenceSource, private readonly runner: SummaryRunner,
    private readonly audit: WorkerSummaryAudit, private readonly enabled = true,
    private readonly clock: () => number = Date.now) {}

  private date() { return new Date(this.clock()).toISOString().slice(0, 10); }
  private async loadAudit() {
    if (this.auditFailed) return;
    try { await this.audit.load(this.date()); }
    catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; }
  }

  async snapshot(): Promise<WorkerPanelSnapshot> {
    await this.loadAudit();
    const workers = await this.source.roster();
    return { workers: workers.map((w) => {
      const cached = this.summaries.get(w.id);
      return { id: w.id, projectSlug: w.projectSlug, projectName: w.projectName, provider: w.provider,
        conversationRef: w.conversationRef, title: w.title, working: w.working, task: w.task,
        summary: cached?.summary ?? null, summaryAt: cached?.updatedAt ?? null, stale: Boolean(cached && (cached.stale || cached.sourceTask !== w.task)) };
    }), workingCount: workers.filter((w) => w.working).length, generating: Boolean(this.job),
      enabled: this.enabled && !this.auditFailed, error: this.error, usage: this.audit.snapshot(this.date()) };
  }

  async refresh(intervalMinutes: number): Promise<WorkerPanelSnapshot> {
    const admittedAt = this.clock();
    await this.loadAudit();
    if (!this.stopped && this.enabled && !this.auditFailed && !this.job
      && admittedAt - this.audit.lastAttemptAt >= Math.max(1, intervalMinutes) * 60_000 - 1_000) {
      // Reserve before asynchronous evidence collection: all tabs share one in-flight batch.
      const job = this.generate(admittedAt).catch(() => { this.error = 'Worker summaries are unavailable; live status still updates.'; });
      this.job = job;
      void job.finally(() => { if (this.job === job) this.job = undefined; });
    }
    return this.snapshot();
  }

  private async generate(admittedAt: number): Promise<void> {
    const roster = (await this.source.roster()).filter((w) => w.working).sort((a, b) =>
      (Date.parse(this.summaries.get(a.id)?.updatedAt ?? '') || 0) - (Date.parse(this.summaries.get(b.id)?.updatedAt ?? '') || 0));
    const evidence: WorkerEvidence[] = [];
    for (const worker of roster) {
      if (this.stopped) return;
      const detail = await this.source.collect(worker);
      const cached = this.summaries.get(worker.id);
      if (cached?.fingerprint === fingerprint(detail)) continue;
      if (cached) cached.stale = true;
      evidence.push(detail);
      if (evidence.length === 16) break;
    }
    if (!evidence.length || this.stopped) return;
    // A worker can finish during collection; suppress summaries if nobody is still working.
    const workingIds = new Set((await this.source.roster()).filter((w) => w.working).map((w) => w.id));
    const batch = evidence.filter((w) => workingIds.has(w.id));
    if (!batch.length || this.stopped) return;
    const started = admittedAt; // Cadence starts at request admission, before asynchronous evidence collection.
    const record: SummaryAuditRecord = { id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: null,
      status: 'started', model: 'gpt-6-luna', effort: 'low', workerIds: batch.map((w) => w.id), durationMs: null, usage: null };
    // No paid call may start without a durable audit entry.
    try { await this.audit.record(record); }
    catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; return; }
    try {
      const result = await this.runner.run(batch, record.id);
      record.usage = result.usage;
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
    } catch {
      record.status = 'failed'; this.error = 'Worker summaries are unavailable; live status still updates.';
    } finally {
      record.finishedAt = new Date(this.clock()).toISOString(); record.durationMs = Math.max(0, this.clock() - started);
      try { await this.audit.record(record); }
      catch { this.auditFailed = true; this.error = 'Summary usage audit is unavailable; new summaries are paused.'; }
    }
  }

  async stop(): Promise<void> { this.stopped = true; this.runner.stop(); await this.job; }
  async settled(): Promise<void> { await this.job; }
}
