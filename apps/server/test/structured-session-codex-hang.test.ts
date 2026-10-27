import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { createCodexAppServerPlugin, type CodexStructuredConfig } from '../src/providers/transport/codex/index.js';
import { APP_SERVER_UNRESPONSIVE_LIMIT_MS } from '../src/providers/transport/codex/app-server-instance.js';
import { terminateHost } from '../src/providers/transport/line-transport.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import { LineTransportNotRunningError, type LineTransportFactory, type ProviderFailure, type TransportInstance } from '../src/providers/transport/types.js';
import { StructuredSessionService } from '../src/sessions/structured/structured-session-service.js';
import {
  OPEN_OPTIONS, baseHandlers, hostTransportFactory, makeContext, readLog, receivedRequests, setupFake, threadResult, waitUntil,
  type FakeSetup, type TestContext,
} from './helpers/codex-harness.js';

vi.setConfig({ testTimeout: 30_000 });

// A hung shared Codex app-server must end up replaced, whichever way the Console meets the hang. The real service and the real
// Codex plugin run against a scripted app-server behind the real session host. The service drops an instance that never connected
// after every failed open and builds a new one for the next, which is why these go through the service and not one instance.

const THREAD = 'thread-0';
const CWD = '/work/project';
const TIMINGS = { requestTimeoutMs: 400, initializeTimeoutMs: 300, interruptGraceMs: 300, queuedStartWaitMs: 1_000, closeGraceMs: 300, termGraceMs: 300 };
const account = { result: { account: null, requiresOpenaiAuth: false } };
const silent = { noResponse: true };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track(setup: FakeSetup): FakeSetup {
  cleanups.push(async () => {
    await setup.instance.dispose('shutdown').catch(() => undefined);
    await setup.stopHost().catch(() => undefined);
    fs.rmSync(setup.dir, { recursive: true, force: true });
  });
  return setup;
}

/** A row for conversation `n`; each has its own thread, so one answer to `thread/resume` cannot be mistaken for another's. */
const row = (n: number) => ({ id: `row-${n}`, provider: 'codex', conversationRef: `thread-${n}`, projectSlug: 'p' }) as unknown as BoundSession;
const resumed = (n: number) => ({ result: { ...threadResult(`thread-${n}`), turnsBackwardsCursor: null, itemsBackwardsCursor: null } });

const processStarts = (fake: FakeSetup) => readLog(fake.logFile).filter((entry) => entry.event === 'start');
/** The signs that the app-server was told to end: its input closed or a signal. */
const endedProcesses = (fake: FakeSetup) => readLog(fake.logFile).filter((entry) => entry.event === 'stdin-eof' || entry.event === 'sigterm');
const warnings = (context: TestContext) => context.logs.warn.map(([, message]) => message);

/**
 * A Console backend over the fake's host and database, with the injected clock the plugin reads for the limit. `created` lists every
 * instance the service asked the plugin for, so a test can see that a failed open dropped one.
 */
function backend(
  fake: FakeSetup,
  clock: { now: number },
  { wrap = (factory) => factory, endHost = true }: { wrap?: (factory: LineTransportFactory) => LineTransportFactory; endHost?: boolean } = {},
) {
  const context = makeContext(fake.context.runtimeDir);
  for (const [key, value] of fake.context.metaStore) context.metaStore.set(key, value); // the database an earlier backend wrote
  context.lineTransport = wrap(hostTransportFactory(fake.hostRuntimeDir, context));
  // The manager gives plugins the same call the service uses to end a host.
  if (endHost) context.endHost = (hostId, graces) => terminateHost(fake.hostRuntimeDir, hostId, context.log, graces);
  const plugin = createCodexAppServerPlugin({ timings: TIMINGS, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9', now: () => clock.now });
  const created: TransportInstance[] = [];
  const registry = new TransportPluginRegistry();
  registry.register({ id: plugin.id, create: (config, pluginContext) => { const instance = plugin.create(config as CodexStructuredConfig, pluginContext); created.push(instance); return instance; } });
  const states: Array<{ sessionId: string; state: string; failure?: ProviderFailure }> = [];
  const service = new StructuredSessionService({
    registry,
    config: { codex: { enabled: true, command: fake.command, idleUnloadMinutes: 60, env: {} } },
    createContext: () => context,
    meta: context.meta,
    callbacks: {
      onTurnStarted() {}, onItemCompleted() {}, onTurnTerminal() {}, onRequest() {}, onQuestion() {},
      onRequestsChanged() {}, appendStatus() {},
      onSessionState: (sessionId, state, failure) => { states.push({ sessionId, state, ...(failure ? { failure } : {}) }); },
    },
  });
  cleanups.push(async () => { await service.shutdown(); });
  return { service, created, context, states };
}

describe('A hung Codex app-server, met through the service', () => {
  describe('on a start that checks a running app-server', () => {
    /** An app-server an earlier backend used and that then stops answering `account/read`, the check of every later start. */
    async function silentApp() {
      const fake = track(setupFake({ handlers: { ...baseHandlers(THREAD), 'account/read': silent } }, undefined, {}, { host: true }));
      await fake.instance.start(OPEN_OPTIONS);
      await fake.instance.dispose('shutdown');
      return fake;
    }

    it('is replaced once the silence has lasted the limit, though every failed open drops the instance and the next open builds a new one', async () => {
      const fake = await silentApp();
      const clock = { now: 1_000_000 };
      const { service, created, context } = backend(fake, clock);

      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(service.unavailableReason('row-0')).toContain('did not answer in time');
      expect(created).toHaveLength(1);
      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS / 2;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(created).toHaveLength(2); // the service dropped the first instance; the run of timeouts went on in the second
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);

      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS / 2; // the silence is now as old as the limit
      expect(await service.ensureLoaded(row(0), CWD)).toBe('loaded');
      expect(created).toHaveLength(3);
      expect(service.alive(row(0))).toBe(true);
      expect(processStarts(fake)).toHaveLength(2); // the silent process was ended and a new one started
      expect(endedProcesses(fake).length).toBeGreaterThan(0);
      expect(receivedRequests(fake.logFile, 'thread/resume')).toHaveLength(1); // on the new process only
      expect(warnings(context)).toEqual(expect.arrayContaining([expect.stringContaining('has not answered for longer than the limit')]));
      // One id sequence for the whole backend: no instance counted from 1 again.
      expect(receivedRequests(fake.logFile, 'account/read').map((frame) => frame.id)).toEqual([1, 2, 3]);
    });

    it('is left running while the silence is younger than the limit', async () => {
      const fake = await silentApp();
      const clock = { now: 1_000_000 };
      const { service, created } = backend(fake, clock);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
        clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS / 4 - 1;
      }
      expect(created).toHaveLength(3);
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);
    });
  });

  describe('on a start whose session host connects but gives no hello', () => {
    /** An app-server an earlier backend used; the session host reports no hello to every attach, as a stalled one does. */
    async function silentHost(reason: 'unreachable' | 'absent' = 'unreachable', endHost = true) {
      const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
      await fake.instance.start(OPEN_OPTIONS);
      await fake.instance.dispose('shutdown');
      const clock = { now: 1_000_000 };
      const opens: Array<'attach' | 'connect'> = [];
      const app = backend(fake, clock, {
        endHost,
        wrap: (factory) => async (spawn) => {
          opens.push(spawn.attachOnly ? 'attach' : 'connect');
          if (spawn.attachOnly) throw new LineTransportNotRunningError('The session host did not answer hello.', reason);
          return factory(spawn);
        },
      });
      return { fake, clock, opens, ...app };
    }

    it('is busy and left running while the silence is younger than the limit, then ended and replaced in the same open', async () => {
      const { fake, clock, opens, service, created, context } = await silentHost();
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(service.unavailableReason('row-0')).toContain('session host did not answer in time');
      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS / 2;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(created).toHaveLength(2);
      expect(opens).toEqual(['attach', 'attach']); // busy is reported before any plain connect
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);

      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS / 2;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('loaded');
      expect(opens).toEqual(['attach', 'attach', 'attach', 'connect']);
      expect(processStarts(fake)).toHaveLength(2); // the host and the app-server behind it were ended and made again
      expect(endedProcesses(fake).length).toBeGreaterThan(0);
      expect(receivedRequests(fake.logFile, 'thread/resume')).toHaveLength(1);
      expect(warnings(context)).toEqual(expect.arrayContaining([expect.stringContaining('session host has not answered for longer than the limit')]));
    });

    it('leaves the host alone and fails plainly past the limit when the host cannot be ended from the plugin', async () => {
      const { fake, clock, opens, service, created } = await silentHost('unreachable', false);
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(service.unavailableReason('row-0')).toContain('cannot be ended from here');
      expect(created).toHaveLength(2);
      expect(opens).toEqual(['attach', 'attach']); // no plain connect, no second app-server
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);
    });

    it('does not count an attach-only lookup toward the run or end anything for it', async () => {
      const { fake, clock, service } = await silentHost();
      await service.reattachSurvivors([{ session: row(0), cwd: CWD }]);
      expect(service.survivorBusy('row-0')).toBe(true);
      clock.now += 10 * APP_SERVER_UNRESPONSIVE_LIMIT_MS;
      await service.reattachSurvivors([{ session: row(0), cwd: CWD }]);
      expect(service.survivorBusy('row-0')).toBe(true);
      expect(endedProcesses(fake)).toEqual([]);
      // The first ordinary open begins the run: it is not already old.
      expect(await service.ensureLoaded(row(0), CWD)).toBe('unavailable');
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);
    });

    it('treats a refused connection as no process: the open goes on to connect as before, and no run begins', async () => {
      const { fake, clock, opens, service } = await silentHost('absent');
      clock.now += 10 * APP_SERVER_UNRESPONSIVE_LIMIT_MS;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('loaded');
      expect(opens).toEqual(['attach', 'connect']);
      expect(endedProcesses(fake)).toEqual([]);
      expect(processStarts(fake)).toHaveLength(1);
    });
  });

  describe('on a live connection', () => {
    /** An app-server behind a live connection. `resumes` are its answers to `thread/resume`, in the order the rows are opened; `silent` never answers. */
    async function liveApp(resumes: unknown[], accountRead: unknown = account) {
      const fake = track(setupFake({ handlers: { ...baseHandlers(THREAD), 'thread/resume': resumes, 'account/read': accountRead } }, undefined, {}, { host: true }));
      const clock = { now: 1_000_000 };
      const app = backend(fake, clock);
      expect(await app.service.ensureLoaded(row(0), CWD)).toBe('loaded'); // the connection every later request shares
      return { fake, clock, ...app };
    }
    const letGo = (context: TestContext) => warnings(context).filter((message) => /keep timing out on the live connection/.test(message));

    it('is let go of after three requests in a row time out, and the next open runs the check instead of using the hung connection', async () => {
      const { fake, service, context, states } = await liveApp([resumed(0), silent, silent, silent, resumed(4)]);
      for (const n of [1, 2]) expect(await service.ensureLoaded(row(n), CWD)).toBe('unavailable');
      expect(letGo(context)).toEqual([]);
      expect(service.alive(row(0))).toBe(true);

      expect(await service.ensureLoaded(row(3), CWD)).toBe('unavailable'); // the third in a row
      expect(letGo(context)).toHaveLength(1);
      await waitUntil(() => !service.alive(row(0)), 5_000, 'the first conversation to see the connection end');
      // The conversation on the connection is told, as for any lost connection; the process itself keeps running.
      expect(states.filter((entry) => entry.state === 'error')).toEqual([expect.objectContaining({ sessionId: 'row-0', failure: expect.objectContaining({ code: 'process_exited' }) })]);
      expect(receivedRequests(fake.logFile, 'account/read')).toEqual([]); // nothing has asked the process yet

      expect(await service.ensureLoaded(row(4), CWD)).toBe('loaded');
      expect(receivedRequests(fake.logFile, 'account/read')).toHaveLength(1); // the open went through the handshake check
      expect(processStarts(fake)).toHaveLength(1); // it answered, so it was kept
      expect(endedProcesses(fake)).toEqual([]);
    });

    it('does not count timeouts that an answer separates', async () => {
      const { service, context } = await liveApp([resumed(0), silent, silent, resumed(3), silent, silent, resumed(6)]);
      for (const n of [1, 2]) expect(await service.ensureLoaded(row(n), CWD)).toBe('unavailable');
      expect(await service.ensureLoaded(row(3), CWD)).toBe('loaded');
      for (const n of [4, 5]) expect(await service.ensureLoaded(row(n), CWD)).toBe('unavailable');
      expect(await service.ensureLoaded(row(6), CWD)).toBe('loaded');
      expect(letGo(context)).toEqual([]);
      for (const n of [0, 3, 6]) expect(service.alive(row(n))).toBe(true); // one connection throughout
    });

    it('replaces a process that stays silent for the limit counted from the first timeout on the live connection', async () => {
      const { fake, clock, service, context } = await liveApp([resumed(0), silent, silent, silent, resumed(4)], silent);
      for (const n of [1, 2, 3]) expect(await service.ensureLoaded(row(n), CWD)).toBe('unavailable');
      expect(letGo(context)).toHaveLength(1);
      await waitUntil(() => !service.alive(row(0)), 5_000, 'the first conversation to see the connection end');

      clock.now += APP_SERVER_UNRESPONSIVE_LIMIT_MS;
      expect(await service.ensureLoaded(row(0), CWD)).toBe('loaded'); // the check times out, the silence is as old as the limit
      expect(processStarts(fake)).toHaveLength(2);
      expect(endedProcesses(fake).length).toBeGreaterThan(0);
      expect(warnings(context)).toEqual(expect.arrayContaining([expect.stringContaining('has not answered for longer than the limit')]));
    });
  });
});
