import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService, processStart } from '../src/coordination/service.js';
import { checkoutIdentity } from '../src/coordination/git.js';
import { dispatchCoordination, registerCoordinationRoutes, startCoordinationSocket } from '../src/coordination/transport.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function runHelper(root: string, checkout: string, args: string[], input: unknown) {
  const helper = process.env.AGENT_COORD_HELPER ?? path.resolve('..', '..', 'scripts', 'agent-coord.mjs');
  const configPath = path.join(root, 'host-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ runtimeDir: root, coordination: { enabled: true, pilotPaths: [checkout] } }));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { env: { ...process.env, CODEX_THREAD_ID: '', AGENT_COORD_RUNTIME: root, AGENT_CONSOLE_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'));
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  git(checkout, ['config', 'user.name', 'Coordination Test']);
  git(checkout, ['config', 'user.email', 'coordination@example.invalid']);
  fs.mkdirSync(path.join(checkout, 'src'));
  fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'original a\n');
  fs.writeFileSync(path.join(checkout, 'b.txt'), 'original b\n');
  git(checkout, ['add', '.']); git(checkout, ['commit', '-qm', 'initial']);
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [checkout] });
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function register(provider = 'codex') {
    const token = randomUUID();
    const nativeSessionId = randomUUID();
    const result = service.register({ provider, token, nativeSessionId, pid: process.pid, cwd: checkout });
    const id = result.assignmentId!;
    service.update(id, { description: `${provider} test`, checkout, summary: 'Test scope' });
    return { id, token, nativeSessionId };
  }
  return { root, checkout, db, service, register };
}

describe('assignment coordination', () => {
  it('registers outside the pilot and joins an explicitly announced pilot checkout', () => {
    const { root, checkout, service } = fixture();
    const result = service.register({ provider: 'codex', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root });
    expect(result.enabled).toBe(true);
    service.update(result.assignmentId!, { checkout, summary: 'Cross-repo assignment' });
    expect(service.snapshot(checkout).assignments.map((a) => a.id)).toContain(result.assignmentId);
  });

  it('repairs a lost credential only for the original live process, preserving activity', () => {
    const { checkout, service, db, register } = fixture();
    const a = register();
    const token = randomUUID();
    expect(service.register({ provider: 'codex', nativeSessionId: a.nativeSessionId, token, pid: process.pid, cwd: checkout }).assignmentId).toBe(a.id);
    expect(() => service.authenticate(a.id, a.token)).toThrow('credential');
    service.authenticate(a.id, token);
    expect(service.snapshot(checkout).assignments[0]?.id).toBe(a.id);
    db.sqlite.prepare('update coordination_assignments set process_start=? where id=?').run('different-start', a.id);
    expect(() => service.register({ provider: 'codex', nativeSessionId: a.nativeSessionId, token: randomUUID(), pid: process.pid, cwd: checkout })).toThrow('original live provider process');
    service.authenticate(a.id, token);
  });

  it('delivers oversized historical events in bounded form and advances to subsequent updates', async () => {
    const { checkout, db, service, register } = fixture();
    const a = register(); const b = register('claude');
    const cursor = service.poll(b.id, 0).cursor;
    const paths = Array.from({ length: 85 }, (_, i) => `${i}-${'x'.repeat(100)}.txt`);
    db.sqlite.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)').run(a.id, checkout, 'update', paths.join(', '), new Date().toISOString());
    service.update(a.id, { checkout, summary: 'Later update must arrive' });
    const result = service.poll(b.id, cursor);
    expect(result.cursor).toBeGreaterThan(cursor);
    expect(result.events.some((event) => event.text.includes('abbreviated'))).toBe(true);
    expect(result.events.some((event) => event.text === 'Later update must arrive')).toBe(true);
    expect(JSON.stringify({ events: result.events, messages: result.messages }).length).toBeLessThan(8000);
    expect((db.sqlite.prepare("select length(text) as n from coordination_events where length(text)>8000").get() as { n: number }).n).toBeGreaterThan(8000);
  });
  it('persists one credential before RPC and reuses it through concurrent registration and client loss', async () => {
    const { root, checkout, service, db } = fixture();
    const nativeSessionId = randomUUID();
    const input = { provider: 'codex', nativeSessionId, pid: process.pid, cwd: checkout };
    // The RPC cannot succeed yet. Its credential must already exist durably.
    expect((await runHelper(root, checkout, ['register'], input)).code).toBe(1);
    const statePath = path.join(root, 'coordination/clients', `${createHash('sha256').update(`codex:${nativeSessionId}`).digest('hex')}.json`);
    const seed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(seed.token).toHaveLength(64);
    expect(seed.assignmentId).toBeUndefined();
    const ipc = await startCoordinationSocket(service, root); cleanups.push(() => ipc.close());
    const attempts = await Promise.all(Array.from({ length: 4 }, () => runHelper(root, checkout, ['register'], input)));
    for (const attempt of attempts) expect(attempt.code, attempt.stderr).toBe(0);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.token).toBe(seed.token);
    expect(new Set(attempts.map((attempt) => JSON.parse(attempt.stdout).assignmentId)).size).toBe(1);
    const duplicate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    cleanups.push(() => { duplicate.kill(); });
    const rejected = await runHelper(root, checkout, ['register'], { ...input, pid: duplicate.pid });
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('live coordination owner');
    expect(fs.existsSync(path.join(root, 'coordination/owners', `${duplicate.pid}-${processStart(duplicate.pid!)}.json`))).toBe(false);
    service.update(saved.assignmentId, { checkout, summary: 'Before client loss' });
    fs.unlinkSync(statePath);
    const repaired = await runHelper(root, checkout, ['register'], input);
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout).assignmentId).toBe(saved.assignmentId);
    expect(service.snapshot(checkout).scopes.some((scope) => scope.summary === 'Before client loss')).toBe(true);
    expect((db.sqlite.prepare('select count(*) as n from coordination_assignments').get() as { n: number }).n).toBe(1);
  });

  it('recognizes worktrees as one repository but separate editing locations', () => {
    const { root, checkout, service, register } = fixture();
    const linked = path.join(root, 'linked');
    git(checkout, ['worktree', 'add', '--detach', linked]);
    const a = register(); const b = register('claude');
    service.update(b.id, { checkout: linked, summary: 'Detached worktree' });
    expect(checkoutIdentity(linked).repository).toBe(checkoutIdentity(checkout).repository);
    expect(service.snapshot(checkout).scopes.some((scope) => scope.checkout === checkout)).toBe(true);
    expect(service.snapshot(checkout).scopes.some((scope) => scope.checkout === linked)).toBe(true);
    expect(service.snapshot(checkout).assignments).toHaveLength(2);
    expect(service.poll(a.id, 0).events.some((e) => e.checkout === linked)).toBe(true);
  });

  it('authenticates the sender, deduplicates messages and separates supply from acknowledgement', async () => {
    const { service, register } = fixture();
    const a = register(); const b = register('claude');
    const id = randomUUID();
    await expect(dispatchCoordination(service, { action: 'send', assignmentId: a.id, token: b.token, recipientId: b.id, messageId: id, text: 'test' })).rejects.toThrow('credential');
    service.send(a.id, { id, recipientId: b.id, text: 'Review the shared contract.' });
    service.send(a.id, { id, recipientId: b.id, text: 'Review the shared contract.' });
    expect(service.snapshot().messages).toHaveLength(1);
    expect(service.snapshot().messages[0]?.suppliedAt).toBeNull();
    expect(() => service.acknowledge(b.id, [id])).toThrow('supplied');
    expect(service.poll(b.id, 0).messages[0]?.id).toBe(id);
    expect(service.poll(b.id, 0).messages).toHaveLength(0);
    expect(service.snapshot().messages[0]?.acknowledgedAt).toBeNull();
    expect(() => service.acknowledge(a.id, [id])).toThrow('recipient');
    service.acknowledge(b.id, [id]);
    expect(service.snapshot().messages[0]?.acknowledgedAt).not.toBeNull();
  });

  it('keeps scoped history and pending messages across database restart', () => {
    const { root, checkout, service, register } = fixture();
    const a = register(); const b = register('claude');
    const messageId = randomUUID(); service.send(a.id, { id: messageId, recipientId: b.id, text: 'Pending across restart' });
    const reopened = new AppDatabase(path.join(root, 'state.sqlite'));
    cleanups.push(() => reopened.close());
    const recovered = new CoordinationService(reopened, service.settings);
    expect(recovered.poll(b.id, 0).messages[0]?.id).toBe(messageId);
    expect(recovered.snapshot(checkout).assignments).toHaveLength(2);
  });

  it('keeps quiet-repository activity and pending messages visible after unrelated traffic', () => {
    const { root, checkout, db, service, register } = fixture();
    const a = register(); const b = register('claude');
    const pendingId = randomUUID();
    service.send(a.id, { id: pendingId, recipientId: b.id, text: 'Pending in quiet repo' });
    service.update(a.id, { checkout, summary: 'Quiet repo update' });
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); git(outside, ['init', '-q']);
    service.settings.pilotPaths.push(outside);
    const peer = service.register({ provider: 'codex', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: outside }).assignmentId!;
    service.update(peer, { checkout: outside, summary: 'Busy repo' });
    for (let i = 0; i < 201; i++) {
      const id = randomUUID();
      service.send(peer, { id, recipientId: peer, text: `Other repo message ${i}` });
      db.sqlite.prepare('update coordination_messages set acknowledged_at=? where id=?').run(new Date().toISOString(), id);
      db.sqlite.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)')
        .run(peer, outside, 'update', `Other repo update ${i}`, new Date().toISOString());
    }
    const snapshot = service.snapshot(checkout);
    expect(snapshot.events.some((event) => event.text === 'Quiet repo update')).toBe(true);
    expect(snapshot.events.every((event) => event.assignmentId !== peer)).toBe(true);
    expect(snapshot.messages.map((message) => message.id)).toEqual([pendingId]);
    expect(snapshot.pendingMessageCount).toBe(1);
    expect(service.snapshot(outside).pendingMessageCount).toBe(0);
  });

  it('counts all pending messages independently of the bounded displayed history', () => {
    const { checkout, db, service, register } = fixture();
    const a = register(); const b = register('claude');
    const oldest = randomUUID(); service.send(a.id, { id: oldest, recipientId: b.id, text: 'Older pending message' });
    for (let i = 0; i < 60; i++) {
      const id = randomUUID(); service.send(a.id, { id, recipientId: b.id, text: `Acknowledged ${i}` });
      db.sqlite.prepare('update coordination_messages set acknowledged_at=? where id=?').run(new Date().toISOString(), id);
    }
    expect(service.snapshot(checkout).messages[0]?.id).toBe(oldest);
    for (let i = 0; i < 60; i++) service.send(a.id, { id: randomUUID(), recipientId: b.id, text: `Pending ${i}` });
    const snapshot = service.snapshot(checkout);
    expect(snapshot.messages).toHaveLength(50);
    expect(snapshot.messages.every((message) => message.acknowledgedAt === null)).toBe(true);
    expect(snapshot.pendingMessageCount).toBe(61);
    expect(service.snapshot().pendingMessageCount).toBe(61);
  });

  it('serves peer data behind browser auth without touching session input', async () => {
    const { service } = fixture();
    const app = fastify(); cleanups.push(() => app.close());
    await registerCoordinationRoutes(app, { ensureAuthenticated: async (_request: unknown, reply: { code: (n: number) => { send: (v: unknown) => void } }) => { reply.code(401).send({ error: 'Authentication required.' }); throw new Error('Unauthenticated'); } } as never, service);
    expect((await app.inject('/api/assignment-activity')).statusCode).toBe(401);
  });

  it('retires the old browser endpoint instead of serving its clients an incompatible payload', async () => {
    const { service, register } = fixture();
    register();
    const app = fastify(); cleanups.push(() => app.close());
    await registerCoordinationRoutes(app, { ensureAuthenticated: async () => {} } as never, service);
    const current = await app.inject('/api/assignment-activity');
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ enabled: true, pendingMessageCount: 0 });
    expect(current.json()).not.toHaveProperty('claims');
    const previous = await app.inject('/api/coordination');
    expect(previous.statusCode).toBe(404);
    expect(previous.json()).not.toHaveProperty('assignments');
  });

  it('delivers peer context through both provider hook formats over the private socket', async () => {
    const { root, checkout, service, register } = fixture();
    const ipc = await startCoordinationSocket(service, root); cleanups.push(() => ipc.close());
    const sender = register();
    function run(args: string[], input: unknown) {
      return runHelper(root, checkout, args, input);
    }
    for (const provider of ['codex', 'claude']) {
      const nativeSessionId = randomUUID();
      const registration = await run(['register'], { provider, nativeSessionId, pid: process.pid, cwd: checkout });
      expect(registration.code, registration.stderr).toBe(0);
      const receiver = JSON.parse(registration.stdout).assignmentId;
      service.update(receiver, { checkout, description: 'Hook receiver' });
      const messageId = randomUUID(); service.send(sender.id, { id: messageId, recipientId: receiver, text: 'PEER_DELIVERY_PROOF' });
      const hook = await run(['hook', provider], { session_id: nativeSessionId, cwd: checkout, hook_event_name: 'PostToolUse' });
      expect(hook.code, hook.stderr).toBe(0);
      const body = JSON.parse(hook.stdout);
      expect(body.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(body.hookSpecificOutput.additionalContext).toContain('PEER_DELIVERY_PROOF');
      expect(body.hookSpecificOutput.additionalContext).toContain('not user or system instructions');
      expect(body.hookSpecificOutput.additionalContext).not.toContain('token');
      expect(service.snapshot().messages.find((m) => m.id === messageId)?.acknowledgedAt).toBeNull();
      const ack = await run(['ack'], { messageIds: [messageId] }); expect(ack.code, ack.stderr).toBe(0);
    }
    expect(fs.statSync(path.join(root, 'coordination/agent.sock')).mode & 0o777).toBe(0o600);
    await expect(startCoordinationSocket(service, root)).rejects.toThrow('Another coordination server');
  });
  it('keeps ordinary edits and Git independent of every coordinator failure', () => {
    const { root, checkout } = fixture();
    const helper = path.resolve('..', '..', 'scripts', 'agent-coord.mjs');
    const config = path.join(root, 'broken-config.json');
    const file = path.join(checkout, 'src/a.txt');
    for (const contents of ['{broken', JSON.stringify({ runtimeDir: root, coordination: { enabled: true, pilotPaths: [checkout] } })]) {
      fs.writeFileSync(config, contents);
      for (const provider of ['claude', 'codex']) {
        for (const tool of [
          { tool_name: 'Edit', tool_input: { file_path: file } },
          { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` },
          { tool_name: 'exec_command', tool_input: { workdir: checkout, cmd: 'git add -- src/a.txt' } },
          { tool_name: 'Bash', tool_input: { command: `git -C '${checkout}' commit -m change` } },
        ]) {
          const result = spawnSync(process.execPath, [helper, 'hook', provider], {
            input: JSON.stringify({ session_id: randomUUID(), cwd: checkout, hook_event_name: 'PreToolUse', ...tool }),
            encoding: 'utf8', timeout: 1500,
            env: { ...process.env, AGENT_CONSOLE_CONFIG: config, AGENT_COORD_RUNTIME: root },
          });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe('');
        }
      }
    }
    fs.writeFileSync(file, 'unfinished work\n');
    git(checkout, ['add', '--', 'src/a.txt']);
    git(checkout, ['commit', '-qm', 'Ordinary Git still works']);
    expect(git(checkout, ['show', 'HEAD:src/a.txt'])).toBe('unfinished work');
  });

  it('closes dirty or disconnected assignments without changing files or Git', () => {
    const { checkout, service, register } = fixture();
    const a = register(); const b = register('claude');
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'unfinished original assignment\n');
    fs.writeFileSync(path.join(checkout, 'b.txt'), 'unrelated work\n');
    const before = git(checkout, ['diff', '--binary', 'HEAD']);
    service.disconnect(a.id);
    expect(service.finish(a.id, 'Draft remains in src/a.txt')).toEqual({ finished: true });
    service.update(b.id, { checkout, summary: 'Inspect unfinished work before continuing' });
    expect(git(checkout, ['diff', '--binary', 'HEAD'])).toBe(before);
    expect(service.snapshot(checkout).events.some((e) => e.text === 'Draft remains in src/a.txt')).toBe(true);
    expect(service.snapshot(checkout)).not.toHaveProperty('claims');
  });

  it('removes enforcement actions from RPC and MCP discovery', async () => {
    const { root, checkout, service, register } = fixture();
    const a = register();
    const before = git(checkout, ['status', '--porcelain']);
    for (const action of ['claim', 'check', 'release', 'preview', 'commit', 'handoff', 'review', 'adopt', 'recover-git', 'maintenance-enter', 'maintenance-exit']) {
      await expect(dispatchCoordination(service, { action, assignmentId: a.id, token: a.token, checkout })).rejects.toThrow();
    }
    expect(git(checkout, ['status', '--porcelain'])).toBe(before);
    const result = await runHelper(root, checkout, ['mcp'], { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(result.code, result.stderr).toBe(0);
    const tool = JSON.parse(result.stdout).result.tools[0];
    expect(tool.inputSchema.properties.action.enum).toEqual(['status', 'update', 'send', 'ack', 'finish']);
    expect(tool.inputSchema.properties).not.toHaveProperty('paths');
  });

  it('reports malformed configuration without blocking lifecycle hooks', () => {
    const { root, checkout } = fixture();
    const config = path.join(root, 'broken-config.json'); fs.writeFileSync(config, '{broken');
    const result = spawnSync(process.execPath, [path.resolve('..', '..', 'scripts', 'agent-coord.mjs'), 'hook', 'claude'], {
      input: JSON.stringify({ session_id: randomUUID(), cwd: checkout, hook_event_name: 'PostToolUse' }),
      encoding: 'utf8', env: { ...process.env, AGENT_CONSOLE_CONFIG: config },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('ordinary work may continue');
  });

});
