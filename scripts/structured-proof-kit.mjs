// Shared harness for the opt-in real-provider proofs of the structured lane (`prove-structured-claude.mjs`,
// `prove-structured-migration.mjs`). The Codex proof predates it and keeps its own copy of these helpers.
//
// It builds one isolated Console: temp root, generated config, temp database and runtime, scratch git project, a private
// tmux socket and a free port. The backend is `buildApp` from the compiled server, driven with `app.inject` (it never
// listens). Nothing here reads or writes the live Console's runtime, database or config, or Bryan's provider settings:
// the live `~/.config/agent-console/config.json` is only read for its tmux provider commands. `finish` always runs the
// cleanup (release, backend shutdown, session hosts, leftover processes of this proof, private tmux server, temp root).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A solid-colour PNG (8-bit RGB), built here so the proofs need no image library. */
export const solidPng = (size, [red, green, blue]) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => line));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

export async function createProofKit({ script, rootPrefix, evidenceSubdir, expectedSteps, portFrom = 14390, portTo = 14399, extraEvidence = {} }) {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { buildApp } = await import(new URL('../apps/server/dist/app.js', import.meta.url));
  const lineTransport = await import(new URL('../apps/server/dist/providers/transport/line-transport.js', import.meta.url));

  // ---- isolated environment ------------------------------------------------------------------------------
  const startedAt = new Date();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${rootPrefix}-`));
  const project = path.join(root, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console proof project. Do not edit files. Follow each short test prompt exactly.\n');
  const configPath = path.join(root, 'config.json');
  const runtimeDir = path.join(root, 'runtime');
  const databasePath = path.join(root, 'fixture.sqlite');
  const tmuxSocket = `${rootPrefix}-${randomUUID().slice(0, 8)}`;
  // A structured session must never reach tmux; if it did, the call would land on this private, empty socket.
  process.env.AGENT_CONSOLE_TMUX_SOCKET = tmuxSocket;

  const freePort = async () => {
    for (let candidate = portFrom; candidate <= portTo; candidate += 1) {
      const free = await new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
      });
      if (free) return candidate;
    }
    throw new Error(`No free port in ${portFrom}-${portTo}.`);
  };
  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const salt = randomBytes(16).toString('hex');

  /** The generated config: the example template with the isolation settings, then `mutate(config)`. Written mode 0600. */
  const writeConfig = mutate => {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/agent-console.example.json'), 'utf8'));
    Object.assign(config, {
      projectsRoot: path.join(root, 'projects'), runtimeDir, databasePath,
      projects: { demo: { active: true, explicit: true, path: project } },
      coordination: { enabled: true, pilotPaths: [project] },
      workerSummaries: { enabled: false },
      conversationTitles: { enabled: false, runtimeCommand: config.conversationTitles.runtimeCommand },
    });
    Object.assign(config.server, { host: '127.0.0.1', port, publicBaseUrl: `http://127.0.0.1:${port}`, webDistPath: path.join(repoRoot, 'apps/web/dist') });
    Object.assign(config.security, {
      passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
      sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false,
    });
    config.sessions.pressureSuspendAvailableMiB = 512;
    mutate?.(config);
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    return config;
  };

  // ---- evidence ------------------------------------------------------------------------------------------
  const evidenceDir = path.join(repoRoot, 'test-results', evidenceSubdir);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  const evidence = {
    script, startedAt: startedAt.toISOString(), finishedAt: null,
    revision: (() => { try { return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    // Uncommitted source files the build may include: a proof of a dirty tree says so.
    workingTree: (() => { try { return execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'apps', 'packages'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(line => line.slice(3)); } catch { return []; } })(),
    node: process.version, tempRoot: root, runtimeDir, port, ...extraEvidence,
    pids: {}, steps: [], findings: [], cleanup: [], result: 'running',
  };
  const flush = () => fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const say = line => process.stderr.write(`PROOF ${line}\n`);
  const brief = values => Object.entries(values).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ');
  /** A place where the real provider behaved differently from, or settled something the research brief left open. */
  const finding = (id, text) => {
    if (!evidence.findings.some(entry => entry.id === id)) evidence.findings.push({ id, text });
    say(`FINDING ${id}: ${text}`);
  };
  say(`evidence ${evidencePath}`);
  say(`temp root ${root} (removed at the end)`);

  // ---- backend, auth, HTTP helpers -------------------------------------------------------------------------
  const state = { app: undefined, db: undefined, headers: undefined };
  const boot = async () => {
    ({ app: state.app } = await buildApp({ configPath }));
    await state.app.ready();
    state.db = new Database(databasePath, { readonly: true });
    const login = await state.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    assert.equal(login.statusCode, 200, `login: ${login.statusCode}`);
    state.headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
  };
  const shutdown = async () => {
    const closing = state.app;
    state.app = undefined;
    try { state.db?.close(); } catch { /* already closed */ }
    state.db = undefined;
    if (closing) await closing.close();
  };
  const parse = response => { try { return response.body ? response.json() : undefined; } catch { return undefined; } };
  const call = async (method, url, payload) => {
    const response = await state.app.inject({ method, url, payload, headers: state.headers });
    return { status: response.statusCode, body: parse(response) };
  };
  const api = async (method, url, payload) => {
    const { status, body } = await call(method, url, payload);
    assert.ok(status < 300, `${method} ${url.replace(/[0-9a-f-]{36}/g, ':id')}: HTTP ${status} ${body?.error ?? ''}`);
    return body;
  };
  // Ctrl-C or SIGTERM stops the proof at its next poll, so the cleanup in `finish` still runs.
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; say(`${signal}: stopping at the next poll; cleanup will run`); });
  const wait = async (label, predicate, timeout = 180_000, interval = 500) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (interrupted) throw new Error('Interrupted by a signal.');
      const result = await predicate();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeout / 1000)} s: ${label}`);
      await sleep(interval);
    }
  };

  // ---- process helpers (Linux /proc) -----------------------------------------------------------------------
  /** Running, not merely a zombie awaiting its parent. */
  const alive = pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
    } catch { return false; }
  };
  const pgrep = pattern => spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
  const procEntries = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
  const environOf = pid => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); } catch { return []; } };
  const envValue = (pid, name) => environOf(pid).find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const cmdlineOf = pid => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((part, index, all) => part.length > 0 || index < all.length - 1); } catch { return []; } };
  const statFields = pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    } catch { return undefined; }
  };
  /** The start time of a live process in clock ticks (field 22 of /proc/<pid>/stat), as the session host records it. */
  const startTicksOf = pid => statFields(pid)?.[19];
  const parentOf = pid => { const fields = statFields(pid); return fields ? Number(fields[1]) : undefined; };
  const childrenOf = pid => procEntries().filter(entry => parentOf(entry) === pid);
  /** Every live descendant of a process. */
  const descendantsOf = pid => {
    const all = [];
    const queue = [pid];
    while (queue.length) for (const child of childrenOf(queue.shift())) { all.push(child); queue.push(child); }
    return all;
  };
  const withEnv = entry => procEntries().filter(pid => pid !== process.pid && environOf(pid).includes(entry));
  /** Every process carrying this proof's coordination runtime in its environment: providers, hooks, MCP servers, model commands. */
  const processesWithRuntime = () => withEnv(`AGENT_COORD_RUNTIME=${runtimeDir}`);
  /** `agent-coord.mjs mcp` servers started for this Console's runtime. Their runtime is in the environment, not the command line. */
  const coordMcpProcesses = () => pgrep('agent-coord\\.mjs mcp').filter(pid => environOf(pid).includes(`AGENT_COORD_RUNTIME=${runtimeDir}`));
  /** Processes of this proof: anything whose command line holds the temp root, plus anything started with this runtime. */
  const listProcesses = () => [...new Set([...pgrep(root), ...processesWithRuntime()])].filter(pid => alive(pid));
  const hostRecordPath = hostId => path.join(runtimeDir, 'structured', 'hosts', `${hostId}.json`);
  const hostRecord = hostId => JSON.parse(fs.readFileSync(hostRecordPath(hostId), 'utf8'));
  const tmux = (...args) => spawnSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' });

  // ---- step runner -----------------------------------------------------------------------------------------
  let aborted = false;
  const hooks = { beforeStep: async () => undefined };
  const step = async (id, name, fn, { fatal = false } = {}) => {
    const entry = { id, name, pass: false, skipped: false, ms: 0, values: {} };
    if (interrupted) aborted = true;
    if (aborted) {
      entry.skipped = true;
      entry.error = 'Skipped: an earlier fatal step failed.';
    } else {
      const t0 = Date.now();
      try {
        await hooks.beforeStep(entry);
        await fn(entry.values);
        entry.pass = true;
      } catch (error) {
        entry.error = String(error instanceof Error ? error.message : error).slice(0, 700);
        if (fatal) aborted = true;
      }
      entry.ms = Date.now() - t0;
    }
    evidence.steps.push(entry);
    flush();
    say(`${entry.skipped ? 'SKIP' : entry.pass ? 'PASS' : 'FAIL'} ${id}. ${name} (${entry.ms} ms)${entry.error ? ` -- ${entry.error}` : ` ${brief(entry.values)}`}`);
    return entry;
  };

  /**
   * The cleanup tail, run on every path. `releaseAll` releases whatever the proof bound; `hostIds` are the session hosts to
   * end explicitly; `afterCleanup` removes provider-side files this proof caused (before the verdict).
   */
  const finish = async ({ releaseAll, hostIds = [], afterCleanup } = {}) => {
    const note = (name, ok, detail) => { evidence.cleanup.push({ name, ok, ...(detail ? { detail } : {}) }); };
    try {
      if (state.app && releaseAll) { await releaseAll(); note('release sessions', true); }
    } catch (error) { note('release sessions', false, String(error.message)); }
    try { await shutdown(); note('backend shutdown', true); } catch (error) { note('backend shutdown', false, String(error.message)); }
    for (const hostId of hostIds) {
      try {
        if (fs.existsSync(hostRecordPath(hostId))) {
          await lineTransport.terminateHost(runtimeDir, hostId, { info: () => undefined, warn: () => undefined });
          note(`terminate host ${hostId}`, !fs.existsSync(hostRecordPath(hostId)));
        }
      } catch (error) { note(`terminate host ${hostId}`, false, String(error.message)); }
    }
    try {
      const leftover = listProcesses();
      for (const pid of leftover) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      if (leftover.length) await sleep(2000);
      const stubborn = listProcesses();
      for (const pid of stubborn) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      if (stubborn.length) await sleep(500);
      note('leftover processes', listProcesses().length === 0, `${leftover.length} found, ${stubborn.length} needed SIGKILL`);
    } catch (error) { note('leftover processes', false, String(error.message)); }
    try { tmux('kill-server'); note('private tmux server', tmux('ls').status !== 0); } catch (error) { note('private tmux server', false, String(error.message)); }
    try { await afterCleanup?.(note); } catch (error) { note('provider-side files', false, String(error.message)); }
    try { fs.rmSync(root, { recursive: true, force: true }); note('remove temp root', !fs.existsSync(root)); } catch (error) { note('remove temp root', false, String(error.message)); }
    const failed = evidence.steps.filter(entry => !entry.pass && !entry.skipped).length;
    const skipped = evidence.steps.filter(entry => entry.skipped).length;
    const cleanupFailed = evidence.cleanup.filter(entry => !entry.ok).length;
    evidence.finishedAt = new Date().toISOString();
    evidence.result = failed === 0 && skipped === 0 && cleanupFailed === 0 && evidence.steps.length === expectedSteps ? 'pass' : 'fail';
    evidence.summary = { passed: evidence.steps.filter(entry => entry.pass).length, failed, skipped, cleanupFailed };
    flush();
    say(`${evidence.result.toUpperCase()}: ${evidence.summary.passed} passed, ${failed} failed, ${skipped} skipped, ${cleanupFailed} cleanup problems. Evidence ${evidencePath}`);
    process.exitCode = evidence.result === 'pass' ? 0 : 1;
  };

  return {
    repoRoot, root, project, configPath, runtimeDir, databasePath, tmuxSocket, port, evidence, evidencePath, writeConfig, flush, say, finding,
    state, boot, shutdown, call, api, wait, sleep, alive, pgrep, procEntries, environOf, envValue, cmdlineOf, startTicksOf, parentOf, childrenOf,
    descendantsOf, withEnv, processesWithRuntime, coordMcpProcesses, listProcesses, hostRecordPath, hostRecord, tmux, step, hooks, finish,
    get app() { return state.app; }, get db() { return state.db; }, get headers() { return state.headers; },
  };
}
