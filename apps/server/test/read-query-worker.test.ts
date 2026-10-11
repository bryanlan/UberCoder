import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { ReadQueryWorker } from '../src/db/read-query-worker.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-read-worker-'));
  const file = path.join(root, 'test.sqlite');
  const db = new AppDatabase(file);
  const reader = new ReadQueryWorker(file);
  cleanups.push(async () => { await reader.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { db, reader };
}

it('reads committed changes and refuses writes without altering the owning database', async () => {
  const { db, reader } = await fixture();
  db.meta.set('evidence', 'before');
  expect(await reader.query('select value from meta where key=?', ['evidence'])).toEqual([{ value: 'before' }]);
  db.meta.set('evidence', 'after');
  expect(await reader.query('select value from meta where key=?', ['evidence'])).toEqual([{ value: 'after' }]);
  await expect(reader.query('delete from meta returning key', [])).rejects.toThrow(/readonly/i);
  expect(db.meta.get('evidence')).toBe('after');
  expect(db.sqlite.pragma('cache_size', { simple: true })).toBe(-65536);
});

it('keeps the owning event loop responsive while SQLite runs an expensive read', async () => {
  const { reader } = await fixture();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const rows = await reader.query(`with recursive counter(n) as
      (values(0) union all select n+1 from counter where n<1000000) select sum(n) total from counter`, []);
    expect(rows).toEqual([{ total: 500000500000 }]);
    expect(ticks).toBeGreaterThan(2);
  } finally { clearInterval(timer); }
});

it('bounds its queue and releases it after a serialization failure', async () => {
  const { reader } = await fixture();
  await expect(reader.query('select ?', [() => undefined])).rejects.toThrow();
  const reads = Array.from({ length: 16 }, () => reader.query('select 1 as evidence', []));
  await expect(reader.query('select 2', [])).rejects.toThrow('busy');
  expect(await Promise.all(reads)).toHaveLength(16);
  expect(await reader.query('select 3 as evidence', [])).toEqual([{ evidence: 3 }]);
});

it('rejects outstanding work and cannot reopen after close', async () => {
  const { reader } = await fixture();
  const pending = expect(reader.query('select 1', [])).rejects.toThrow('closed');
  await reader.close();
  await pending;
  await expect(reader.query('select 1', [])).rejects.toThrow('closed');
});
