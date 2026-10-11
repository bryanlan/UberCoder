import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordCoordinationTelemetry, readCoordinationTelemetry, TELEMETRY_MAX_OFFERS } from '../src/coordination/telemetry.js';
import { TELEMETRY_MAX_BYTES } from '../../../scripts/coordination-telemetry.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-telemetry-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'coordination'), { mode: 0o700 });
  return root;
}
it('records failures independently and excludes payloads and credentials', async () => {
  const root = fixture();
  expect(recordCoordinationTelemetry(root, { kind: 'rpc_client', action: 'poll', outcome: 'error', error: 'timeout', durationMs: 2300,
    text: 'PRIVATE_TEXT', token: 'PRIVATE_TOKEN' } as never)).toBe(true);
  const dir = path.join(root, 'coordination/telemetry');
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  const file = path.join(dir, fs.readdirSync(dir)[0]!);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('PRIVATE');
  const result = await readCoordinationTelemetry(root, Date.now() - 10_000, Date.now() + 10_000);
  expect(result.available).toBe(true);
  expect(result.summary).toMatchObject({ clientTimeouts: 1, clientRequests: { count: 1, maxMs: 2300 } });
});
it('marks capacity limits and malformed logs as incomplete without breaking delivery', async () => {
  const root = fixture();
  recordCoordinationTelemetry(root, { kind: 'hook', outcome: 'ok' });
  const dir = path.join(root, 'coordination/telemetry');
  const file = path.join(dir, fs.readdirSync(dir)[0]!);
  fs.appendFileSync(file, '{invalid\n');
  expect((await readCoordinationTelemetry(root, 0, Date.now() + 1000)).issues).toHaveLength(1);
  fs.truncateSync(file, TELEMETRY_MAX_BYTES);
  expect(recordCoordinationTelemetry(root, { kind: 'hook', outcome: 'ok' })).toBe(false);
  // Unrelated web errors cannot consume reserved delivery-failure storage.
  for (let i = 0; i < 20; i++) expect(recordCoordinationTelemetry(root, { kind: 'http', outcome: 'error', durationMs: 5 })).toBe(false);
  expect(fs.readdirSync(dir).some((name) => name.includes('.failures.'))).toBe(false);
  // Restore a short file; the cap marker remains evidence of incomplete counts.
  fs.writeFileSync(file, '');
  // Routine capacity does not consume the reserved delivery-failure budget.
  expect(recordCoordinationTelemetry(root, { kind: 'rpc_client', outcome: 'error', error: 'timeout', durationMs: 2300 })).toBe(true);
  const result = await readCoordinationTelemetry(root, 0, Date.now() + 1000);
  expect(result.issues).toContainEqual(expect.stringContaining('counts are incomplete'));
  expect(result.summary.clientTimeouts).toBe(1);
  expect(fs.readdirSync(dir)).toContain(new Date().toISOString().slice(0, 10) + '.failures.jsonl');
  expect(result.issues.join(' ')).toContain('Routine telemetry capacity');
});
it('streams routine traffic without hiding a later timeout', async () => {
  const root = fixture(); recordCoordinationTelemetry(root, { kind: 'hook', outcome: 'ok' });
  const dir = path.join(root, 'coordination/telemetry'), file = path.join(dir, fs.readdirSync(dir)[0]!);
  const at = Date.now();
  const line = JSON.stringify({ kind: 'rpc_client', timestamp: at - 3600_000, outcome: 'ok', durationMs: 4 }) + '\n';
  fs.writeFileSync(file, line.repeat(150_000) + JSON.stringify({ kind: 'rpc_client', timestamp: at, outcome: 'error', error: 'timeout', durationMs: 2300 }) + '\n');
  const result = await readCoordinationTelemetry(root, at - 7200_000, at + 1000);
  expect(result.summary).toMatchObject({ clientTimeouts: 1, clientRequests: { count: 150_001, maxMs: 2300 } });
  expect(result.recentSummary).toMatchObject({ clientTimeouts: 1, clientRequests: { count: 1 } });
  expect(result.offers).toEqual([]);
  expect(result.issues).toEqual([]);
});
it('bounds retained offer history while still counting every later failure', async () => {
  const root = fixture(); recordCoordinationTelemetry(root, { kind: 'hook', outcome: 'ok' });
  const dir = path.join(root, 'coordination/telemetry'), file = path.join(dir, fs.readdirSync(dir)[0]!);
  const line = JSON.stringify({ kind: 'offer', timestamp: Date.now(), outcome: 'finished' }) + '\n';
  fs.writeFileSync(file, line.repeat(TELEMETRY_MAX_OFFERS + 1) + JSON.stringify({ kind: 'hook', timestamp: Date.now(), outcome: 'error' }) + '\n');
  const result = await readCoordinationTelemetry(root, 0, Date.now() + 1000);
  expect(result.offers).toHaveLength(TELEMETRY_MAX_OFFERS);
  expect(result.summary).toMatchObject({ hookFailures: 1, offerResponsesFinished: TELEMETRY_MAX_OFFERS + 1 });
  expect(result.issues).toContainEqual(expect.stringContaining('Offer-history limit reached'));
});
