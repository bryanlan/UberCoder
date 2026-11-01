import { afterEach, describe, expect, it } from 'vitest';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// The queued model-profile request a person makes from the conversation header: one request at a time, applied when no turn
// runs, cancellable until it applies. `structured-session-lifecycle` covers how the transport carries the profile on the next turn.
const open: StructuredSessionFixture[] = [];
function fixture() {
  const f = structuredSessionFixture();
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

async function busySession(f: StructuredSessionFixture) {
  const { session } = await f.bindNew();
  await f.manager.sendInput(session.id, 'long work');
  await settle();
  return session;
}

describe('queued model-profile requests', () => {
  it('keeps only the latest queued profile and applies it once the turn ends', async () => {
    const f = fixture();
    const session = await busySession(f);
    await f.manager.requestModelProfile(session.id, 'high');
    await f.manager.requestModelProfile(session.id, 'low');
    await settle();
    expect(f.row(session.id).modelProfileRequest).toMatchObject({ profile: 'low', state: 'queued', deferredReason: 'turn_running' });

    f.thread(session.conversationRef).completeTurn();
    await expect.poll(() => f.row(session.id).codexProfile, { timeout: 2000, interval: 50 }).toBe('low');
    expect(f.row(session.id).modelProfileRequest).toBeUndefined();
  });

  it('cancels the exact queued request without switching, and refuses a stale request id', async () => {
    const f = fixture();
    const session = await busySession(f);
    const { session: requested } = await f.manager.requestModelProfile(session.id, 'high');
    const requestId = requested.modelProfileRequest!.requestId;
    await expect(f.manager.cancelModelProfileRequest(session.id, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/changed/);
    await f.manager.cancelModelProfileRequest(session.id, requestId);
    expect(f.row(session.id).modelProfileRequest).toBeUndefined();

    f.thread(session.conversationRef).completeTurn();
    await settle();
    expect(f.row(session.id).codexProfile).toBe('medium');
    expect(eventLogLines(f.row(session.id)).map(line => line.text)).toContain('Cancelled the queued high codex profile.');
  });

  it('cancels a queued change when the active profile is selected again', async () => {
    const f = fixture();
    const session = await busySession(f);
    await f.manager.requestModelProfile(session.id, 'high');
    await f.manager.requestModelProfile(session.id, 'medium');
    expect(f.row(session.id).modelProfileRequest).toBeUndefined();
    expect(eventLogLines(f.row(session.id)).map(line => line.text)).toContain('Cancelled the queued model change; codex already uses medium.');
  });

  it('clears a queued request when its session is released', async () => {
    const f = fixture();
    const session = await busySession(f);
    await f.manager.requestModelProfile(session.id, 'low');
    await f.manager.releaseSession(session.id);
    expect(f.row(session.id)).toMatchObject({ status: 'ended', modelProfileRequest: undefined });
  });

  it('continues a queued request after the backend restarts, without a new request from the browser', async () => {
    const f = fixture();
    const session = await busySession(f);
    await f.manager.requestModelProfile(session.id, 'low');
    expect(f.row(session.id).modelProfileRequest).toMatchObject({ profile: 'low', state: 'queued' });

    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    await expect.poll(() => f.row(session.id).codexProfile, { timeout: 2000, interval: 50 }).toBe('low');
    expect(f.row(session.id).modelProfileRequest).toBeUndefined();
  });
});
