import { afterEach, describe, expect, it } from 'vitest';
import { settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// Recency moves only from new activity of the person or the agent and from a provider-confirmed response. Restores, sleep and
// status changes do not move it. `structured-session-lifecycle` covers recency from turn events and live output.
const open: StructuredSessionFixture[] = [];
function fixture() {
  const f = structuredSessionFixture();
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

const recency = (f: StructuredSessionFixture, id: string) => {
  const row = f.row(id);
  return { lastActivityAt: row.lastActivityAt, lastOutputAt: row.lastOutputAt, lastResponseAt: row.lastResponseAt, lastCompletedAt: row.lastCompletedAt };
};

describe('SessionManager recency', () => {
  it('moves activity on a sent message and the response time only when the turn completes', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    expect(f.row(session.id).lastActivityAt).toBeUndefined();
    await f.manager.sendInput(session.id, 'do the thing');
    await settle();
    const sent = recency(f, session.id);
    expect(sent.lastActivityAt).toBeTruthy();
    expect(sent.lastResponseAt).toBeUndefined();

    f.thread(session.conversationRef).completeTurn();
    await settle();
    expect(f.row(session.id).lastResponseAt).toBeTruthy();
    expect(f.row(session.id).lastActivityAt).toBe(sent.lastActivityAt);
  });

  it('does not move recency when the session sleeps, is suspended or is restored', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'one turn');
    await settle();
    f.thread(session.conversationRef).completeTurn();
    await settle();
    const before = recency(f, session.id);

    await f.manager.suspendSession(session.id);
    expect(recency(f, session.id)).toEqual(before);
    await f.manager.resumeSession(session.id);
    expect(f.row(session.id).manualSuspendedAt).toBeUndefined();
    expect(recency(f, session.id)).toEqual(before);

    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    await backend.manager.ensureSession(session.id);
    expect(recency(f, session.id)).toEqual(before);
  });
});
