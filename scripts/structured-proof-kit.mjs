// Shared harness for the opt-in real-provider proofs of the structured lane (`prove-structured-claude.mjs`,
// `prove-structured-migration.mjs`). The Codex proof predates it: it keeps its own copy of the harness and imports only the
// standalone helpers exported here (the PNG builders, the event-log reader, the control-text list and the leftover-process scan).
//
// It builds one isolated Console: temp root, generated config, temp database and runtime, scratch git project, a private
// tmux socket and a free port. The backend is `buildApp` from the compiled server, driven with `app.inject` (it never
// listens). Nothing here reads or writes the live Console's runtime, database or config, or Bryan's provider settings:
// the live `~/.config/agent-console/config.json` is only read for its tmux provider commands. `finish` always runs the
// cleanup (release, backend shutdown, session hosts, leftover processes of this proof, private tmux server, a final scan for
// lane processes, temp root). A failure while the kit is being built, or after it was returned but before the caller's own
// `finally`, still ends everything the proof started and removes the temp root (`createProofKit` and the `exit` backstop).
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

/**
 * The time left of a window that began at `since` (a `Date.now()` taken just before the action the window follows), as the
 * timeout of a `wait`. The checks made in between use the window up, so a wait that counts from its own start would stretch it.
 * Fails at once when they already did.
 */
export const windowLeft = (label, since, windowMs) => {
  const left = since + windowMs - Date.now();
  if (left <= 0) throw new Error(`${label}: the ${windowMs} ms window had run out ${-left} ms before this check began.`);
  return left;
};

// ---- images ------------------------------------------------------------------------------------------------
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, body, crc]);
};
/** An 8-bit RGB PNG from scanlines that already carry their filter byte (0, none). Built here so the proofs need no image library. */
const encodePng = (width, height, scanlines) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
};

/** A small solid-colour PNG (8-bit RGB). */
export const solidPng = (size, [red, green, blue]) => {
  const line = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  return encodePng(size, size, Buffer.concat(Array.from({ length: size }, () => line)));
};

/**
 * A screenshot-sized PNG that is large on disk: a solid base colour with random noise (`spread` values wide, centred on the base) on
 * every channel of every pixel. Noise does not compress, so the file is above the Messages API's 5 MB image limit while the dominant
 * colour stays the base colour. 2560x1440 with the default spread is about 6.5 MiB: over 5 MB, under the Console's 10 MiB upload limit
 * and its 20 megapixel limit.
 */
export const noisyPng = (width, height, [red, green, blue], spread = 16) => {
  const base = [red, green, blue];
  const stride = 1 + width * 3;
  const random = randomBytes(width * height * 3);
  const scanlines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width * 3; x += 1) {
      const value = base[x % 3] + (random[y * width * 3 + x] % spread) - (spread >> 1);
      scanlines[y * stride + 1 + x] = Math.max(0, Math.min(255, value));
    }
  }
  const png = encodePng(width, height, scanlines);
  if (png.length <= 5 * 1024 * 1024 || png.length >= 10 * 1024 * 1024) throw new Error(`The noisy PNG is ${png.length} bytes; it must be between 5 MiB and 10 MiB.`);
  return png;
};

// ---- event log and Console control text ---------------------------------------------------------------------------
/** The entries of a session's event log (`bound_sessions.event_log_path`, one JSON object per line) from a byte offset on, and the log's size. */
export const readEventLog = (file, fromByte = 0) => {
  if (!file || !fs.existsSync(file)) return { size: 0, entries: [] };
  const size = fs.statSync(file).size;
  if (size <= fromByte) return { size, entries: [] };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buffer, 0, buffer.length, fromByte);
    return { size, entries: buffer.toString('utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) };
  } finally { fs.closeSync(fd); }
};
/** The status lines a lost or recovered turn leaves in an event log (session-manager `handleStructuredConnectionLoss` and the automatic recovery). */
export const lostTurnStatusLines = entries => entries.filter(entry => entry.type === 'status' && /connection ended|Submitted automatic recovery|Provider recovery/i.test(String(entry.text ?? ''))).map(entry => String(entry.text).slice(0, 160));
/**
 * Text the Console itself puts into a conversation after it decides a turn was lost or a peer needs a wake: the automatic recovery
 * prompt and the coordination wake prompts (`scripts/coordination-notices.mjs`). A turn that survived a restart must not meet any of them.
 */
export const consoleControlTexts = async () => {
  const { RECOVERY_PROMPT } = await import(new URL('../apps/server/dist/sessions/run-recovery.js', import.meta.url));
  const notices = await import('./coordination-notices.mjs');
  const texts = [RECOVERY_PROMPT, notices.PEER_WAKE_PROMPT, notices.UNATTENDED_CONTINUATION_PROMPT, notices.GRANTED_RESTART_PROMPT];
  assert.ok(texts.every(text => typeof text === 'string' && text.length > 80), 'The recovery and wake prompts must be strings.');
  return texts;
};
/** The first control text (shortened) that `value` (a string or any JSON-able record) contains, or undefined. */
export const findControlText = (value, texts) => {
  const haystack = typeof value === 'string' ? value : JSON.stringify(value);
  return texts.map(text => text.slice(0, 60)).find(prefix => haystack.includes(prefix));
};

// ---- processes a proof can leave behind ---------------------------------------------------------------------------
/** The kinds of process the structured lane starts, by a fragment of their command line. */
export const PROOF_PROCESS_KINDS = [
  { kind: 'session host', fragment: 'session-host' },
  { kind: 'codex app-server', fragment: 'codex app-server' },
  { kind: 'claude process', fragment: 'claude --output-format' },
  { kind: 'coordination MCP server', fragment: 'agent-coord.mjs mcp' },
];
const readProc = (pid, file) => { try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return ''; } };
/** Running, not merely a zombie awaiting its parent. */
export const isRunning = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
  } catch { return false; }
};
/** A proof's temp root is `mkdtemp` under the temp directory. Anything else could match the live Console's processes, so it is refused. */
const assertProofRoot = root => {
  const base = os.tmpdir();
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.dirname(root) !== base || path.basename(root).length < 16) throw new Error(`Not a proof temp root: ${root}`);
};
/**
 * Every running process of a lane kind (`PROOF_PROCESS_KINDS`) that belongs to the proof whose temp root is `root`: its command line
 * or its environment names the root (the runtime, the config and the host socket all live under it). The root is random per run, so
 * the live Console's processes and Bryan's own sessions never match.
 */
export const scanProofProcesses = root => {
  assertProofRoot(root);
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const pid = Number(name);
    const command = readProc(pid, 'cmdline').split('\0').filter(Boolean).join(' ');
    const kind = PROOF_PROCESS_KINDS.find(entry => command.includes(entry.fragment))?.kind;
    if (!kind || !isRunning(pid)) continue;
    if (command.includes(root) || readProc(pid, 'environ').includes(root)) found.push({ pid, kind, command: command.slice(0, 100) });
  }
  return found;
};
const signalAll = (found, signal) => { for (const { pid } of found) { try { process.kill(pid, signal); } catch { /* gone */ } } };
/**
 * Last resort for a failure the proof's own `finally` never sees (an error before its `try`, or an uncaught one): the process is
 * ending, so only synchronous work is possible. Lane processes of this proof are ended, its private tmux server stopped and its
 * temp root removed. After a normal cleanup there is nothing left and this does nothing. `tmuxSocket` is read when the process exits.
 */
export const installExitBackstop = (root, tmuxSocket) => process.once('exit', () => {
  try { signalAll(scanProofProcesses(root), 'SIGKILL'); } catch { /* best effort */ }
  try { const socket = tmuxSocket(); if (socket) spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
/**
 * The last look before a proof reports: wait briefly for lane processes of this proof to leave on their own (a killed tmux server hands
 * them SIGHUP), then end whatever is still there, SIGTERM first. Returns what it had to end, and what even SIGKILL left.
 */
export const endProofProcesses = async root => {
  for (let waited = 0; waited < 3000 && scanProofProcesses(root).length > 0; waited += 250) await sleep(250);
  const found = scanProofProcesses(root);
  signalAll(found, 'SIGTERM');
  if (found.length) await sleep(2000);
  const stubborn = scanProofProcesses(root);
  signalAll(stubborn, 'SIGKILL');
  if (stubborn.length) await sleep(500);
  return { found, stubborn, remaining: scanProofProcesses(root) };
};
export const summarizeProcesses = found => [...new Set(found.map(entry => entry.kind))].map(kind => `${found.filter(entry => entry.kind === kind).length} ${kind}`).join(', ');

/** The session hosts a run left recorded under its runtime (`structured/hosts/<hostId>.json`), plus the ones the caller names. */
const endRecordedHosts = async ({ runtimeDir, lineTransport, named = [], note }) => {
  const recorded = (() => { try { return fs.readdirSync(path.join(runtimeDir, 'structured', 'hosts')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)); } catch { return []; } })();
  for (const hostId of new Set([...named, ...recorded])) {
    const record = path.join(runtimeDir, 'structured', 'hosts', `${hostId}.json`);
    try {
      if (fs.existsSync(record)) {
        await lineTransport.terminateHost(runtimeDir, hostId, { info: () => undefined, warn: () => undefined });
        note(`terminate host ${hostId}`, !fs.existsSync(record));
      }
    } catch (error) { note(`terminate host ${hostId}`, false, String(error.message)); }
  }
};

/**
 * Builds the isolated environment. If anything fails while it is built, whatever it started is ended and the temp root removed
 * before the error is rethrown. The callers' own `finally` only exists once this has returned.
 */
export async function createProofKit(options) {
  const claim = { root: undefined, runtimeDir: undefined, tmuxSocket: undefined, state: undefined, lineTransport: undefined };
  try {
    return await buildProofKit(options, claim);
  } catch (error) {
    process.stderr.write(`PROOF setup failed (${String(error instanceof Error ? error.message : error).slice(0, 300)}); ending what it started\n`);
    try { await claim.state?.app?.close(); } catch { /* not started or already closed */ }
    try { if (claim.lineTransport && claim.runtimeDir) await endRecordedHosts({ runtimeDir: claim.runtimeDir, lineTransport: claim.lineTransport, note: () => undefined }); } catch { /* best effort */ }
    try { if (claim.root) await endProofProcesses(claim.root); } catch { /* best effort */ }
    try { if (claim.tmuxSocket) spawnSync('tmux', ['-L', claim.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
    try { if (claim.root) fs.rmSync(claim.root, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function buildProofKit({ script, rootPrefix, evidenceSubdir, expectedSteps, portFrom = 14390, portTo = 14399, extraEvidence = {} }, claim) {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { buildApp } = await import(new URL('../apps/server/dist/app.js', import.meta.url));
  const lineTransport = await import(new URL('../apps/server/dist/providers/transport/line-transport.js', import.meta.url));
  claim.lineTransport = lineTransport;

  // ---- isolated environment ------------------------------------------------------------------------------
  const startedAt = new Date();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${rootPrefix}-`));
  claim.root = root;
  // Covers an error between this call's return and the caller's own `try`, and an uncaught one.
  installExitBackstop(root, () => claim.tmuxSocket);
  const project = path.join(root, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console proof project. Do not edit files. Follow each short test prompt exactly.\n');
  const configPath = path.join(root, 'config.json');
  const runtimeDir = path.join(root, 'runtime');
  claim.runtimeDir = runtimeDir;
  const databasePath = path.join(root, 'fixture.sqlite');
  const tmuxSocket = `${rootPrefix}-${randomUUID().slice(0, 8)}`;
  claim.tmuxSocket = tmuxSocket;
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
  claim.state = state;
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
  // The first signal stops the proof at its next poll so `finish` runs; a second one leaves at once (the `exit` backstop still cleans up).
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (interrupted) { say(`${signal} again: leaving now`); process.exit(130); }
    interrupted = true;
    say(`${signal}: stopping at the next poll; cleanup will run`);
  });
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
  const alive = isRunning;
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
  /** Processes of this proof: anything whose command line holds the temp root, anything started with this runtime, and every lane process that names the temp root. */
  const listProcesses = () => [...new Set([...pgrep(root), ...processesWithRuntime(), ...scanProofProcesses(root).map(entry => entry.pid)])].filter(pid => alive(pid));
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
   * The cleanup tail, run on every path. `releaseAll` releases whatever the proof bound; `hostIds` are session hosts to end
   * explicitly (every host record left under the runtime is ended too); `afterCleanup` removes provider-side files this proof
   * caused (before the verdict). The last act is a scan for lane processes (session hosts, `codex app-server`, `claude
   * --output-format`, `agent-coord.mjs mcp`) that name this proof's temp root in their command line or environment; anything
   * it finds is ended and the run is marked as having needed that.
   */
  const finish = async ({ releaseAll, hostIds = [], afterCleanup } = {}) => {
    const note = (name, ok, detail) => { evidence.cleanup.push({ name, ok, ...(detail ? { detail } : {}) }); };
    try {
      if (state.app && releaseAll) { await releaseAll(); note('release sessions', true); }
    } catch (error) { note('release sessions', false, String(error.message)); }
    try { await shutdown(); note('backend shutdown', true); } catch (error) { note('backend shutdown', false, String(error.message)); }
    await endRecordedHosts({ runtimeDir, lineTransport, named: hostIds, note });
    try {
      const leftover = listProcesses();
      for (const pid of leftover) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      if (leftover.length) await sleep(2000);
      const stubborn = listProcesses();
      for (const pid of stubborn) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      if (stubborn.length) await sleep(500);
      // After a run whose steps all passed, release had already ended everything: a process found here is a defect, not tidying up after a failure.
      note('leftover processes', listProcesses().length === 0 && (leftover.length === 0 || evidence.steps.some(entry => !entry.pass)), `${leftover.length} found, ${stubborn.length} needed SIGKILL`);
    } catch (error) { note('leftover processes', false, String(error.message)); }
    try { tmux('kill-server'); note('private tmux server', tmux('ls').status !== 0); } catch (error) { note('private tmux server', false, String(error.message)); }
    try { await afterCleanup?.(note); } catch (error) { note('provider-side files', false, String(error.message)); }
    try {
      const { found, remaining } = await endProofProcesses(root);
      note('final process scan', found.length === 0 && remaining.length === 0, found.length ? `had to end ${found.length} lane process(es) still running: ${summarizeProcesses(found)}${remaining.length ? `; ${remaining.length} survived SIGKILL` : ''}` : 'no lane process of this proof left');
      if (found.length) say(`FINAL SCAN found and ended ${found.length} lane process(es): ${summarizeProcesses(found)}`);
    } catch (error) { note('final process scan', false, String(error.message)); }
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
