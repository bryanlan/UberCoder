import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { observeAsync, observeSqlite, type OperationObserver } from '../src/runtime/slow-operations.js';
import { readCoordinationTelemetry, recordCoordinationTelemetry, startCoordinationTelemetry } from '../src/coordination/telemetry.js';
import type { CoordinationTelemetryRecord } from '../../../scripts/coordination-telemetry.mjs';
import { AppDatabase } from '../src/db/database.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-observer-'));
  fs.mkdirSync(path.join(dir, 'coordination'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function database(file = ':memory:') {
  const db = new Database(file, { timeout: 10 }); cleanups.push(() => db.close()); return db;
}
function records(dir: string) {
  return fs.readdirSync(path.join(dir, 'coordination/telemetry')).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(dir, 'coordination/telemetry', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
}

it('attributes a real synchronous SQL stall without exporting SQL or bindings or changing its result', () => {
  const db = database(), rows: CoordinationTelemetryRecord[] = [];
  db.function('slow', (_value: unknown) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 130); return 17; });
  observeSqlite(db, 'main', record => { rows.push(record); throw new Error('Diagnostics unavailable'); });
  const sql = 'select slow(?)';
  expect(db.prepare(sql).pluck().get('PRIVATE_BOUND_VALUE')).toBe(17);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ operation: 'main.sqlite.get', phase: 'sync', outcome: 'ok',
    fingerprint: createHash('sha256').update(sql).digest('hex') });
  expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(100);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|select slow/);
  expect(db.prepare('select ?').bind('retained').pluck().get()).toBe('retained');
});

it('records native SQLite lock refusal below the slow threshold and preserves the native error', () => {
  const file = path.join(root(), 'state.sqlite'), owner = database(file), blocked = database(file);
  owner.exec('create table records(value text)');
  const rows: CoordinationTelemetryRecord[] = [];
  observeSqlite(blocked, 'wiki', row => rows.push(row));
  const insert = blocked.prepare('insert into records(value) values(?)');
  owner.exec('begin immediate');
  try {
    expect(() => insert.run('PRIVATE_VALUE')).toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY' }));
  } finally { owner.exec('rollback'); }
  expect(rows).toMatchObject([{ operation: 'wiki.sqlite.run', outcome: 'error', error: 'SQLITE_BUSY' }]);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  expect(insert.run('after lock').changes).toBe(1);
});

it('connects the application database observer to a relative repository call site', () => {
  const rows: CoordinationTelemetryRecord[] = [];
  const db = new AppDatabase(path.join(root(), 'app.sqlite'), record => rows.push(record));
  cleanups.push(() => db.close());
  db.sqlite.function('pause_write', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 130); return 0; });
  db.sqlite.exec('create temp trigger slow_meta after insert on meta begin select pause_write(); end');
  rows.length = 0;
  db.meta.set('PRIVATE_KEY', 'PRIVATE_VALUE');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ operation: 'main.sqlite.run', phase: 'sync' });
  expect(rows[0]!.source).toMatch(/^db\/repos\/meta\.[tj]s:\d+:\d+$/);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');
});

it('records a pending async wait once and correlates its completion without changing rejection', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const rows: CoordinationTelemetryRecord[] = [];
  let reject!: (error: Error) => void;
  const failure = new Error('PRIVATE_PROVIDER_FAILURE');
  const result = observeAsync('coordination.wake', () => new Promise<never>((_, fail) => { reject = fail; }), row => rows.push(row));
  const rejected = expect(result).rejects.toBe(failure);
  clock.mockReturnValue(4000); await vi.advanceTimersByTimeAsync(4000);
  expect(rows).toMatchObject([{ operation: 'coordination.wake', phase: 'async', outcome: 'pending' }]);
  reject(failure); await rejected;
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ spanId: rows[0]!.spanId, outcome: 'error', phase: 'async' });
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  await vi.advanceTimersByTimeAsync(10_000); expect(rows).toHaveLength(2);
});

it('emits CPU, loop utilization, memory and actual window duration and stops its timer cleanly', async () => {
  const dir = root();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const stop = startCoordinationTelemetry(dir); cleanups.push(stop);
  clock.mockReturnValue(10_000); await vi.advanceTimersByTimeAsync(10_000);
  const row = records(dir)[0];
  expect(row).toMatchObject({ kind: 'event_loop', pid: process.pid, windowMs: 10_000 });
  for (const key of ['cpuUserMs','cpuSystemMs','utilization','rssBytes']) expect(Number.isFinite(row[key])).toBe(true);
  expect(row.rssBytes).toBeGreaterThan(0);
  stop(); await vi.advanceTimersByTimeAsync(20_000); expect(records(dir)).toHaveLength(1);
});

it('keeps only the longest 20 operation observations and 10 lag windows in a streamed audit', async () => {
  const dir = root();
  const observe: OperationObserver = row => { recordCoordinationTelemetry(dir, row); };
  for (let i = 0; i < 30; i++) observe({ kind: 'operation', operation: 'main.sqlite.run', durationMs: 1000 + i, phase: 'sync', outcome: 'ok' });
  observe({ kind: 'operation', operation: 'coordination.wake', spanId: 1, durationMs: 1000, phase: 'async', outcome: 'pending' });
  for (let i = 0; i < 15; i++) observe({ kind: 'event_loop', maxMs: 1000 + i, utilization: 0.9, cpuUserMs: 900 });
  const result = await readCoordinationTelemetry(dir, Date.now() - 10_000, Date.now() + 10_000);
  expect(result.issues).toEqual([]);
  expect(result.summary.operations).toMatchObject({ completed: { count: 30 }, pendingObservations: 1 });
  expect(result.summary.operations.slowest).toHaveLength(20);
  expect(result.summary.operations.slowest[0]!.durationMs).toBe(1029);
  expect(result.summary.eventLoop.slowestWindows).toHaveLength(10);
});
