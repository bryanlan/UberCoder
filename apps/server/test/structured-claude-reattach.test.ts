import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionHeldError } from '../src/providers/transport/claude/index.js';
import { ClaudeSession, DEFAULT_TIMINGS } from '../src/providers/transport/claude/claude-session.js';
import { hostIdFor } from '../src/providers/transport/claude/claude-instance.js';
import { StreamJsonClient } from '../src/providers/transport/claude/stream-json.js';
import { processStartTicks } from '../src/providers/transport/codex/process-lifetime.js';
import { terminateHost } from '../src/providers/transport/line-transport.js';
import { LineTransportNotRunningError, PreviousTurnActiveError, TransportUnavailableError, type LineTransport, type LineTransportFactory, type TransportEvent } from '../src/providers/transport/types.js';
import {
  assistantText,
  cleanupAll,
  EventLog,
  receivedControls,
  setupFake,
  sleep,
  startEntries,
  waitUntil,
  writeRegistryFile,
  type Scenario,
} from './helpers/claude-harness.js';

// A process that outlives a backend restart can be in the middle of a turn. These tests restart the "backend" (a new
// plugin instance over the same session host) while the fake CLI sits in a silent tool call, then check what the new
// session knows and does. Scenarios ported from the cutover review (round 1, findings 2, 3 and 4).
vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await cleanupAll();
});

/** A quiet tool call: the CLI shows no frame for `ms` and then answers. */
const quietTurn = (ms: number, text: string): Scenario => ({ steps: [{ sleep: ms }, assistantText(text)] });

/** Starts a conversation, sends a message, and restarts the backend while the turn still runs. */
async function restartMidTurn(scenario: Scenario, send = 'long build') {
  const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false, ...scenario }, { host: true });
  const first = setup.track(await setup.instance.start(setup.open()));
  const firstLog = new EventLog(first);
  const old = await first.sendTurn({ text: send });
  await firstLog.waitForType('turn.started');
  const pid = first.pid!;
  await setup.instance.dispose('shutdown');
  await firstLog.done;
  const { instance, context } = setup.restartBackend();
  return { setup, first, old, pid, instance, context };
}

/** The event log reads the session's stream asynchronously; let it catch up with what the test just pushed. */
const settle = (): Promise<void> => sleep(15);

const kinds = (log: EventLog, turnId?: string): string[] =>
  log.events
    .filter((event) => event.type === 'turn.started' || event.type === 'turn.terminal' || event.type === 'item.completed')
    .map((event) => {
      const e = event as Extract<TransportEvent, { turnId: string }>;
      const label = turnId === undefined ? '' : e.turnId === turnId ? ':NEW' : ':P';
      return `${event.type}${label}${'status' in event ? `:${event.status}` : ''}${'origin' in event ? `:${event.origin}` : ''}`;
    });

describe('a process found again in the middle of a turn', () => {
  it('knows the turn at once: the session names it, announces it as a provider turn, and the result ends it once', async () => {
    const { setup, instance, pid, first } = await restartMidTurn({ turns: [quietTurn(2500, 'old turn done')] });
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(second.pid).toBe(pid);
    // Known before reattach() resolved: the host can mark the conversation as working without waiting for a frame.
    expect(second.activeTurn).toBeTruthy();
    const log = new EventLog(second);
    const started = await log.waitForType('turn.started');
    expect(started).toMatchObject({ turnId: second.activeTurn, origin: 'provider', replay: false, adopted: true }); // already running: not new activity
    // A second turn cannot start under it; the host steers instead.
    await expect(second.sendTurn({ text: 'too soon' })).rejects.toBeInstanceOf(PreviousTurnActiveError);

    const terminal = await log.waitForTerminal(started.turnId, 10_000);
    expect(terminal).toMatchObject({ status: 'completed', sessionUsable: true });
    expect(log.of('turn.terminal')).toHaveLength(1);
    expect(log.of('item.completed').map((item) => item.turnId)).toEqual([started.turnId]); // the old turn's answer belongs to it
    expect(second.activeTurn).toBeUndefined();
    expect(startEntries(setup.logFile)).toHaveLength(1); // no second process, ever
  });

  it('reaches it with Stop: an interrupt is sent, the aborted result ends the turn as interrupted, and the session works on', async () => {
    const { setup, instance, first } = await restartMidTurn({ turns: [quietTurn(20_000, 'never reached')] });
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    const log = new EventLog(second);
    const turnId = second.activeTurn!;
    expect(turnId).toBeTruthy();

    await second.interrupt(turnId);
    expect(receivedControls(setup.logFile, 'interrupt')).toHaveLength(1);
    expect((await log.waitForTerminal(turnId)).status).toBe('interrupted');
    expect(log.terminalsOf(turnId)).toHaveLength(1);

    const next = await second.sendTurn({ text: 'after the stop' });
    expect((await log.waitForTerminal(next.turnId)).status).toBe('completed');
  });

  it('gives a message sent meanwhile its own turn: the old turn ends at the old result, and the new message starts, runs and ends by itself', async () => {
    const { setup, instance, first } = await restartMidTurn({ turns: [quietTurn(2500, 'old answer'), quietTurn(300, 'new answer')] });
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    const log = new EventLog(second);
    const running = second.activeTurn!;

    // What the host does with a message typed while a turn runs. A uuid as its id becomes the message uuid, so the test knows it.
    const newTurn = 'cccccccc-1111-4222-8333-444444444444';
    await second.steer(running, { text: 'new message', clientMessageId: newTurn });

    await log.waitForTerminal(newTurn, 10_000);
    expect(kinds(log, newTurn)).toEqual([
      'turn.started:P:provider',
      'item.completed:P',
      'turn.terminal:P:completed',
      'turn.started:NEW:user',
      'item.completed:NEW',
      'turn.terminal:NEW:completed',
    ]);
    expect(log.terminalsOf(running)).toHaveLength(1);
    expect(log.terminalsOf(newTurn)).toHaveLength(1);
  });

  it('treats a process that refuses the repeated initialize as running: the next result ends the turn', async () => {
    const { setup, instance, first } = await restartMidTurn({ turns: [quietTurn(800, 'old turn done')], reinitializeError: 'already initialized' });
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(second.activeTurn).toBeTruthy();
    const log = new EventLog(second);
    const started = await log.waitForType('turn.started');
    expect(started.origin).toBe('provider');
    expect((await log.waitForTerminal(started.turnId, 10_000)).status).toBe('completed');
    expect(log.of('turn.terminal')).toHaveLength(1);
    expect(instance.openSessionIds).toEqual([first.nativeSessionId]);
    // No question was adopted (the refusal gave none), and the session works.
    const next = await second.sendTurn({ text: 'again' });
    expect((await log.waitForTerminal(next.turnId)).status).toBe('completed');
  });

  it('starts no turn for a process that is idle', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(second.activeTurn).toBeUndefined();
    const log = new EventLog(second);
    await sleep(100);
    expect(log.of('turn.started')).toEqual([]);
  });

  it('adopts a process that reports requires_action (it holds a prompt) like one that reports running', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false, reinitializeStateOverride: 'requires_action' }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(second.activeTurn).toBeTruthy(); // anything but idle is a turn that is not over
  });
});

describe('the background snapshot of a process found again', () => {
  it('is in before reattach() resolves, so the idle decision that follows never reads an empty set', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false, backgroundTasksOnReinitialize: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'build' }] }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(second.hasBackgroundWork()).toBe(true); // no waiting for it
  });

  it('is waited for within a short grace and then given up on, for a CLI that sends none', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true, timings: { backgroundSnapshotGraceMs: 250 } });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const started = Date.now();
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240); // it waited
    expect(second.hasBackgroundWork()).toBe(false);
    // The explicit `background_tasks` request backgrounds running work (Ctrl+B), so it is never sent as a way to ask.
    expect(receivedControls(setup.logFile, 'background_tasks')).toEqual([]);
  });

  it('fails the adoption, and keeps nothing loaded, when the process ends while it is waited for', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false, exitAfterReinitializeMs: 40 }, { host: true, timings: { backgroundSnapshotGraceMs: 1_500 } });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const error = await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exited while resuming/);
    expect(instance.openSessionIds).toEqual([]);
  });

  it('is resolved at once when it has already arrived, and by the frame when it comes later', async () => {
    const memory = memoryClient();
    expect(memory.session.awaitBackgroundSnapshot(5_000)).toBeInstanceOf(Promise);
    const waiting = memory.session.awaitBackgroundSnapshot(5_000);
    memory.system({ subtype: 'background_tasks_changed', tasks: [] });
    expect(await waiting).toBe(true);
    expect(await memory.session.awaitBackgroundSnapshot(5)).toBe(true);
    expect(await memoryClient().session.awaitBackgroundSnapshot(20)).toBe(false);
  });
});

describe('a turn adopted from a process that was already running', () => {
  it('is closed as completed, without a warning, when the CLI goes idle and its result went to the earlier backend', async () => {
    const memory = memoryClient({ idleResultGraceMs: 30 });
    const log = new EventLog(memory.session);
    memory.session.adoptRunningTurn();
    memory.system({ subtype: 'session_state_changed', state: 'idle' });
    await log.waitForType('turn.terminal');
    await settle();
    expect(log.of('turn.terminal')).toEqual([expect.objectContaining({ status: 'completed', sessionUsable: true })]);
    expect(log.of('notice')).toEqual([]);
  });

  it('leaves a turn this session saw begin to fail when the CLI goes idle without its result', async () => {
    const memory = memoryClient({ idleResultGraceMs: 30 });
    const log = new EventLog(memory.session);
    memory.frame({ type: 'system', subtype: 'init', session_id: 's', model: 'm', uuid: 'u1' }); // an unannounced turn that is not adopted
    memory.system({ subtype: 'session_state_changed', state: 'idle' });
    const terminal = await log.waitForType('turn.terminal');
    expect(terminal).toMatchObject({ status: 'failed', failure: { code: 'result_missing' } });
  });

  it('is not started twice, and is not started on a session that has ended', async () => {
    const memory = memoryClient();
    const log = new EventLog(memory.session);
    const id = memory.session.adoptRunningTurn();
    expect(memory.session.adoptRunningTurn()).toBe(id);
    await settle();
    expect(log.of('turn.started')).toHaveLength(1);
    memory.exit();
    await waitUntil(() => memory.session.isEnded);
    expect(memory.session.adoptRunningTurn()).toBeUndefined();
  });
});

describe('frames of a turn this session did not send', () => {
  const OLD = 'aaaaaaaa-1111-4222-8333-444444444444';

  it('are not credited to the send in flight: its own start, items and terminal come with its own uuids', async () => {
    const memory = memoryClient();
    const log = new EventLog(memory.session);
    const { turnId } = await memory.session.sendTurn({ text: 'new message' }); // written; the CLI has queued it behind a turn of its own
    // The turn that is running names a uuid this session never sent.
    memory.frame({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'old turn output' }] }, uuid: 'asst-old', user_message_uuids: [OLD], session_id: 's' });
    await settle();
    expect(log.of('turn.started')).toEqual([expect.objectContaining({ origin: 'provider' })]); // a provider turn, not the send
    expect(memory.session.activeTurn).not.toBe(turnId);
    memory.frame({ type: 'result', subtype: 'success', is_error: false, user_message_uuids: [OLD], result_index: 0, session_id: 's', usage: {}, modelUsage: {} });
    await settle();
    expect(log.of('turn.terminal')).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(log.of('turn.terminal')[0]!.turnId).not.toBe(turnId);

    // Now the CLI runs the send.
    memory.frame({ type: 'command_lifecycle', command_uuid: turnId, state: 'started', uuid: 'l1', session_id: 's' });
    memory.frame({ type: 'assistant', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'answer' }] }, uuid: 'asst-new', user_message_uuids: [turnId], session_id: 's' });
    memory.frame({ type: 'result', subtype: 'success', is_error: false, user_message_uuids: [turnId], result_index: 1, session_id: 's', usage: {}, modelUsage: {} });
    await settle();
    expect(kinds(log, turnId)).toEqual([
      'turn.started:P:provider',
      'item.completed:P',
      'turn.terminal:P:completed',
      'turn.started:NEW:user',
      'item.completed:NEW',
      'turn.terminal:NEW:completed',
    ]);
  });

  it('still go to the send in flight when they name no uuid at all (an older CLI)', async () => {
    const memory = memoryClient();
    const log = new EventLog(memory.session);
    const { turnId } = await memory.session.sendTurn({ text: 'hello' });
    memory.frame({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] }, uuid: 'asst-1', session_id: 's' });
    await settle();
    expect(log.of('turn.started')).toEqual([expect.objectContaining({ turnId, origin: 'user' })]);
    expect(log.of('item.completed')).toEqual([expect.objectContaining({ turnId })]); // the record, not an undefined one: the item is kept
    memory.frame({ type: 'result', subtype: 'success', is_error: false, result_index: 0, session_id: 's', usage: {}, modelUsage: {} });
    await settle();
    expect(log.terminalsOf(turnId)).toHaveLength(1);
  });

  it('are ignored by a result that names unknown uuids when no turn is open', async () => {
    const memory = memoryClient();
    const log = new EventLog(memory.session);
    const { turnId } = await memory.session.sendTurn({ text: 'hello' });
    memory.frame({ type: 'result', subtype: 'success', is_error: false, user_message_uuids: [OLD], result_index: 0, session_id: 's', usage: {}, modelUsage: {} });
    await settle();
    expect(log.of('turn.terminal')).toEqual([]); // not the send's result
    expect(memory.session.activeTurn).toBe(turnId);
    expect(memory.session.ignored.get('result (no turn)')).toBe(1);
  });
});

describe('a conversation that never ran a turn, after its process ended', () => {
  it('is started again under its own id by resume, and works (new chat, unload, resume, first message)', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    const id = first.nativeSessionId;
    await first.unload(); // idle sleep before the first prompt: the process ends and leaves no transcript
    await waitUntil(() => first.isEnded && setup.instance.openSessionIds.length === 0);
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(false);

    const second = setup.track(await setup.instance.resume(id, setup.open()));
    const log = new EventLog(second);
    const starts = startEntries(setup.logFile);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.argv).toEqual(expect.arrayContaining(['--session-id', id]));
    const { turnId } = await second.sendTurn({ text: 'hello after lunch' });
    expect((await log.waitForTerminal(turnId)).status).toBe('completed');
  });
});

describe('resume beside a process it must not start a second one for', () => {
  async function surviving() {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    return { setup, first, id: first.nativeSessionId };
  }

  it('adopts its own surviving process when a registry holder is that very process: no second start', async () => {
    const { setup, first, id } = await surviving();
    const { instance } = setup.restartBackend();
    const second = setup.track(await instance.resume(id, setup.open()));
    expect(second.pid).toBe(first.pid);
    expect(startEntries(setup.logFile)).toHaveLength(1);
  });

  it('adopts it even when the CLI registry shows no holder at all (the host and its record are the evidence)', async () => {
    const { setup, first, id } = await surviving();
    // The registry file is gone (a CLI that does not register, or one that was cleaned up): the old code launched `--resume`
    // here, which ended the live host because its command line differs from the recorded one.
    fs.rmSync(`${setup.configDir}/sessions`, { recursive: true, force: true });
    const { instance } = setup.restartBackend();
    const second = setup.track(await instance.resume(id, setup.open()));
    expect(second.pid).toBe(first.pid);
    expect(processStartTicks(first.pid!)).toBeDefined();
    expect(startEntries(setup.logFile)).toHaveLength(1);
  });

  it('refuses when a different process holds the session as well, lets the survivor go untouched, and starts nothing', async () => {
    const { setup, first, id } = await surviving();
    const tui = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude-tui'], { stdio: 'ignore' });
    try {
      await waitUntil(() => tui.pid !== undefined && processStartTicks(tui.pid) !== undefined);
      writeRegistryFile(setup.configDir, { pid: tui.pid!, sessionId: id, procStart: processStartTicks(tui.pid!) });
      const { instance } = setup.restartBackend();
      const error = await instance.resume(id, setup.open()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClaudeSessionHeldError);
      expect((error as ClaudeSessionHeldError).heldByPid).toBe(tui.pid);
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(processStartTicks(first.pid!)).toBeDefined();
      expect(instance.openSessionIds).toEqual([]);
    } finally {
      tui.kill('SIGKILL');
    }
  });

  it('drops a launch record whose host is gone (the process ended while no backend looked), then resumes as for any ended session', async () => {
    const { setup, first, id } = await surviving();
    await terminateHost(setup.hostRuntimeDir, hostIdFor('conversation-1'), setup.context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 });
    await waitUntil(() => processStartTicks(first.pid!) === undefined, 5000, 'the process to end');
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(true);
    const { instance, context } = setup.restartBackend();
    expect(await instance.reattach(id, setup.open())).toBeUndefined();
    expect(context.metaStore.has('claude-launch:conversation-1')).toBe(false); // stale, and gone
    const second = setup.track(await instance.resume(id, setup.open()));
    expect(second.pid).not.toBe(first.pid);
    expect(startEntries(setup.logFile)).toHaveLength(2);
  });

  it('keeps the launch record when the host only failed to answer, because the process may well still run', async () => {
    const ref: { real?: LineTransportFactory; unreachable: boolean } = { unreachable: false };
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, {
      host: true,
      plugin: {
        lineTransport: (request) => (ref.unreachable && (request as { attachOnly?: boolean }).attachOnly
          ? Promise.reject(new LineTransportNotRunningError('did not answer', 'unreachable'))
          : ref.real!(request)),
      },
    });
    ref.real = setup.context.lineTransport!;
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance, context } = setup.restartBackend();
    ref.unreachable = true;
    // A host that does not answer is not "no survivor": reattach and resume both refuse, start nothing, and keep the record.
    await expect(instance.reattach(first.nativeSessionId, setup.open())).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(instance.resume(first.nativeSessionId, setup.open())).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
    expect(processStartTicks(first.pid!)).toBeDefined();
    expect(startEntries(setup.logFile)).toHaveLength(1);
    expect(instance.openSessionIds).toEqual([]);
    ref.unreachable = false;
    const again = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!); // and the next try finds it
    expect(again.pid).toBe(first.pid);
  });
});

describe('a Stop that drops queued steers', () => {
  it('names the steers the CLI discarded, by the id the host gave, in a notice and in the return value', async () => {
    const setup = setupFake({ sessionStartHook: false, turns: [{ steps: [{ sleep: 5_000 }, assistantText('never')] }] });
    const session = setup.track(await setup.instance.start(setup.open()));
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'long job' });
    await log.waitForType('turn.started');
    // Queued behind a running turn that offers no tool boundary: the CLI holds both until Stop.
    await session.steer(turnId, { text: 'then do this', clientMessageId: 'queue-item-7' });
    const uuidShaped = 'bbbbbbbb-1111-4222-8333-444444444444';
    await session.steer(turnId, { text: 'and this', clientMessageId: uuidShaped });

    const result = await session.interrupt(turnId);
    expect(result).toEqual({ cancelledSteerIds: ['queue-item-7', uuidShaped] });
    // The notice comes through the event stream, which the log reads on its own schedule: wait for it.
    const notice = await log.waitFor((event) => event.type === 'notice' && /discarded 2 messages/.test(event.text));
    expect(notice.type === 'notice' && notice.text).toContain('queue-item-7');
    expect((await log.waitForTerminal(turnId)).status).toBe('interrupted');
    expect(log.terminalsOf(turnId)).toHaveLength(1);
    // Nothing runs for them afterwards, and a Stop with nothing queued reports nothing.
    await sleep(100);
    expect(log.of('turn.started')).toHaveLength(1);
  });

  it('reports nothing when no steer was queued', async () => {
    const setup = setupFake({ sessionStartHook: false, turns: [{ steps: [{ sleep: 5_000 }, assistantText('never')] }] });
    const session = setup.track(await setup.instance.start(setup.open()));
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'long job' });
    await log.waitForType('turn.started');
    expect(await session.interrupt(turnId)).toBeUndefined();
    expect((await log.waitForTerminal(turnId)).status).toBe('interrupted');
  });
});

/** A session over an in-memory channel: the test plays the CLI. */
function memoryClient(timings: Partial<typeof DEFAULT_TIMINGS> = {}) {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null; reason: 'exited' | 'disconnected' }) => void>();
  let ended = false;
  const transport: LineTransport = {
    pid: 4242,
    write: async () => {
      if (ended) throw new Error('closed');
    },
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close: async () => undefined,
  };
  const session = new ClaudeSession({
    sessionId: 's',
    cwd: '/work',
    client: new StreamJsonClient({ transport }),
    log: { info: () => undefined, warn: () => undefined },
    timings: { ...DEFAULT_TIMINGS, contextUsageTimeoutMs: 20, ...timings },
    configDir: '/nonexistent',
    requireSubscriptionLogin: false,
    onEnded: () => undefined,
  });
  const frame = (value: object): void => {
    for (const listener of [...lineListeners]) listener(JSON.stringify(value));
  };
  return {
    session,
    frame,
    system: (value: object) => frame({ type: 'system', uuid: 'sys', session_id: 's', ...value }),
    exit: () => {
      ended = true;
      for (const listener of [...exitListeners]) listener({ code: 0, signal: null, reason: 'exited' });
    },
  };
}
