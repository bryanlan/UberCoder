import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEvidence } from '../src/workers/evidence.js';
import { WorkerSummaryAudit } from '../src/workers/audit.js';
import { WorkerPanelService } from '../src/workers/service.js';
import { SharedSummaryRuntime, parseRuntimeResult, type SummaryResult, type SummaryRunner } from '../src/workers/runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const worker = (id: string, working = true): WorkerEvidence => ({ id, working, projectSlug: 'demo', projectName: 'Demo',
  provider: 'codex', conversationRef: id, title: 'Current assignment', task: 'Verify deployment',
  actions: [{ text: 'Checking runtime revision', timestamp: '2026-10-12T12:00:00Z' }], peers: [] });
const usage = { inputTokens: 20, cachedInputTokens: 5, cacheWriteTokens: 2, outputTokens: 3, totalTokens: 30 };
const result = (workers: WorkerEvidence[]): SummaryResult => ({ usage,
  summaries: workers.map((w) => ({ id: w.id, task: 'Verify deployment', latest: 'Checking runtime revision', coordination: 'No recent coordination observed.' })) });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-panel-test-'));
  let now = Date.parse('2026-10-12T12:00:00Z');
  const workers = [worker('one')];
  const source = { roster: vi.fn(async () => workers), collect: vi.fn(async (w: WorkerEvidence) => w) };
  const runner: SummaryRunner = { run: vi.fn(async (ws) => result(ws)), stop: vi.fn(), cancel: vi.fn() };
  const audit = new WorkerSummaryAudit(directory);
  const service = new WorkerPanelService(source, runner, audit, true, () => now);
  cleanups.push(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, source, workers, runner, audit, directory, advance: (ms = 120_000) => { now += ms; } };
}

describe('worker summary controller', () => {
  it('records known zero usage when Off arrives during the start-audit write', async () => {
    const f = await fixture(); let release!: () => void;
    const record = f.audit.record.bind(f.audit);
    vi.spyOn(f.audit, 'record').mockImplementationOnce(async (row) => {
      await record(row); await new Promise<void>((resolve) => { release = resolve; });
    });
    await f.service.refresh(1); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.service.setTracking(false); release(); await f.service.settled();
    expect(f.runner.run).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).usage).toMatchObject({ calls: 1, totalTokens: 0, unknownUsageCalls: 0, runningCalls: 0 });
  });

  it('records known zero usage and never spawns when cancelled during runner setup', async () => {
    const f = await fixture(); const runs = path.join(f.directory, 'runs');
    const runtime = new SharedSummaryRuntime(['this-command-must-never-spawn'], runs);
    const prepare = vi.spyOn(runtime as unknown as { prepare(): Promise<void> }, 'prepare').mockImplementation(async () => {
      await fs.mkdir(runs); runtime.cancel();
    });
    try {
      const response = await runtime.run([worker('one')], '00000000-0000-0000-0000-000000000020');
      expect(response).toMatchObject({ summaries: null, usage: { totalTokens: 0, inputTokens: 0 } });
      expect(await fs.readdir(runs)).toEqual([]);
    } finally { prepare.mockRestore(); }
  });
  it('blocks every tab and evidence collection while off, then resumes on demand', async () => {
    const f = await fixture(); await f.service.setTracking(false);
    f.source.roster.mockClear();
    const view = await f.service.refresh(1); await f.service.settled();
    expect(view).toMatchObject({ trackingEnabled: false, enabled: false, workers: [], workingCount: 0 });
    expect(f.source.roster).not.toHaveBeenCalled(); expect(f.source.collect).not.toHaveBeenCalled();
    expect(f.runner.run).not.toHaveBeenCalled(); expect(f.runner.cancel).toHaveBeenCalledTimes(1);
    await f.service.setTracking(true); await f.service.refresh(1); await f.service.settled();
    expect(f.runner.run).toHaveBeenCalledTimes(1);
  });

  it('does not revive a collecting batch after a quick Off/On transition', async () => {
    const f = await fixture(); let finish!: (w: WorkerEvidence) => void;
    f.source.collect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await f.service.refresh(1); await vi.waitFor(() => expect(f.source.collect).toHaveBeenCalledTimes(1));
    await f.service.setTracking(false); await f.service.setTracking(true);
    finish(f.workers[0]!); await f.service.settled(); expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('cancels a running summary, retains consumed usage, and discards its stale result', async () => {
    const f = await fixture(); let finish!: (r: SummaryResult) => void;
    vi.mocked(f.runner.run).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await f.service.refresh(1); await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalledTimes(1));
    await f.service.setTracking(false); await f.service.setTracking(true);
    finish(result(f.workers)); await f.service.settled();
    const view = await f.service.snapshot();
    expect(view.workers[0]!.summary).toBeNull(); expect(view.error).toBeNull();
    expect(view.usage).toMatchObject({ calls: 1, totalTokens: 30, unknownUsageCalls: 0, runningCalls: 0 });
    const text = await fs.readFile(path.join(f.directory, 'usage-2026-10-12.jsonl'), 'utf8');
    expect(text).toContain('"status":"cancelled"');
    f.advance(); vi.mocked(f.runner.run).mockImplementation(async (ws) => result(ws));
    await f.service.refresh(1); await f.service.settled(); expect(f.runner.run).toHaveBeenCalledTimes(2);
  });

  it('leaves tracking unchanged when persistence fails', async () => {
    const f = await fixture();
    const service = new WorkerPanelService(f.source, f.runner, new WorkerSummaryAudit(f.directory), true, Date.now,
      () => { throw new Error('Read-only config'); });
    await expect(service.setTracking(false)).rejects.toThrow('Read-only config');
    expect((await service.snapshot()).trackingEnabled).toBe(true); expect(f.runner.cancel).not.toHaveBeenCalled();
  });
  it('does not run summaries for idle workers, even when their task is described as active', async () => {
    const f = await fixture(); f.workers[0]!.working = false;
    expect((await f.service.refresh(1)).workingCount).toBe(0);
    await f.service.settled(); expect(f.runner.run).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).usage.calls).toBe(0);
  });

  it('shares one batch across concurrent tabs and enforces the global cadence', async () => {
    const f = await fixture(); let finish!: (r: SummaryResult) => void;
    vi.mocked(f.runner.run).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await Promise.all([f.service.refresh(2), f.service.refresh(1), f.service.refresh(5)]);
    await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalledTimes(1));
    expect((await f.service.snapshot()).generating).toBe(true);
    finish(result(f.workers)); await f.service.settled();
    f.workers[0]!.actions[0]!.text = 'New action';
    await f.service.refresh(1); await f.service.settled(); expect(f.runner.run).toHaveBeenCalledTimes(1);
  });

  it('skips unchanged evidence and heartbeats and summarizes only changed working agents', async () => {
    const f = await fixture(); f.workers.push(worker('two'), worker('idle', false));
    await f.service.refresh(2); await f.service.settled();
    expect(vi.mocked(f.runner.run).mock.calls[0]![0].map((w) => w.id)).toEqual(['one', 'two']);
    f.advance(); f.workers[0]!.actions[0]!.timestamp = '2026-10-12T12:02:00Z';
    await f.service.refresh(2); await f.service.settled(); expect(f.runner.run).toHaveBeenCalledTimes(1);
    f.workers[0]!.actions[0]!.text = 'Verifying the final build';
    await f.service.refresh(2); await f.service.settled();
    expect(vi.mocked(f.runner.run).mock.calls[1]![0].map((w) => w.id)).toEqual(['one']);
  });

  it('rechecks working state after collecting evidence', async () => {
    const f = await fixture(); f.source.collect.mockImplementation(async (w) => { w.working = false; return w; });
    await f.service.refresh(2); await f.service.settled(); expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('retains a clearly stale summary after failure and accounts for its consumed tokens', async () => {
    const f = await fixture(); await f.service.refresh(2); await f.service.settled(); f.advance();
    f.workers[0]!.actions[0]!.text = 'A later action';
    vi.mocked(f.runner.run).mockResolvedValue({ summaries: null, usage });
    await f.service.refresh(2); await f.service.settled();
    const view = await f.service.snapshot();
    expect(view.workers[0]).toMatchObject({ stale: true, summary: { latest: 'Checking runtime revision' } });
    expect(view.error).toBeTruthy(); expect(view.usage).toMatchObject({ calls: 2, failedCalls: 1, totalTokens: 60, unknownUsageCalls: 0 });
  });

  it('persists usage without counting streaming records twice or logging evidence text', async () => {
    const f = await fixture(); await f.service.refresh(2); await f.service.settled();
    const audit = new WorkerSummaryAudit(f.directory); await audit.load('2026-10-12');
    expect(audit.snapshot('2026-10-12')).toMatchObject({ calls: 1, totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, cacheWriteTokens: 2 });
    const file = path.join(f.directory, 'usage-2026-10-12.jsonl');
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('Checking runtime revision'); expect(text).not.toContain('Verify deployment');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
  });

  it('records missing native usage as unknown and pauses if the audit cannot be trusted', async () => {
    const f = await fixture(); vi.mocked(f.runner.run).mockResolvedValue({ summaries: null, usage: null });
    await f.service.refresh(2); await f.service.settled();
    expect((await f.service.snapshot()).usage).toMatchObject({ calls: 1, failedCalls: 1, unknownUsageCalls: 1 });
    const other = new WorkerPanelService(f.source, f.runner, new WorkerSummaryAudit(f.directory), true, () => Date.parse('2026-10-13T12:00:00Z'));
    await fs.writeFile(path.join(f.directory, 'usage-2026-10-13.jsonl'), 'malformed audit\n');
    expect((await other.refresh(2)).enabled).toBe(false); await other.settled(); expect(f.runner.run).toHaveBeenCalledTimes(1);
  });

  it('bounds batches and fairly reaches unchanged workers after the first batch is cached', async () => {
    const f = await fixture(); f.workers.splice(0, 1, ...Array.from({ length: 20 }, (_, i) => worker(String(i))));
    await f.service.refresh(1); await f.service.settled(); f.advance(60_000);
    await f.service.refresh(1); await f.service.settled();
    expect(vi.mocked(f.runner.run).mock.calls.map(([ws]) => ws.length)).toEqual([16, 4]);
  });

  it('prevents new calls after shutdown', async () => {
    const f = await fixture(); await f.service.stop(); await f.service.refresh(1);
    expect(f.runner.run).not.toHaveBeenCalled(); expect(f.runner.stop).toHaveBeenCalled();
  });

  it('cancels the native runner without permanently disabling subsequent runs', async () => {
    const f = await fixture();
    const runtime = new SharedSummaryRuntime([process.execPath, '-e',
      'process.on("SIGTERM",()=>{process.stdout.write(JSON.stringify({ok:false}));process.exit(0)});setTimeout(()=>process.stdout.write(JSON.stringify({ok:false})),250)', '--'], path.join(f.directory, 'runs'));
    const pending = runtime.run([worker('one')], '00000000-0000-0000-0000-000000000010');
    // Wait for the signal handler to be installed, rather than racing native startup.
    await vi.waitFor(() => expect((runtime as unknown as { child?: { pid?: number } }).child?.pid).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.cancel(); await expect(pending).resolves.toEqual({ summaries: null, usage: null });
    await expect(runtime.run([worker('one')], '00000000-0000-0000-0000-000000000011')).resolves.toEqual({ summaries: null, usage: null });
    expect(await fs.readdir(path.join(f.directory, 'runs'))).toEqual([]);
  });

  it('keeps the selected cadence with collection delay and small timer jitter', async () => {
    const f = await fixture();
    f.source.collect.mockImplementation(async (w) => { f.advance(25); return w; });
    await f.service.refresh(2); await f.service.settled();
    f.workers[0]!.actions[0]!.text = 'Changed work'; f.advance(119_475);
    await f.service.refresh(2); await f.service.settled();
    expect(f.runner.run).toHaveBeenCalledTimes(2);
  });

  it('gives never-summarized workers priority even when the first16 continually change', async () => {
    const f = await fixture(); f.workers.splice(0, 1, ...Array.from({ length: 20 }, (_, i) => worker(String(i))));
    await f.service.refresh(1); await f.service.settled(); f.advance(60_000);
    for (const w of f.workers) w.actions[0]!.text += ' — next step';
    await f.service.refresh(1); await f.service.settled();
    const second = vi.mocked(f.runner.run).mock.calls[1]![0].map((w) => w.id);
    expect(second).toEqual(expect.arrayContaining(['16', '17', '18', '19']));
  });

  it('attributes a call crossing midnight to its UTC admission day', async () => {
    const f = await fixture(); f.advance(12 * 60 * 60_000 - 15_000);
    let finish!: (r: SummaryResult) => void;
    vi.mocked(f.runner.run).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await f.service.refresh(1); await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalledTimes(1));
    f.advance(30_000);
    expect((await f.service.snapshot()).usage).toMatchObject({ date: '2026-10-13', calls: 0 });
    finish(result(f.workers)); await f.service.settled();
    const oldDay = new WorkerSummaryAudit(f.directory); await oldDay.load('2026-10-12');
    expect(oldDay.snapshot('2026-10-12')).toMatchObject({ calls: 1, totalTokens: 30 });
    expect((await f.service.snapshot()).usage.calls).toBe(0);
  });

  it('cleans old owned model directories without removing recent or unrelated directories', async () => {
    const f = await fixture(); const root = path.join(f.directory, 'runs'); await fs.mkdir(root);
    const old = path.join(root, '00000000-0000-0000-0000-000000000001');
    const recent = path.join(root, '00000000-0000-0000-0000-000000000002');
    const unrelated = path.join(root, 'notes');
    for (const directory of [old, recent, unrelated]) await fs.mkdir(directory);
    await fs.writeFile(path.join(old, 'request.json'), 'private fixture prompt');
    await fs.writeFile(path.join(old, '.owner'), 'worker-panel-summary');
    await fs.utimes(old, new Date(0), new Date(0));
    const runtime = new SharedSummaryRuntime([process.execPath, '-e', 'process.stdout.write(JSON.stringify({ok:false}))', '--'], root);
    await runtime.run([worker('one')], '00000000-0000-0000-0000-000000000003');
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(recent)).isDirectory()).toBe(true); expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
    // A restart's first call may see a recent orphan; later calls must sweep it once it ages.
    await fs.mkdir(old); await fs.writeFile(path.join(old, '.owner'), 'worker-panel-summary');
    await fs.utimes(old, new Date(0), new Date(0));
    await runtime.run([worker('one')], '00000000-0000-0000-0000-000000000004');
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('shared-runtime result boundary', () => {
  const nativeUsage = { available: true, input_tokens: 20, cache_read_tokens: 5, cache_creation_tokens: 2, output_tokens: 3, total_tokens: 30 };
  const envelope = (rows: unknown) => ({ ok: true, response_text: JSON.stringify({ workers: rows }), llm_usage: nativeUsage });
  const row = { id: 'one', task: 'Task', latest: 'Latest', coordination: 'Invented peer collaboration' };
  it('uses native accounting and prevents invented coordination when there are no peer records', () => {
    expect(parseRuntimeResult(envelope([row]), [worker('one')])).toMatchObject({ usage,
      summaries: [{ coordination: 'No recent coordination observed.' }] });
  });
  it.each([[{ ...row, id: 'unknown' }], [row, row], [{ ...row, latest: 'x'.repeat(181) }], [{ ...row, latest: 'two\nlines' }]].map((rows) => [rows]))(
    'rejects unknown/duplicate workers or unbounded text while retaining known usage', (bad) => {
      expect(parseRuntimeResult(envelope(bad), [worker('one')])).toEqual({ summaries: null, usage });
    });
  it('counts failed native runs and never substitutes zero for unavailable usage', () => {
    expect(parseRuntimeResult({ ok: false, llm_usage: nativeUsage }, [worker('one')])).toEqual({ summaries: null, usage });
    expect(parseRuntimeResult({ ok: false, llm_usage: { available: false } }, [worker('one')])).toEqual({ summaries: null, usage: null });
  });
});
