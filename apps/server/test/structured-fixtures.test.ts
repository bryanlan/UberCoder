import { describe, expect, it } from 'vitest';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import {
  NotSentError,
  PreviousTurnActiveError,
  ResumeFailedError,
  TransportUnavailableError,
  type OpenOptions,
  type TransportEvent,
} from '../src/providers/transport/types.js';
import { CODEX_LIKE_CAPABILITIES, FakeTransportPlugin, fakePluginContext } from './helpers/structured-fixtures.js';

const OPEN: OpenOptions = {
  conversationId: 'console-session-1',
  cwd: '/tmp/project',
  policy: { approvals: 'never', sandbox: 'full-access' },
};

async function collect(events: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const seen: TransportEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function newInstance(options?: ConstructorParameters<typeof FakeTransportPlugin>[0]) {
  const plugin = new FakeTransportPlugin(options);
  return { plugin, instance: plugin.create({}, fakePluginContext()) };
}

describe('FakeTransportPlugin', () => {
  it('creates instances with the Codex-like capability shape and allocates thread ids', async () => {
    const { plugin, instance } = newInstance();
    expect(plugin.id).toBe('codex');
    expect(plugin.instance).toBe(instance);
    expect(instance.capabilities).toEqual(CODEX_LIKE_CAPABILITIES);
    expect(instance.capabilities).toMatchObject({ processModel: 'shared', steer: 'native', interrupt: 'terminal-follows',
      modelSwitch: 'next-turn', enforcement: 'native', images: false, resume: 'reattach', nativeIds: 'server-allocated' });

    const first = await instance.start(OPEN);
    instance.nextNativeSessionId = 'provided-thread';
    const second = await instance.start(OPEN);
    const third = await instance.start(OPEN);
    expect([first.nativeSessionId, second.nativeSessionId, third.nativeSessionId])
      .toEqual(['fake-thread-1', 'provided-thread', 'fake-thread-2']);
    expect(instance.sessions).toEqual([first, second, third]);
    expect(await instance.probe()).toMatchObject({ installed: true, auth: 'ok' });
    expect(await instance.alive()).toEqual({ pid: process.pid, connected: true });
  });

  it('delivers pushed events in order, auto-starts turns, and ends the stream after stopped', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    const { turnId } = await session.sendTurn({ text: 'hello', clientMessageId: 'm1' });
    expect(turnId).toBe('turn-1');
    session.push({ type: 'item.completed', turnId, itemId: 'i1', kind: 'assistant', replay: false });
    session.completeTurn('completed');
    await session.close('release');

    expect(await collect(session.events)).toEqual([
      { type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false },
      { type: 'item.completed', turnId: 'turn-1', itemId: 'i1', kind: 'assistant', replay: false },
      { type: 'turn.terminal', turnId: 'turn-1', status: 'completed', sessionUsable: true, replay: false },
      { type: 'session.state', state: 'stopped' },
    ]);
    expect(session.calls).toEqual([
      { method: 'sendTurn', args: [{ text: 'hello', clientMessageId: 'm1' }] },
      { method: 'close', args: ['release'] },
    ]);
  });

  it('wakes a waiting consumer when an event arrives later', async () => {
    const { instance } = newInstance({ manualTurns: true });
    const session = await instance.start(OPEN);
    const seen = collect(session.events);
    await session.sendTurn({ text: 'hi' });
    expect(session.calls.map((call) => call.method)).toEqual(['sendTurn']);
    session.push({ type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false });
    session.push({ type: 'notice', level: 'info', text: 'later' });
    session.push({ type: 'session.state', state: 'stopped' });
    expect((await seen).map((event) => event.type)).toEqual(['turn.started', 'notice', 'session.state']);
  });

  it('rejects a second turn until the terminal arrives and allows a single event consumer', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    await session.sendTurn({ text: 'one' });
    const rejected = await session.sendTurn({ text: 'two' }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PreviousTurnActiveError);
    expect(rejected).toMatchObject({ code: 'previous_turn_active' });

    session.completeTurn('interrupted');
    expect(await session.sendTurn({ text: 'two' })).toEqual({ turnId: 'turn-2' });

    session.events[Symbol.asyncIterator]();
    expect(() => session.events[Symbol.asyncIterator]()).toThrow('single consumer');
  });

  it('does not treat replayed turns as the active turn', async () => {
    const { instance } = newInstance();
    const session = await instance.resume('existing-thread', OPEN);
    session.push({ type: 'turn.started', turnId: 'old-turn', origin: 'user', replay: true });
    expect(session.activeTurnId).toBeUndefined();
    await expect(session.sendTurn({ text: 'fresh' })).resolves.toEqual({ turnId: 'turn-1' });
  });

  it('keeps the stream open after session.state error until the session closes', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    const iterator = session.events[Symbol.asyncIterator]();
    session.push({ type: 'session.state', state: 'error', failure: { class: 'transport_error', message: 'connection dropped' } });
    expect(await iterator.next()).toEqual({ done: false, value: expect.objectContaining({ state: 'error' }) });

    const pending = iterator.next();
    await session.close('error');
    expect(await pending).toEqual({ done: false, value: { type: 'session.state', state: 'stopped' } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(() => session.push({ type: 'notice', level: 'warn', text: 'late' })).toThrow('stopped');
    // As the real plugin: a turn on an ended session was certainly not sent.
    await expect(session.sendTurn({ text: 'late' })).rejects.toBeInstanceOf(NotSentError);
  });

  it('fails a closed session with the error types of the real plugin', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    const { turnId } = await session.sendTurn({ text: 'go' });
    await session.close('shutdown');

    // Nothing is written to an ended session, so a turn or a steer can be queued and tried again.
    const turn = await session.sendTurn({ text: 'late' }).catch((error: unknown) => error);
    expect(turn).toBeInstanceOf(NotSentError);
    expect(turn).toMatchObject({ code: 'not_sent' });
    const steer = await session.steer(turnId, { text: 'late' }).catch((error: unknown) => error);
    expect(steer).toBeInstanceOf(NotSentError);
    // Stop needs the connection: the transport is unavailable, which is not a not-sent turn.
    const stop = await session.interrupt(turnId).catch((error: unknown) => error);
    expect(stop).toBeInstanceOf(TransportUnavailableError);
    expect(stop).not.toBeInstanceOf(NotSentError);
    expect(stop).toMatchObject({ code: 'transport_unavailable' });
    // A loss after the write is whatever the test scripts: the real plugin throws TransportUnavailableError there.
    const open = await instance.start(OPEN);
    open.failNextSend = new TransportUnavailableError('The connection ended after the request was written.');
    const lost = await open.sendTurn({ text: 'work' }).catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(TransportUnavailableError);
    expect(lost).not.toBeInstanceOf(NotSentError);
  });

  it('ends the session and its event stream on unload, as the real plugin does', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    await session.unload();
    expect(session.closed).toBe(true);
    expect(await collect(session.events)).toEqual([{ type: 'session.state', state: 'stopped' }]);
    await expect(session.sendTurn({ text: 'after unload' })).rejects.toBeInstanceOf(NotSentError);
  });

  it('records steer, interrupt, respond and unload and checks the steer target', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    const { turnId } = await session.sendTurn({ text: 'go' });
    await session.steer(turnId, { text: 'also this' });
    await expect(session.steer('turn-99', { text: 'wrong turn' })).rejects.toThrow('not the active turn');
    await session.interrupt(turnId);
    await session.respond('req-1', { decision: 'decline' });
    await session.unload();
    expect(session.calls.map((call) => call.method)).toEqual(['sendTurn', 'steer', 'steer', 'interrupt', 'respond', 'unload']);
    expect(session.calls[4]).toEqual({ method: 'respond', args: ['req-1', { decision: 'decline' }] });
  });

  it('fails resume with ResumeFailedError when configured and resumes the same id otherwise', async () => {
    const { instance } = newInstance();
    const resumed = await instance.resume('thread-abc', OPEN);
    expect(resumed).toMatchObject({ nativeSessionId: 'thread-abc', resumed: true });

    instance.failResume = true;
    const failure = await instance.resume('thread-abc', OPEN).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResumeFailedError);
    expect(failure).toMatchObject({ code: 'resume_failed' });
    expect(instance.sessions).toHaveLength(1);

    const { plugin } = newInstance({ failResume: true, manualTurns: true });
    expect(plugin.instance).toMatchObject({ failResume: true, manualTurns: true });
  });

  it('stops live sessions and refuses new ones once the instance is disposed', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    await instance.dispose('shutdown');
    expect(await collect(session.events)).toEqual([{ type: 'session.state', state: 'stopped' }]);
    expect(await instance.alive()).toEqual({ pid: process.pid, connected: false });
    await expect(instance.start(OPEN)).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(instance.resume('thread', OPEN)).rejects.toMatchObject({ code: 'transport_unavailable' });
  });

  it('lets a for-await consumer stop early without breaking later close calls', async () => {
    const { instance } = newInstance();
    const session = await instance.start(OPEN);
    await session.sendTurn({ text: 'go' });
    for await (const event of session.events) { expect(event.type).toBe('turn.started'); break; }
    session.push({ type: 'notice', level: 'info', text: 'ignored: nobody is reading' });
    await expect(session.close('shutdown')).resolves.toBeUndefined();
  });
});

describe('TransportPluginRegistry', () => {
  it('registers, looks up and lists plugins and refuses duplicate ids', () => {
    const registry = new TransportPluginRegistry();
    const codex = new FakeTransportPlugin({ id: 'codex' });
    const claude = new FakeTransportPlugin({ id: 'claude', capabilities: { processModel: 'per-session', steer: 'native-cancels-tools' } });
    registry.register(codex);
    registry.register(claude);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list()).toEqual([codex, claude]);
    expect(() => registry.register(new FakeTransportPlugin({ id: 'codex' }))).toThrow('already registered');
    expect(claude.create({}, fakePluginContext()).capabilities).toMatchObject({ processModel: 'per-session', steer: 'native-cancels-tools', images: false });
  });
});
