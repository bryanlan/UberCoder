import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileService } from '../src/model-profiles/service.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import { provider } from './helpers/session-fixtures.js';
import { settle, structuredSessionFixture, structuredSessionsConfig, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

const ALL = ['0000-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z'] as const;
const records = (f: StructuredSessionFixture) => f.db.typedInputRecords.list(...ALL);

function send(f: StructuredSessionFixture, sessionId: string, text: string, requestId: string = randomUUID()) {
  return f.manager.sendKeystrokes(sessionId, { submissionId: requestId, text, submittedText: text, keys: ['Enter'] });
}

/** A provider that cannot steer, so a reply sent mid-turn waits in the input journal. */
function steerlessFixture(id: 'grok' | 'vibe') {
  return fixture({
    plugin: { id, capabilities: { steer: 'none' } },
    provider: { ...provider, id },
    manager: { structuredSessions: { ...structuredSessionsConfig, [id]: { enabled: true, command: [`fake-${id}`], idleUnloadMinutes: 60, env: {} } },
      ...(id === 'vibe' ? { modelProfiles: new ModelProfileService({ woPath: fileURLToPath(new URL('./helpers/fake-wo.mjs', import.meta.url)) }) } : {}) },
  });
}

describe('typed input record', () => {
  it('records a send the provider accepted, with the session, provider, project, conversation, time, text and mode', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const before = new Date().toISOString();
    const requestId = randomUUID();
    await send(f, session.id, 'Refactor the parser', requestId);
    expect(records(f)).toEqual([{
      sessionId: session.id, requestId, provider: 'codex', projectSlug: session.projectSlug, conversationRef: session.conversationRef,
      typedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/), text: 'Refactor the parser', howSent: 'immediate',
    }]);
    expect(records(f)[0]!.typedAt >= before).toBe(true);
  });

  it('records a human opening message and a direct send, in order', async () => {
    const f = fixture();
    const { session } = await f.bindNew({ initialPrompt: 'Start here' });
    await f.manager.sendInput(session.id, 'Then this');
    expect(records(f).map(record => [record.text, record.howSent])).toEqual([['Start here', 'immediate'], ['Then this', 'immediate']]);
  });

  it('records the text exactly as typed after trimming only what the Console itself trims', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'line one\n\n  indented `code` "quotes"');
    expect(records(f)[0]!.text).toBe('line one\n\n  indented `code` "quotes"');
  });

  it.each(['claude'] as const)('records a send to %s', async (id) => {
    const f = fixture({ plugin: { id } });
    const { session } = await f.bindNew();
    await send(f, session.id, 'hello');
    expect(records(f)).toMatchObject([{ provider: id, text: 'hello', howSent: 'immediate' }]);
  });

  it.each(['grok', 'vibe'] as const)('records a message queued while %s is busy as queued, once, and keeps it after delivery', async (id) => {
    const f = steerlessFixture(id);
    const { session } = await f.bindNew();
    await send(f, session.id, 'investigate');
    await settle();
    const requestId = randomUUID();
    const result = await send(f, session.id, 'the planner chat is missing', requestId);
    expect(result.queuedInput).toMatchObject({ requestId, state: 'queued' });
    // Recorded on acceptance, before the provider has it.
    expect(records(f).map(record => [record.provider, record.text, record.howSent])).toEqual([
      [id, 'investigate', 'immediate'], [id, 'the planner chat is missing', 'queued']]);
    f.thread(session.conversationRef).completeTurn('interrupted');
    await expect.poll(() => f.calls(session.conversationRef, 'sendTurn').length, { timeout: 5000, interval: 50 }).toBe(2);
    await settle();
    expect(records(f)).toHaveLength(2);
    expect(records(f)[1]).toMatchObject({ requestId, howSent: 'queued' });
  });

  it('records a message steered into a running turn, which the provider takes immediately', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    await send(f, session.id, 'and also this');
    expect(records(f).map(record => [record.text, record.howSent])).toEqual([['first', 'immediate'], ['and also this', 'immediate']]);
  });

  it('does not record an automatic opening prompt, a peer delivery or a status line', async () => {
    const f = fixture();
    const { session } = await f.bindNew({ initialPrompt: 'Helper task', initialPromptIsHuman: false });
    await f.manager['structured'].deliverAutomatic(f.row(session.id), 'You have a new coordination message');
    await settle();
    expect(records(f)).toEqual([]);
    await send(f, session.id, 'a real message');
    expect(records(f).map(record => record.text)).toEqual(['a real message']);
  });

  it('does not record a message the Console refused', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await expect(f.manager.sendInput(session.id, '/compact')).rejects.toThrow(SessionInputRejectedError);
    expect(records(f)).toEqual([]);
  });

  it('keeps every record after the session is released, its runtime directory is swept and the backend restarts', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'before the end');
    await f.manager.releaseSession(session.id);
    await f.manager.cleanupEndedSessionRuntimeDirs();
    expect(records(f).map(record => record.text)).toEqual(['before the end']);
    const next = await f.restartBackend();
    await next.manager.cleanupEndedSessionRuntimeDirs();
    expect(records(f).map(record => record.text)).toEqual(['before the end']);
  });

  it('refuses to change or delete a record', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'permanent');
    expect(() => f.db.sqlite.prepare("update typed_input_records set text = 'edited'").run()).toThrow(/append-only/);
    expect(() => f.db.sqlite.prepare('delete from typed_input_records').run()).toThrow(/append-only/);
    expect(records(f)[0]!.text).toBe('permanent');
  });

  it('lists a time window, start included and end excluded', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    for (const [index, text] of ['a', 'b', 'c'].entries()) {
      f.db.typedInputRecords.append({ sessionId: session.id, requestId: `r${index}`, provider: 'codex', projectSlug: session.projectSlug,
        conversationRef: session.conversationRef, typedAt: `2026-11-0${index + 1}T00:00:00.000Z`, text, howSent: 'immediate' });
    }
    expect(f.db.typedInputRecords.list('2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z').map(record => record.text)).toEqual(['b']);
  });
});
