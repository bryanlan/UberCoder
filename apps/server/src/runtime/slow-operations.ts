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

const STATEMENT_CACHE_LIMIT = 1000;

/**
 * Reuse compiled statements by SQL text. Repositories call `prepare` inside hot loops; compiling the
 * same SQL again was 17% of the backend's event loop on 2026-11-21. Statements are only ever used
 * synchronously with `get`, `all` and `run` (no `iterate`, `pluck`, `raw` or `expand`), so sharing one
 * per SQL text is safe. The bound covers SQL built with a variable number of placeholders.
 */
export function cacheStatements(db: Database.Database): void {
  const prepare = db.prepare.bind(db);
  const statements = new Map<string, Database.Statement>();
  db.prepare = ((sql: string) => {
    const cached = statements.get(sql);
    if (cached) { statements.delete(sql); statements.set(sql, cached); return cached; }
    const statement = prepare(sql);
    statements.set(sql, statement);
    if (statements.size > STATEMENT_CACHE_LIMIT) statements.delete(statements.keys().next().value!);
    return statement;
  }) as typeof db.prepare;
}

const observedStatements = new WeakSet<object>();

/** Preserve native statement identity, bindings and fluent options. Never record SQL or parameters. */
export function observeSqlite(db: Database.Database, scope: 'main' | 'wiki', observe: OperationObserver): void {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = observeSync(`${scope}.sqlite.prepare`, () => prepare(sql), observe, sql);
    // A cached statement is already wrapped; wrapping it again would nest the timers on every call.
    if (observedStatements.has(statement)) return statement;
    observedStatements.add(statement);
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
