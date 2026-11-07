import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { CoordinationTelemetryRecord } from '../../../../scripts/coordination-telemetry.mjs';

export type OperationObserver = (record: CoordinationTelemetryRecord) => void;
export const SLOW_OPERATION_MS = 100;
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
let nextSpan = 0;

function report(observe: OperationObserver, record: CoordinationTelemetryRecord) {
  try { observe(record); } catch { /* Diagnostics must preserve the operation's result. */ }
}

function sourceLocation(): string | undefined {
  for (const line of new Error().stack?.split('\n') ?? []) {
    const at = line.indexOf(sourceRoot);
    if (at < 0) continue;
    const relative = line.slice(at + sourceRoot.length).match(/^([\w./-]+:\d+:\d+)/)?.[1];
    if (relative && !relative.startsWith('runtime/slow-operations.')) return relative;
  }
}

/** Only slow synchronous calls and SQLite lock errors produce records. */
export function observeSync<T>(operation: string, run: () => T, observe?: OperationObserver, sql?: string): T {
  if (!observe) return run();
  const started = performance.now(), startedAt = Date.now();
  let outcome = 'ok', error: string | undefined;
  try { return run(); }
  catch (failure) {
    outcome = 'error';
    const code = (failure as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^SQLITE_[A-Z_]+$/.test(code)) error = code;
    throw failure;
  } finally {
    const durationMs = performance.now() - started;
    if (durationMs >= SLOW_OPERATION_MS || error?.startsWith('SQLITE_BUSY') || error?.startsWith('SQLITE_LOCKED')) {
      report(observe, { kind: 'operation', operation, phase: 'sync', startedAt, durationMs, outcome, error,
        source: sourceLocation(), fingerprint: sql === undefined ? undefined : createHash('sha256').update(sql).digest('hex') });
    }
  }
}

/** A single pending record identifies a wait even if its promise never settles. */
export async function observeAsync<T>(operation: string, run: () => Promise<T>, observe?: OperationObserver): Promise<T> {
  if (!observe) return run();
  const started = performance.now(), startedAt = Date.now(), spanId = ++nextSpan;
  const timer = setTimeout(() => report(observe, { kind: 'operation', operation, phase: 'async',
    startedAt, spanId, durationMs: performance.now() - started, outcome: 'pending' }), 1000);
  timer.unref();
  let outcome = 'ok';
  try { return await run(); }
  catch (failure) { outcome = 'error'; throw failure; }
  finally {
    clearTimeout(timer);
    const durationMs = performance.now() - started;
    if (durationMs >= SLOW_OPERATION_MS) report(observe, { kind: 'operation', operation, phase: 'async',
      startedAt, spanId, durationMs, outcome });
  }
}

/** Preserve native statement identity, bindings and fluent options. Never record SQL or parameters. */
export function observeSqlite(db: Database.Database, scope: 'main' | 'wiki', observe: OperationObserver): void {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = observeSync(`${scope}.sqlite.prepare`, () => prepare(sql), observe, sql);
    for (const method of ['get', 'all', 'run'] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { configurable: true, writable: true,
        value: (...args: unknown[]) => observeSync(`${scope}.sqlite.${method}`, () => original(...args), observe, sql) });
    }
    return statement;
  }) as typeof db.prepare;
  for (const method of ['exec', 'pragma'] as const) {
    const original = db[method].bind(db) as (...args: unknown[]) => unknown;
    Object.defineProperty(db, method, { configurable: true, writable: true,
      value: (...args: unknown[]) => observeSync(`${scope}.sqlite.${method}`,
        () => original(...args), observe, typeof args[0] === 'string' ? args[0] : undefined) });
  }
}
