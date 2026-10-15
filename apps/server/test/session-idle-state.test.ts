import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { CoordinationService } from '../src/coordination/service.js';
import { PEER_WAKE_PROMPT, peerWakeComposerKey } from '../src/coordination/wake.js';
import { findPendingAdoptionMatch } from '../src/sessions/pending-adoption.js';
import type { ConversationSummary } from '@agent-console/shared';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const old = () => new Date(Date.now() - 2 * 3600_000).toISOString();
function finished(db: AppDatabase, id: string) {
  const at = old();
  db.sqlite.prepare(`update bound_sessions set started_at=?,last_activity_at=?,last_output_at=?,last_completed_at=?,last_response_at=?,updated_at=?,is_working=0 where id=?`)
    .run(at, at, at, at, at, at, id);
}

it('adopts an idle live human-started session, sleeps through restart/polls and resumes its native identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-idle-state-'));
  const file = path.join(root, 'fixture.sqlite');
  let db = new AppDatabase(file);
  const tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
  const candidate: ConversationSummary = { ref: 'native-parent', kind: 'history', provider: 'codex', projectSlug: project.slug,
    title: 'Finished work', createdAt: old(), updatedAt: old(), isBound: false, degraded: false,
    rawMetadata: { firstUserTextHash: 'fingerprint', firstUserAt: old() } };
  const adapter = { ...provider, listPendingAdoptionCandidates: async () => [candidate],
    getLaunchCommand: (_project: unknown, ref: string | null) => ({ cwd: root, argv: ['codex', 'resume', ref ?? ''], env: {} }) };
  let manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), adapter);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = await manager.bindConversation({ project, provider: adapter, providerSettings, conversationRef: 'pending:identity', title: 'Pending', kind: 'pending' });
  db.pendingConversations.put({ ...candidate, ref: session.conversationRef, kind: 'pending', boundSessionId: session.id,
    rawMetadata: { lastUserInputHash: 'fingerprint', lastUserInputAt: old() } });
  finished(db, session.id);
  await manager.reconcileSessions();
  const asleep = db.boundSessions.getById(session.id)!;
  expect(asleep).toMatchObject({ conversationRef: candidate.ref, resumeConversationRef: candidate.ref, idleSuspendedAt: expect.any(String) });
  expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
  const activity = asleep.lastActivityAt;
  await manager.stop(); db.close(); db = new AppDatabase(file);
  manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), adapter);
  expect(await manager.getSessionScreen(session.id)).toBeUndefined();
  expect(await manager.ensureSession(session.id)).toBeUndefined();
  await manager.reconcileSessions();
  expect(tmux.created).toHaveLength(1);
  await manager.resumeSession(session.id);
  expect(tmux.createdCommands.at(-1)).toContain("'native-parent'");
  expect(db.boundSessions.getById(session.id)).toMatchObject({ idleSuspendedAt: undefined, lastActivityAt: activity });
});

it.each(['owned', 'foreign'] as const)('checks the %s writer when finishing an interrupted idle restore', async ownership => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-idle-restore-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
  const manager = createRecoveryManager(db, tmux, root);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: 'native-existing', title: 'Existing', kind: 'history' });
  db.boundSessions.setIdleSuspendedAt(session.id, old());
  db.sqlite.prepare("update bound_sessions set status='starting' where id=?").run(session.id);
  expect(await manager.getSessionScreen(session.id)).toBeUndefined();
  if (ownership === 'foreign') {
    await tmux.setOption(session.tmuxSessionName, '@agent_console_session_id', 'another-session');
    await expect(manager.resumeSession(session.id)).rejects.toThrow();
    expect(db.boundSessions.getById(session.id)?.idleSuspendedAt).toBeTruthy();
  } else {
    await manager.resumeSession(session.id);
    expect(db.boundSessions.getById(session.id)).toMatchObject({ idleSuspendedAt: undefined, status: 'bound', pid: 4242 });
  }
  expect(tmux.created).toHaveLength(1);
});

it.each(['pasting', 'staged', 'submitting', 'retiring', 'mixed', 'unowned'] as const)('checks %s automatic notice ownership before idle sleep', async phase => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-idle-notice-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  tmux.paneText = 'Claude Code\n❯ \n⏵⏵ bypass permissions on';
  const manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), claudeProvider);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const native = randomUUID();
  const session = await manager.bindConversation({ project, provider: claudeProvider, providerSettings, conversationRef: native, title: 'Idle', kind: 'history' });
  const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] });
  const assignment = coordination.register({ provider: 'claude', nativeSessionId: native, token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  coordination.update(assignment, { status: 'waiting' });
  finished(db, session.id);
  const status = phase === 'mixed' || phase === 'unowned' ? 'pasting' : phase;
  if (phase !== 'unowned') db.meta.set(peerWakeComposerKey(session.id), JSON.stringify({ status, notice: 'peer', assignmentId: assignment,
    pid: session.pid, startedAt: db.boundSessions.getById(session.id)!.startedAt, timestamp: new Date().toISOString(), messages: [] }));
  tmux.paneText = `Claude Code\nFinished response.\n❯ ${PEER_WAKE_PROMPT}${phase === 'mixed' ? ' my human draft' : ''}\n⏵⏵ bypass permissions on`;
  await manager.reconcileSessions();
  expect(Boolean(db.boundSessions.getById(session.id)?.idleSuspendedAt)).toBe(phase === 'pasting' || phase === 'staged');
  expect(tmux.sentKeys).toEqual([]);
});

it('rejects ambiguous native identities and inherited fork fingerprints', () => {
  const at = new Date().toISOString();
  const pending: ConversationSummary = { ref: 'pending:test', projectSlug: 'demo', provider: 'codex', kind: 'pending', title: 'Test',
    createdAt: at, updatedAt: at, isBound: true, degraded: false, rawMetadata: { lastUserInputHash: 'hash', lastUserInputAt: at } };
  const parent: ConversationSummary = { ...pending, ref: 'parent', kind: 'history', rawMetadata: { firstUserTextHash: 'hash', firstUserAt: at } };
  const child = { ...parent, ref: 'child', rawMetadata: { ...parent.rawMetadata, threadSource: 'subagent', forkedFromId: 'parent' } };
  expect(findPendingAdoptionMatch(pending, [child])).toBeUndefined();
  expect(findPendingAdoptionMatch(pending, [child, parent])?.ref).toBe('parent');
  expect(findPendingAdoptionMatch(pending, [parent, { ...parent, ref: 'another-parent' }])).toBeUndefined();
  expect(findPendingAdoptionMatch(pending, [parent], { claimedRefs: new Set(['parent']) })).toBeUndefined();
});

it.each(['direct', 'queued'] as const)('wakes an idle sleeper for %s human input', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-idle-human-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  const ready = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
  tmux.paneText = ready;
  const paste = tmux.pasteText.bind(tmux), literal = tmux.sendLiteralText.bind(tmux), keys = tmux.sendKeys.bind(tmux);
  tmux.pasteText = async (name, text) => { await paste(name, text); tmux.paneText = ready.replace('Ask Codex to do anything', text); };
  tmux.sendLiteralText = async (name, text) => { await literal(name, text); tmux.paneText = ready.replace('Ask Codex to do anything', text); };
  tmux.sendKeys = async (name, input) => { await keys(name, input); if (input.includes('Enter')) tmux.paneText = ready; };
  const manager = createRecoveryManager(db, tmux, root);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: 'native-human', title: 'Human', kind: 'history' });
  finished(db, session.id); await manager.reconcileSessions();
  expect(db.boundSessions.getById(session.id)?.idleSuspendedAt).toBeTruthy();
  if (mode === 'direct') await manager.sendInput(session.id, 'Continue the task.');
  else await manager.sendKeystrokes(session.id, { submissionId: randomUUID(), text: 'Continue the task.', submittedText: 'Continue the task.', keys: ['Enter'] });
  expect(db.boundSessions.getById(session.id)?.idleSuspendedAt).toBeUndefined();
  expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
  expect(tmux.sent.filter(text => text === 'Continue the task.')).toHaveLength(1);
  expect(tmux.sentKeys.filter(keys => keys.includes('Enter'))).toHaveLength(1);
});

it('does not retry a failed queued-input restore on the one-second input poll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-idle-failure-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
  const manager = createRecoveryManager(db, tmux, root);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: 'native-failure', title: 'Failure', kind: 'history' });
  finished(db, session.id); await manager.reconcileSessions();
  tmux.failPipePane = true;
  await manager.sendKeystrokes(session.id, { submissionId: randomUUID(), text: 'Continue.', submittedText: 'Continue.', keys: ['Enter'] });
  expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'error', idleSuspendedAt: expect.any(String) });
  const creations = tmux.created.length;
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(tmux.created).toHaveLength(creations);
  await manager.reconcileSessions();
  expect(tmux.created).toHaveLength(creations + 1);
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(tmux.created).toHaveLength(creations + 1);
});

it.each(['unsubmitted-codex', 'idle-claude'] as const)('avoids broad discovery for %s pending bindings', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-pending-scope-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  const id = mode === 'idle-claude' ? 'claude' : 'codex';
  const adapter = { ...(id === 'claude' ? claudeProvider : provider), getConversation: vi.fn(async () => null), listConversations: vi.fn(async () => []) };
  tmux.paneText = id === 'claude' ? 'Claude Code\n❯ \n⏵⏵ bypass permissions on'
    : 'OpenAI Codex\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
  const manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), adapter);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = await manager.bindConversation({ project, provider: adapter, providerSettings, conversationRef: 'pending:scope', title: 'Pending', kind: 'pending' });
  db.pendingConversations.put({ ref: session.conversationRef, provider: id, projectSlug: project.slug, kind: 'pending', title: 'Pending',
    createdAt: old(), updatedAt: old(), boundSessionId: session.id, isBound: true, degraded: false,
    rawMetadata: id === 'claude' ? { lastUserInputHash: 'hash', lastUserInputAt: old() } : {} });
  if (id === 'codex') {
    const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] });
    const assignment = coordination.register({ provider: id, nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
    db.meta.set(`console-session:${assignment}`, session.id);
  }
  finished(db, session.id); adapter.getConversation.mockClear(); adapter.listConversations.mockClear();
  if (id === 'codex') await manager.getSessionScreen(session.id);
  await manager.reconcileSessions();
  expect(adapter.getConversation).not.toHaveBeenCalled();
  expect(adapter.listConversations).not.toHaveBeenCalled();
  expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
});
