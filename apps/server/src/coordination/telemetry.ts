import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { recordCoordinationTelemetry, TELEMETRY_MAX_BYTES, TELEMETRY_FAILURE_MAX_BYTES, type CoordinationTelemetryRecord } from '../../../../scripts/coordination-telemetry.mjs';

export { recordCoordinationTelemetry };
export type { CoordinationTelemetryRecord };

/** Route templates identify slow handlers without recording actual URLs or IDs. */
export function recordHttpTelemetry(runtimeDir: string,
  request: { method: string; routeOptions: { url?: string } },
  reply: { elapsedTime: number; statusCode: number }) {
  if (request.routeOptions.url === '/api/events') return; // Stream lifetime is not latency.
  return recordCoordinationTelemetry(runtimeDir, { kind: 'http', durationMs: reply.elapsedTime,
    action: `${request.method} ${request.routeOptions.url ?? '(unmatched)'}`,
    outcome: reply.statusCode >= 400 ? 'error' : 'ok' });
}

export function startCoordinationTelemetry(runtimeDir: string) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let windowStart = performance.now(), previousCpu = process.cpuUsage(), previousLoop = performance.eventLoopUtilization();
  delay.enable();
  const timer = setInterval(() => {
    const now = performance.now(), cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
    recordCoordinationTelemetry(runtimeDir, { kind: 'event_loop', maxMs: delay.max / 1e6,
      p99Ms: delay.percentile(99) / 1e6, samples: delay.count, windowMs: now - windowStart,
      cpuUserMs: (cpu.user - previousCpu.user) / 1000, cpuSystemMs: (cpu.system - previousCpu.system) / 1000,
      utilization: performance.eventLoopUtilization(loop, previousLoop).utilization, rssBytes: process.memoryUsage.rss() });
    windowStart = now; previousCpu = cpu; previousLoop = loop;
    delay.reset();
  }, 10_000);
  timer.unref();
  return () => { clearInterval(timer); delay.disable(); };
}

export interface Measurement extends CoordinationTelemetryRecord { timestamp: number; pid?: number; }
export const TELEMETRY_MAX_OFFERS = 100_000;
export const TELEMETRY_MAX_LATENCY_SAMPLES = 1_000_000;

class Latencies {
  count = 0;
  maxMs: number | null = null;
  values: number[] = [];
  add(value: number) {
    this.count++;
    this.maxMs = Math.max(this.maxMs ?? value, value);
    if (this.values.length < TELEMETRY_MAX_LATENCY_SAMPLES) this.values.push(value);
  }
  summary() {
    this.values.sort((a, b) => a - b);
    return { count: this.count, p95Ms: this.values[Math.ceil(this.values.length * .95) - 1] ?? null,
      p99Ms: this.values[Math.ceil(this.values.length * .99) - 1] ?? null, maxMs: this.maxMs };
  }
}
/** Keep numeric latency samples, never all routine request objects. Counters
 * continue through sampling/offer limits so late failures cannot disappear. */
class Measurements {
  client = new Latencies(); server = new Latencies(); http = new Latencies(); index = new Latencies(); loop = new Latencies();
  clientTimeouts = 0; clientFailures = 0; hookFailures = 0; abandonedRequests = 0;
  loopSamples = 0; finishedOffers = 0; abandonedOffers = 0;
  completedOperations = new Latencies(); pendingOperations = 0;
  slowOperations: Measurement[] = []; slowWindows: Measurement[] = [];
  add(r: Measurement) {
    const duration = r.durationMs ?? 0;
    switch (r.kind) {
      case 'rpc_client': this.client.add(duration); this.clientTimeouts += Number(r.error === 'timeout'); this.clientFailures += Number(r.outcome === 'error'); break;
      case 'rpc_server': this.server.add(duration); this.abandonedRequests += Number(r.outcome === 'abandoned'); break;
      case 'http': this.http.add(duration); break;
      case 'index': this.index.add(duration); break;
      case 'hook': this.hookFailures += Number(r.outcome === 'error'); break;
      case 'event_loop':
        this.loop.add(r.maxMs ?? 0); this.loopSamples += r.samples ?? 0;
        this.slowWindows.push(r); this.slowWindows.sort((a,b) => (b.maxMs ?? 0) - (a.maxMs ?? 0)); this.slowWindows.length = Math.min(this.slowWindows.length, 10);
        break;
      case 'operation':
        if (r.outcome === 'pending') this.pendingOperations++;
        else this.completedOperations.add(duration);
        this.slowOperations.push(r); this.slowOperations.sort((a,b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)); this.slowOperations.length = Math.min(this.slowOperations.length, 20);
        break;
      case 'offer': this.finishedOffers += Number(r.outcome === 'finished'); this.abandonedOffers += Number(r.outcome === 'abandoned'); break;
    }
  }
  get sampled() { return [this.client, this.server, this.http, this.index, this.loop, this.completedOperations].some((v) => v.count > v.values.length); }
  summary() {
    const loop = this.loop.summary();
    return { clientRequests: this.client.summary(), clientTimeouts: this.clientTimeouts, clientFailures: this.clientFailures,
      hookFailures: this.hookFailures, serverRequests: this.server.summary(), abandonedRequests: this.abandonedRequests,
      httpRequests: this.http.summary(), eventLoop: { windows: loop.count, samples: this.loopSamples,
        p99WindowMaxMs: loop.p99Ms, maxMs: loop.maxMs, slowestWindows: this.slowWindows }, searchUpdates: this.index.summary(),
      operations: { completed: this.completedOperations.summary(), pendingObservations: this.pendingOperations, slowest: this.slowOperations },
      offerResponsesFinished: this.finishedOffers, offerResponsesAbandoned: this.abandonedOffers };
  }
}
export function summarizeCoordinationTelemetry(records: Measurement[]) {
  const measurements = new Measurements(); for (const r of records) measurements.add(r); return measurements.summary();
}

/** Stream private bounded logs in the audit subprocess, never on the server thread. */
export async function readCoordinationTelemetry(runtimeDir: string, from: number, until: number) {
  const directory = path.join(runtimeDir, 'coordination', 'telemetry');
  const offers: Measurement[] = [], issues = new Set<string>();
  const all = new Measurements(), recent = new Measurements();
  let firstRecordedAt: number | null = null, lastRecordedAt: number | null = null;
  const result = () => ({ available: firstRecordedAt !== null, issues: [...issues], offers,
    summary: all.summary(), recentSummary: recent.summary(), firstRecordedAt, lastRecordedAt });
  let files: string[];
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Telemetry directory is a symlink.');
    files = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    issues.add('No coordination telemetry has been collected.'); return result();
  }
  for (const name of files.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}(?:\.failures)?\.(jsonl|full)$/.test(name)) continue;
    const day = name.slice(0, 10);
    if (day < new Date(from).toISOString().slice(0, 10) || day > new Date(until).toISOString().slice(0, 10)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    const limit = name.includes('.failures.') ? TELEMETRY_FAILURE_MAX_BYTES : TELEMETRY_MAX_BYTES;
    // Independent appenders may cross the cap by a few records. Continue to
    // read those observed failures, but never read an arbitrarily large file.
    if (!stat.isFile() || stat.size > limit + 64 * 1024) { issues.add(`Unsafe or oversized telemetry file ${name}.`); continue; }
    if (stat.size > limit) issues.add(`Telemetry capacity exceeded in ${name}; counts are incomplete.`);
    if (name.endsWith('.full')) {
      issues.add(name.includes('.failures.')
        ? `Delivery failure telemetry capacity reached on ${day}; failure/offer counts are incomplete.`
        : `Routine telemetry capacity reached on ${day}; request/latency counts are incomplete; delivery failures have a separate log.`);
      continue;
    }
    const stream = fs.createReadStream(file);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const r = JSON.parse(line) as Measurement;
          if (!Number.isFinite(r.timestamp) || !['rpc_client', 'rpc_server', 'http', 'index', 'hook', 'event_loop', 'offer', 'operation'].includes(r.kind)
            || ['durationMs', 'maxMs', 'p99Ms', 'samples', 'offeredAt', 'startedAt', 'spanId', 'pid', 'windowMs', 'cpuUserMs', 'cpuSystemMs', 'utilization', 'rssBytes']
              .some((key) => key in r && !Number.isFinite(r[key as keyof Measurement]))) throw new Error('Invalid measurement');
          if (r.timestamp < from || r.timestamp > until) continue;
          firstRecordedAt = Math.min(firstRecordedAt ?? r.timestamp, r.timestamp);
          lastRecordedAt = Math.max(lastRecordedAt ?? r.timestamp, r.timestamp);
          all.add(r);
          if (r.timestamp >= until - 600_000) recent.add(r);
          if (r.kind === 'offer') {
            if (offers.length < TELEMETRY_MAX_OFFERS) offers.push(r);
            else issues.add('Offer-history limit reached; offer timing coverage is incomplete. Failure counts remain complete.');
          }
        } catch { issues.add(`Incomplete or invalid telemetry record in ${name}.`); }
      }
    } finally { lines.close(); stream.destroy(); }
  }
  if (all.sampled || recent.sampled) issues.add('Latency sample limit reached; percentiles are partial. Failure counts and maxima remain complete.');
  return result();
}
