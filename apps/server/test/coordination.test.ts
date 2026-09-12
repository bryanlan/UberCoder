import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService, processStart } from '../src/coordination/service.js';
import { checkoutIdentity, claimPath, git } from '../src/coordination/git.js';
import { dispatchCoordination, registerCoordinationRoutes, startCoordinationSocket } from '../src/coordination/transport.js';

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
    expect(service.claim(result.assignmentId!, checkout, ['src/a.txt']).acquired).toBe(true);
  });

  it('repairs a lost credential only for the original live process, preserving claims', () => {
    const { checkout, service, db, register } = fixture();
    const a = register(); service.claim(a.id, checkout, ['src/a.txt']);
    const token = randomUUID();
    expect(service.register({ provider: 'codex', nativeSessionId: a.nativeSessionId, token, pid: process.pid, cwd: checkout }).assignmentId).toBe(a.id);
    expect(() => service.authenticate(a.id, a.token)).toThrow('credential');
    service.authenticate(a.id, token);
    expect(service.check(a.id, checkout, ['src/a.txt']).allowed).toBe(true);
    db.sqlite.prepare('update coordination_assignments set process_start=? where id=?').run('different-start', a.id);
    expect(() => service.register({ provider: 'codex', nativeSessionId: a.nativeSessionId, token: randomUUID(), pid: process.pid, cwd: checkout })).toThrow('original live provider process');
    service.authenticate(a.id, token);
  });

  it('reviews untracked symlinks as links without disclosing their target contents', () => {
    const { root, checkout, service } = fixture();
    const target = path.join(root, 'outside.txt'); fs.writeFileSync(target, 'MUST_NOT_BE_DISCLOSED');
    fs.symlinkSync(target, path.join(checkout, 'outside-link'));
    const review = service.review(checkout, ['.']);
    expect(review.untracked.find((file) => file.path === 'outside-link')).toMatchObject({ content: null, symlinkTarget: target });
    expect(JSON.stringify(review)).not.toContain('MUST_NOT_BE_DISCLOSED');
  });

  it('delivers oversized historical events in bounded form and advances to subsequent updates', async () => {
    const { checkout, db, service, register } = fixture();
    const a = register(); const b = register('claude');
    const cursor = service.poll(b.id, 0).cursor;
    const paths = Array.from({ length: 85 }, (_, i) => `${i}-${'x'.repeat(100)}.txt`);
    await dispatchCoordination(service, { action: 'claim', assignmentId: a.id, token: a.token, checkout, paths });
    service.update(a.id, { checkout, summary: 'Later update must arrive' });
    const result = service.poll(b.id, cursor);
    expect(result.cursor).toBeGreaterThan(cursor);
    expect(result.events.some((event) => event.text.includes('abbreviated'))).toBe(true);
    expect(result.events.some((event) => event.text === 'Later update must arrive')).toBe(true);
    expect(JSON.stringify({ events: result.events, messages: result.messages }).length).toBeLessThan(8000);
    expect((db.sqlite.prepare("select length(text) as n from coordination_events where kind='claimed'").get() as { n: number }).n).toBeGreaterThan(8000);
  });
  it('atomically rejects overlapping claims through two database connections; disjoint work proceeds', () => {
    const { root, checkout, db, service, register } = fixture();
    const a = register(); const b = register('claude');
    const secondDb = new AppDatabase(path.join(root, 'state.sqlite'));
    cleanups.push(() => secondDb.close());
    const second = new CoordinationService(secondDb, service.settings);
    expect(service.claim(a.id, checkout, ['src'])).toEqual({ acquired: true, conflicts: [] });
    expect(second.claim(b.id, checkout, ['src/a.txt']).acquired).toBe(false);
    expect(second.claim(b.id, checkout, ['b.txt']).acquired).toBe(true);
    expect(db.sqlite.prepare('select count(*) as n from coordination_claims').get()).toEqual({ n: 2 });
    expect(() => service.claim(a.id, checkout, ['../escape'])).toThrow('inside');
    expect(claimPath(checkout, 'new/nested/file')).toBe('new/nested/file');
  });

  it('keeps read-only, MCP and nonpilot edits usable with no server, but protects pilot edits', async () => {
    const { root, checkout } = fixture();
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); git(outside, ['init', '-q']);
    for (const provider of ['codex', 'claude']) {
      const base = { session_id: randomUUID(), cwd: checkout, hook_event_name: 'PreToolUse' };
      for (const input of [
        { ...base, tool_name: 'Bash', tool_input: { command: 'pwd' } },
        { ...base, tool_name: 'mcp__agent_console_coordination__agent_coordination', tool_input: { action: 'status' } },
        { ...base, tool_name: 'Edit', tool_input: { file_path: path.join(outside, 'a.txt') } },
        { ...base, tool_name: 'Write', tool_input: { file_path: path.join(root, 'scratch.txt') } },
        { ...base, tool_name: 'Bash', tool_input: { command: `git -C '${outside}' add a.txt` } },
      ]) {
        const result = await runHelper(root, checkout, ['hook', provider], input);
        expect(result.code, result.stderr).toBe(0);
      }
      const blocked = await runHelper(root, checkout, ['hook', provider], { ...base, cwd: outside, tool_name: 'Edit', tool_input: { file_path: path.join(checkout, 'src/a.txt') } });
      expect(blocked.code).toBe(2);
      const rawGit = await runHelper(root, checkout, ['hook', provider], { ...base, tool_name: 'Bash', tool_input: { command: 'git add src/a.txt' } });
      expect(rawGit.code).toBe(2);
    }
  });

  it('checks cross-repo and freeform patch targets after an outside-pilot registration', async () => {
    const { root, checkout, service } = fixture();
    const ipc = await startCoordinationSocket(service, root); cleanups.push(() => ipc.close());
    const session_id = randomUUID();
    const registration = await runHelper(root, checkout, ['register'], { provider: 'codex', nativeSessionId: session_id, pid: process.pid, cwd: root });
    const assignmentId = JSON.parse(registration.stdout).assignmentId;
    service.update(assignmentId, { checkout, summary: 'Target checkout' });
    const input = { session_id, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: ${checkout}/src/a.txt\n@@\n-old\n+new\n*** End Patch` };
    expect((await runHelper(root, checkout, ['hook', 'codex'], input)).code).toBe(2);
    service.claim(assignmentId, checkout, ['src/a.txt']);
    const allowed = await runHelper(root, checkout, ['hook', 'codex'], input);
    expect(allowed.code, allowed.stderr).toBe(0);
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
    service.claim(saved.assignmentId, checkout, ['src/a.txt']);
    fs.unlinkSync(statePath);
    const repaired = await runHelper(root, checkout, ['register'], input);
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout).assignmentId).toBe(saved.assignmentId);
    expect(service.check(saved.assignmentId, checkout, ['src/a.txt']).allowed).toBe(true);
    expect((db.sqlite.prepare('select count(*) as n from coordination_assignments').get() as { n: number }).n).toBe(1);
  });

  it('recognizes worktrees as one repository but separate editing locations', () => {
    const { root, checkout, service, register } = fixture();
    const linked = path.join(root, 'linked');
    git(checkout, ['worktree', 'add', '--detach', linked]);
    const a = register(); const b = register('claude');
    service.update(b.id, { checkout: linked, summary: 'Detached worktree' });
    expect(checkoutIdentity(linked).repository).toBe(checkoutIdentity(checkout).repository);
    expect(service.claim(a.id, checkout, ['src/a.txt']).acquired).toBe(true);
    expect(service.claim(b.id, linked, ['src/a.txt']).acquired).toBe(true);
    expect(service.snapshot(checkout).assignments).toHaveLength(2);
    expect(service.poll(a.id, 0).events.some((e) => e.checkout === linked)).toBe(true);
  });

  it('refuses unowned dirty files and symlink aliases, and retains unfinished claims on close', () => {
    const { checkout, service, register } = fixture();
    const a = register(); const b = register('claude');
    fs.writeFileSync(path.join(checkout, 'b.txt'), 'someone else\n');
    expect(() => service.claim(a.id, checkout, ['b.txt'])).toThrow('Unowned changes');
    fs.symlinkSync('src/a.txt', path.join(checkout, 'alias'));
    expect(() => service.claim(a.id, checkout, ['alias'])).toThrow('Symlink');
    service.claim(a.id, checkout, ['src/a.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'unfinished\n');
    expect(() => service.release(a.id, checkout, ['src/a.txt'])).toThrow('unfinished');
    service.disconnect(a.id);
    expect(service.claim(b.id, checkout, ['src/a.txt']).acquired).toBe(false);
    expect(service.finish(a.id, 'Left a reviewed draft').retainedClaims).toHaveLength(1);
    expect(service.snapshot(checkout).assignments.some((item) => item.id === a.id)).toBe(true);
    expect(fs.readFileSync(path.join(checkout, 'b.txt'), 'utf8')).toBe('someone else\n');
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

  it('commits only claimed reviewed paths, including new files, preserving unrelated dirty work', async () => {
    const { checkout, service, register } = fixture();
    const a = register();
    service.claim(a.id, checkout, ['src/a.txt', 'new.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'owned change\n');
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'owned new file\n');
    fs.writeFileSync(path.join(checkout, 'b.txt'), 'unrelated change\n');
    const preview = service.preview(a.id, checkout, ['src/a.txt', 'new.txt']);
    const result = await service.commit(a.id, checkout, preview.paths, preview.fingerprint, 'Owned changes');
    expect(git(checkout, ['show', `${result.commit}:new.txt`])).toBe('owned new file');
    expect(git(checkout, ['show', `${result.commit}:b.txt`])).toBe('original b');
    expect(fs.readFileSync(path.join(checkout, 'b.txt'), 'utf8')).toBe('unrelated change\n');
    expect(git(checkout, ['diff', '--cached', '--name-only'])).toBe('');
    expect(service.finish(a.id, 'Committed').retainedClaims).toHaveLength(0);
  });

  it('rejects changed previews and a shared index containing staged work', async () => {
    const { checkout, service, register } = fixture();
    const a = register();
    service.claim(a.id, checkout, ['src/a.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'first\n');
    const preview = service.preview(a.id, checkout, ['src/a.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'changed since preview\n');
    await expect(service.commit(a.id, checkout, preview.paths, preview.fingerprint, 'stale')).rejects.toThrow('fingerprint');
    fs.writeFileSync(path.join(checkout, 'b.txt'), 'staged unrelated\n');
    git(checkout, ['add', 'b.txt']);
    const latest = service.preview(a.id, checkout, ['src/a.txt']);
    await expect(service.commit(a.id, checkout, latest.paths, latest.fingerprint, 'blocked')).rejects.toThrow('shared index');
    expect(git(checkout, ['diff', '--cached', '--name-only'])).toBe('b.txt');
  });

  it('detects a Git hook changing reviewed contents and retains a recoverable operation', async () => {
    const { root, checkout, service, register } = fixture();
    const linked = path.join(root, 'linked'); git(checkout, ['worktree', 'add', '--detach', linked]);
    const a = register(); service.claim(a.id, checkout, ['src/a.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'reviewed content\n');
    const hook = path.join(checkout, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "hook changed content\\n" > src/a.txt\ngit add -- src/a.txt\n', { mode: 0o700 });
    const preview = service.preview(a.id, checkout, ['src/a.txt']);
    await expect(service.commit(a.id, checkout, preview.paths, preview.fingerprint, 'reviewed')).rejects.toThrow('Committed tree differs');
    expect(() => service.finish(a.id, 'not verified')).toThrow('Git operation');
    const unrelated = service.review(linked, ['.']);
    expect(() => service.recoverGit(a.id, linked, unrelated.fingerprint, 'Reviewed another checkout')).toThrow("operation's checkout");
    const lock = path.join(checkout, '.git/index.lock'); fs.writeFileSync(lock, 'fixture');
    const current = service.review(checkout, ['.']);
    expect(() => service.recoverGit(a.id, checkout, current.fingerprint, 'Unresolved index lock')).toThrow('index lock');
    fs.unlinkSync(lock);
    expect(service.recoverGit(a.id, checkout, current.fingerprint, 'Reviewed the hook-produced commit and retained its content.')).toEqual({ recovered: true });
    expect(service.snapshot(checkout).claims).toHaveLength(1);
    expect(git(checkout, ['show', 'HEAD:src/a.txt'])).toBe('hook changed content');
  });

  it('keeps scoped history and pending messages across database restart', () => {
    const { root, checkout, service, register } = fixture();
    const a = register(); const b = register('claude');
    service.claim(a.id, checkout, ['src/a.txt']);
    const messageId = randomUUID(); service.send(a.id, { id: messageId, recipientId: b.id, text: 'Pending across restart' });
    const reopened = new AppDatabase(path.join(root, 'state.sqlite'));
    cleanups.push(() => reopened.close());
    const recovered = new CoordinationService(reopened, service.settings);
    expect(recovered.poll(b.id, 0).messages[0]?.id).toBe(messageId);
    expect(recovered.claim(b.id, checkout, ['src/a.txt']).acquired).toBe(false);
  });

  it('requires a reviewed reconciliation and never steals from a live owner', () => {
    const { checkout, service, register } = fixture();
    const a = register(); const b = register('claude');
    service.claim(a.id, checkout, ['src/a.txt']);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'unfinished owned change\n');
    const review = service.review(checkout, ['src/a.txt']);
    expect(() => service.adopt(b.id, checkout, review.paths, review.fingerprint, 'Reconcile')).toThrow('live owner');
    service.disconnect(a.id);
    fs.writeFileSync(path.join(checkout, 'src/a.txt'), 'changed again\n');
    expect(() => service.adopt(b.id, checkout, review.paths, review.fingerprint, 'Reconcile')).toThrow('fingerprint');
    const current = service.review(checkout, ['src/a.txt']);
    expect(service.adopt(b.id, checkout, current.paths, current.fingerprint, 'Bryan assigned recovery of this unfinished change.')).toEqual({ adopted: true });
    expect(service.check(b.id, checkout, ['src/a.txt'])).toEqual({ allowed: true });
    expect(() => service.check(a.id, checkout, ['src/a.txt'])).toThrow('claim');
  });

  it('serializes maintenance against cross-repo assignments even without editing claims', () => {
    const { checkout, service, register } = fixture();
    const a = register(); const maintenance = register('maintenance');
    expect(() => service.maintenanceEnter(maintenance.id, checkout)).toThrow('active assignments');
    service.finish(a.id, 'Done');
    expect(service.maintenanceEnter(maintenance.id, checkout)).toEqual({ acquired: true });
    const newcomer = register('claude');
    expect(() => service.claim(newcomer.id, checkout, ['b.txt'])).toThrow('Git operation');
    expect(() => service.finish(maintenance.id, 'premature')).toThrow('Git operation');
    expect(service.maintenanceExit(maintenance.id, checkout)).toEqual({ released: true });
    expect(service.claim(newcomer.id, checkout, ['b.txt']).acquired).toBe(true);
  });

  it('serves peer data behind browser auth without touching session input', async () => {
    const { service } = fixture();
    const app = fastify(); cleanups.push(() => app.close());
    await registerCoordinationRoutes(app, { ensureAuthenticated: async (_request: unknown, reply: { code: (n: number) => { send: (v: unknown) => void } }) => { reply.code(401).send({ error: 'Authentication required.' }); throw new Error('Unauthenticated'); } } as never, service);
    expect((await app.inject('/api/coordination')).statusCode).toBe(401);
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
});
