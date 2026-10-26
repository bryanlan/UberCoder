import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hostIdFor } from '../src/providers/transport/claude/claude-instance.js';
import { processStartTicks } from '../src/providers/transport/codex/process-lifetime.js';
import { createLineTransportFactory, hostPaths, readHostRecord, terminateHost } from '../src/providers/transport/line-transport.js';
import type { FakeTransportPluginOptions } from './helpers/structured-fixtures.js';
import { settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// A per-session provider process runs behind a session host that outlives the backend. When its conversation is released,
// put to sleep or gone while nothing has adopted the process (a restart, a failed adoption), the host must still be ended: it
// would otherwise run for ever, holding the conversation's memory and its launch record. These tests run the real session host
// against a scripted child; the plugin is the fake one, because only the host-side bookkeeping is under test.

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_PROGRAM = path.join(here, '../src/providers/transport/session-host.ts');
const FAKE_CHILD = path.join(here, 'helpers/fake-host-child.mjs');

const PER_SESSION: FakeTransportPluginOptions = {
  id: 'claude',
  capabilities: { processModel: 'per-session', nativeIds: 'client-allocated', images: true },
};

const open: StructuredSessionFixture[] = [];
const hosts: Array<{ root: string; hostId: string }> = [];
const log = { info: () => undefined, warn: () => undefined };
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture({ plugin: PER_SESSION, ...options });
  open.push(f);
  return f;
}
afterEach(async () => {
  for (const { root, hostId } of hosts.splice(0)) await terminateHost(root, hostId, log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 }).catch(() => undefined);
  for (const f of open.splice(0)) await f.cleanup();
});

const running = (pid: number | undefined) => pid !== undefined && processStartTicks(pid) !== undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitUntil(probe: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(20);
  }
}

/** A provider process behind a real session host for this conversation, with no backend connected to it, as after a restart. */
async function survivingHost(f: StructuredSessionFixture, sessionId: string) {
  const hostId = hostIdFor(sessionId);
  hosts.push({ root: f.root, hostId });
  const factory = createLineTransportFactory({ runtimeDir: f.root, log, hostProgramPath: HOST_PROGRAM });
  const transport = await factory({
    argv: [process.execPath, FAKE_CHILD, path.join(f.root, `${hostId}.log`)], cwd: f.root, env: { PATH: process.env.PATH ?? '' }, hostId,
  });
  await transport.close(); // the backend goes away; the host and its child stay
  const record = readHostRecord(hostPaths(f.root, hostId).record)!;
  // The plugin keeps a record of the command line it launched with; it is gone only when the conversation is ended.
  f.db.meta.set(`claude-launch:${sessionId}`, JSON.stringify({ sessionId: 'native', argv: ['claude'], startedAt: new Date().toISOString() }));
  expect(running(record.host.pid) && running(record.child.pid)).toBe(true);
  return { hostId, hostPid: record.host.pid, childPid: record.child.pid, paths: hostPaths(f.root, hostId) };
}

async function endedHost(survivor: Awaited<ReturnType<typeof survivingHost>>): Promise<void> {
  await waitUntil(() => !running(survivor.hostPid) && !running(survivor.childPid), 'the host and its child to end');
  expect(fs.existsSync(survivor.paths.record)).toBe(false);
  expect(fs.existsSync(survivor.paths.socket)).toBe(false);
}

describe('A provider process that nothing has adopted', () => {
  it('is ended by a release of its conversation, with its launch record', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const survivor = await survivingHost(f, session.id);
    const backend = await f.restartBackend(); // nothing adopts the survivor: the plugin finds none
    await backend.manager.releaseSession(session.id);

    await endedHost(survivor);
    expect(f.db.meta.get(`claude-launch:${session.id}`)).toBeUndefined();
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
  });

  it('is ended when the conversation is put to sleep without having been loaded', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const survivor = await survivingHost(f, session.id);
    const backend = await f.restartBackend();
    await backend.manager.suspendSession(session.id);
    await settle();

    await endedHost(survivor);
    expect(f.db.meta.get(`claude-launch:${session.id}`)).toBeUndefined();
    expect(f.row(session.id).manualSuspendedAt).toBeTruthy();
    // The conversation itself is untouched: it resumes by native id on its next use.
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });

  it('is ended by idle sleep of a conversation that was never loaded, not just marked asleep', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const survivor = await survivingHost(f, session.id);
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    f.db.sqlite.prepare('update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?')
      .run(at, at, at, at, at, at, session.id);
    const backend = await f.restartBackend(); // nothing adopts the survivor
    await backend.manager.reconcileSessions();
    await settle();

    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
    await endedHost(survivor);
    expect(f.db.meta.get(`claude-launch:${session.id}`)).toBeUndefined();
  });

  it('is left alone by the release of another conversation', async () => {
    const f = fixture();
    const kept = await f.bindNew();
    const released = await f.bindNew();
    const survivorKept = await survivingHost(f, kept.session.id);
    const survivorReleased = await survivingHost(f, released.session.id);
    const backend = await f.restartBackend();
    await backend.manager.releaseSession(released.session.id);

    await endedHost(survivorReleased);
    expect(running(survivorKept.hostPid) && running(survivorKept.childPid)).toBe(true);
    expect(f.db.meta.get(`claude-launch:${kept.session.id}`)).toBeTruthy();
  });

  it('does nothing for a conversation of a provider with one shared process', async () => {
    const f = fixture({ plugin: undefined }); // the Codex-like shared fake
    const { session } = await f.bindNew();
    // A host that happens to carry this conversation's id under a per-session provider's name is not this conversation's.
    const survivor = await survivingHost(f, session.id);
    const backend = await f.restartBackend();
    await backend.manager.releaseSession(session.id);
    expect(running(survivor.hostPid) && running(survivor.childPid)).toBe(true);
  });
});

describe('The startup sweep of session hosts', () => {
  it('ends the host of a conversation with no restorable row, and leaves those that have one', async () => {
    const f = fixture();
    const owned = await f.bindNew();
    const released = await f.bindNew();
    const stranger = 'a-conversation-that-was-never-committed';
    const ownedHost = await survivingHost(f, owned.session.id);
    const releasedHost = await survivingHost(f, released.session.id);
    const strangerHost = await survivingHost(f, stranger);
    // The row of `released` ended while its host was left behind (a crash between the release and the host's end).
    f.db.sqlite.prepare("update bound_sessions set status='ended', should_restore=0 where id=?").run(released.session.id);

    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    await settle();

    await endedHost(releasedHost);
    await endedHost(strangerHost);
    expect(f.db.meta.get(`claude-launch:${released.session.id}`)).toBeUndefined();
    expect(f.db.meta.get(`claude-launch:${stranger}`)).toBeUndefined();
    // The owned conversation's host is still there for the adoption pass (this fake plugin finds no survivor, so it just waits).
    expect(running(ownedHost.hostPid) && running(ownedHost.childPid)).toBe(true);
    expect(f.db.meta.get(`claude-launch:${owned.session.id}`)).toBeTruthy();
    expect(f.row(owned.session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });

  it('runs once, at the first pass, and never ends the shared Codex host', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const codex = await (async () => {
      // A host named like the shared app-server's.
      hosts.push({ root: f.root, hostId: 'codex' });
      const factory = createLineTransportFactory({ runtimeDir: f.root, log, hostProgramPath: HOST_PROGRAM });
      const transport = await factory({ argv: [process.execPath, FAKE_CHILD, path.join(f.root, 'codex.log')], cwd: f.root, env: { PATH: process.env.PATH ?? '' }, hostId: 'codex' });
      await transport.close();
      return readHostRecord(hostPaths(f.root, 'codex').record)!;
    })();
    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    await settle();
    expect(running(codex.host.pid) && running(codex.child.pid)).toBe(true);

    // A host that shows up later is not the first pass's business.
    const late = await survivingHost(f, 'late-stranger');
    await backend.manager.reconcileSessions();
    await settle();
    expect(running(late.hostPid) && running(late.childPid)).toBe(true);
    void session;
  });
});
