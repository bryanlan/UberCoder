import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import { InputQueue } from '../src/sessions/input-queue.js';
import { eventLogLines, recordHistoryNotes, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// Every conversation runs on the structured transport. A row an earlier build left on the removed tmux transport is converted
// when the backend starts, before anything reads it: its hidden tmux session is ended, the plugin learns the conversation has
// history, and the row sleeps until its next message resumes the same native conversation.
const open: Array<{ f: StructuredSessionFixture; restore?: () => void }> = [];
afterEach(async () => { for (const { f, restore } of open.splice(0)) { restore?.(); await f.cleanup(); } });

function fixture() {
  const ended: string[] = [];
  const history = recordHistoryNotes();
  const f = structuredSessionFixture({ manager: { endTmuxSession: name => { ended.push(name); } } });
  open.push({ f, restore: history.restore });
  return { f, ended, history };
}

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

/** A row as the tmux transport stored it: a hidden session name, a raw log and a pane pid. */
function tmuxRow(f: StructuredSessionFixture, overrides: Partial<BoundSession> = {}): BoundSession {
  const id = randomUUID();
  const eventLogPath = path.join(f.root, id, 'events.jsonl');
  fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  fs.writeFileSync(eventLogPath, '');
  const row: BoundSession = {
    id, provider: 'codex', projectSlug: 'demo', conversationRef: `native-${id}`, resumeConversationRef: `native-${id}`,
    status: 'bound', shouldRestore: true, title: 'Old tmux chat', startedAt: HOUR_AGO, updatedAt: HOUR_AGO,
    lastActivityAt: HOUR_AGO, lastResponseAt: HOUR_AGO, isWorking: true, pid: 4242, eventLogPath, ...overrides,
  };
  f.db.boundSessions.upsert(row);
  // The upsert does not write the suspension markers; a manual suspension is set the way the repository's setter stores it.
  f.db.sqlite.prepare("update bound_sessions set transport = 'tmux', tmux_session_name = ?, raw_log_path = ?, manual_suspended_at = ? where id = ?")
    .run(`ac-codex-demo-${id.slice(0, 8)}`, path.join(f.root, id, 'raw.log'), row.manualSuspendedAt ?? null, id);
  return f.db.boundSessions.getById(id)!;
}
const columns = (f: StructuredSessionFixture, id: string) =>
  f.db.sqlite.prepare('select transport, tmux_session_name as name, raw_log_path as rawLog from bound_sessions where id = ?').get(id);

describe('Startup conversion of rows left on the tmux transport', () => {
  it('ends the tmux session and turns the row into a sleeping structured row whose next message resumes the same conversation', async () => {
    const { f, ended, history } = fixture();
    const row = tmuxRow(f);
    const backend = await f.restartBackend();

    expect(ended).toEqual([`ac-codex-demo-${row.id.slice(0, 8)}`]);
    expect(history.notes).toEqual([{ conversationId: row.id, nativeSessionId: row.conversationRef }]);
    expect(columns(f, row.id)).toEqual({ transport: 'structured', name: `structured:${row.id}`, rawLog: null });
    const converted = f.row(row.id);
    expect(converted).toMatchObject({ status: 'bound', shouldRestore: true, isWorking: false, pid: undefined,
      conversationRef: row.conversationRef, title: 'Old tmux chat', lastActivityAt: HOUR_AGO, lastResponseAt: HOUR_AGO });
    expect(converted.idleSuspendedAt).toBeTruthy();
    expect(eventLogLines(converted).map(line => line.text)).toContain('Moved to the structured transport; the next message resumes this conversation.');
    expect(f.events.filter(event => event.type === 'session.updated').length).toBeGreaterThan(0);

    const requestId = randomUUID();
    await backend.manager.sendKeystrokes(row.id, { submissionId: requestId, text: 'still there?', submittedText: 'still there?', keys: ['Enter'] });
    const resumed = backend.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume');
    expect(resumed.map(call => call.args[0])).toEqual([row.conversationRef]);
    expect(new InputQueue(f.db.sqlite).get(row.id, requestId)?.state).toBe('submitted');
    expect(f.row(row.id).idleSuspendedAt).toBeUndefined();

    // A second start finds nothing left to convert.
    await f.restartBackend();
    expect(ended).toHaveLength(1);
  });

  it('keeps a manual suspension instead of adding an idle marker, and leaves rows that are no longer restorable alone', async () => {
    const { f, ended } = fixture();
    const manual = tmuxRow(f, { manualSuspendedAt: HOUR_AGO });
    const released = tmuxRow(f, { status: 'ended', shouldRestore: false });
    await f.restartBackend();

    expect(f.row(manual.id)).toMatchObject({ manualSuspendedAt: HOUR_AGO, idleSuspendedAt: undefined });
    expect(columns(f, manual.id)).toMatchObject({ transport: 'structured' });
    expect(columns(f, released.id)).toMatchObject({ transport: 'tmux' });
    expect(ended).toEqual([`ac-codex-demo-${manual.id.slice(0, 8)}`]);
  });

  it('fails a message that was being typed into the tmux composer and keeps one that was only queued', async () => {
    const { f } = fixture();
    const row = tmuxRow(f);
    const queue = new InputQueue(f.db.sqlite);
    const now = new Date().toISOString();
    // `awaiting_input` is the paste-confirmation state the tmux transport had: the text may already be in its composer.
    queue.put(row.id, { requestId: 'typed', text: 'half typed', requestedAt: now, state: 'awaiting_input' as never, reason: 'Waiting for the typed message to appear.' });
    queue.put(row.id, { requestId: 'queued', text: 'not yet typed', requestedAt: now, state: 'queued', reason: 'Waiting.' });
    await f.restartBackend();

    expect(queue.get(row.id, 'typed')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/while this message was being typed/) });
    expect(queue.get(row.id, 'queued')).toMatchObject({ state: 'queued' });
  });

  it('ends a converted row that never learned its native conversation on its next use', async () => {
    const { f, history } = fixture();
    const row = tmuxRow(f, { conversationRef: 'pending:never-adopted', resumeConversationRef: undefined });
    const backend = await f.restartBackend();
    expect(history.notes).toEqual([]);
    expect(f.row(row.id).idleSuspendedAt).toBeTruthy();

    await expect(backend.manager.sendInput(row.id, 'hello?')).rejects.toBeInstanceOf(SessionInputRejectedError);
    expect(f.row(row.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(backend.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume')).toHaveLength(0);
  });
});
