import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager recency', () => {
  it('does not refresh completion recency just because the screen leaves Working', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Ready when you are.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const workingStates: Array<{ isWorking?: boolean; lastCompletedAt?: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.updated') {
        workingStates.push({
          isWorking: event.session.isWorking,
          lastCompletedAt: event.session.lastCompletedAt,
        });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-working-recency',
      title: 'Conversation',
      kind: 'history',
    });

    expect(db.getBoundSessionById(session.id)?.isWorking).toBe(false);
    expect(db.getBoundSessionById(session.id)?.lastCompletedAt).toBeUndefined();

    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      '• Working (20s • esc to interrupt)',
    ].join('\n');
    await manager.sendInput(session.id, 'continue');
    expect(db.getBoundSessionById(session.id)?.isWorking).toBe(true);

    tmux.captureSequence = [[
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n')];

    await manager.getSessionScreen(session.id);

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBeUndefined();
    expect(workingStates.some((state) => state.isWorking === true && !state.lastCompletedAt)).toBe(true);
    expect(workingStates.some((state) => state.isWorking === false && !state.lastCompletedAt)).toBe(true);
    unsubscribe();
    db.close();
  });

  it('does not treat recent output as completed before the idle window elapses', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-recency-repair',
      title: 'Conversation',
      kind: 'history',
    });

    const staleCompletion = new Date(Date.now() - 10 * 60_000).toISOString();
    const newerOutput = new Date(Date.now() - 30_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastCompletedAt: staleCompletion,
      lastOutputAt: newerOutput,
    });

    await manager.getSessionScreen(session.id);

    expect(db.getBoundSessionById(session.id)?.lastCompletedAt).toBe(staleCompletion);
    db.close();
  });

  it('does not repair idle recency from raw event logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-recency-overwrite-repair',
      title: 'Conversation',
      kind: 'history',
    });

    const realOutputAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const overwrittenAt = new Date(Date.now() - 30_000).toISOString();
    await fs.writeFile(
      session.eventLogPath!,
      `${JSON.stringify({ type: 'raw-output', text: 'Meaningful output', timestamp: realOutputAt })}\n`,
      'utf8',
    );

    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: overwrittenAt,
      lastCompletedAt: overwrittenAt,
    });

    await manager.getSessionScreen(session.id);

    const tracked = db.getBoundSessionById(session.id);
    expect(tracked?.lastOutputAt).toBe(overwrittenAt);
    expect(tracked?.lastCompletedAt).toBe(overwrittenAt);
    db.close();
  });

  it('preserves legitimate later completion recency for idle sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-legitimate-completion',
      title: 'Conversation',
      kind: 'history',
    });

    const outputAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const completedAt = new Date(Date.now() - 19 * 60_000).toISOString();
    await fs.writeFile(
      session.eventLogPath!,
      `${JSON.stringify({ type: 'raw-output', text: 'Meaningful output', timestamp: outputAt })}\n`,
      'utf8',
    );

    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: outputAt,
      lastCompletedAt: completedAt,
    });

    await manager.getSessionScreen(session.id);

    const repaired = db.getBoundSessionById(session.id);
    expect(repaired?.lastOutputAt).toBe(outputAt);
    expect(repaired?.lastCompletedAt).toBe(completedAt);
    db.close();
  });

  it('does not emit repair updates from raw event logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const repairedUpdates: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.updated' && event.session.conversationRef === 'session-idle-recency-overwrite-once') {
        repairedUpdates.push(`${event.session.lastOutputAt ?? ''}|${event.session.lastCompletedAt ?? ''}`);
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-recency-overwrite-once',
      title: 'Conversation',
      kind: 'history',
    });

    const realOutputAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const overwrittenAt = new Date(Date.now() - 30_000).toISOString();
    await fs.writeFile(
      session.eventLogPath!,
      `${JSON.stringify({ type: 'raw-output', text: 'Meaningful output', timestamp: realOutputAt })}\n`,
      'utf8',
    );

    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: overwrittenAt,
      lastCompletedAt: overwrittenAt,
    });
    repairedUpdates.length = 0;

    await manager.getSessionScreen(session.id);
    await manager.getSessionScreen(session.id);

    expect(repairedUpdates).not.toContain(`${realOutputAt}|${realOutputAt}`);
    unsubscribe();
    db.close();
  });

  it('ignores malformed event logs when preserving idle recency', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-recency-malformed-log',
      title: 'Conversation',
      kind: 'history',
    });

    const realOutputAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const overwrittenAt = new Date(Date.now() - 30_000).toISOString();
    await fs.writeFile(
      session.eventLogPath!,
      [
        '{"type":"raw-output","text":"broken"',
        JSON.stringify({ type: 'raw-output', text: 'Meaningful output', timestamp: realOutputAt }),
      ].join('\n'),
      'utf8',
    );

    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: overwrittenAt,
      lastCompletedAt: overwrittenAt,
    });

    await manager.getSessionScreen(session.id);

    const tracked = db.getBoundSessionById(session.id);
    expect(tracked?.lastOutputAt).toBe(overwrittenAt);
    expect(tracked?.lastCompletedAt).toBe(overwrittenAt);
    db.close();
  });

  it('does not backfill completion recency from an idle screen capture', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-backfill',
      title: 'Conversation',
      kind: 'history',
    });

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBeUndefined();
    db.close();
  });

  it('ignores restore output until user input makes raw output trackable', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Ready when you are.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let rawOutputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.raw-output') {
        rawOutputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-restore-output-no-recency',
      title: 'Conversation',
      kind: 'history',
    });

    await fs.appendFile(session.rawLogPath!, '\nRestored session startup output.\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterRestoreOutput = db.getBoundSessionById(session.id);
    expect(afterRestoreOutput?.lastOutputAt).toBeUndefined();
    expect(afterRestoreOutput?.lastCompletedAt).toBeUndefined();
    expect(afterRestoreOutput?.isWorking).toBe(false);
    expect(rawOutputEvents).toBe(0);

    await manager.sendInput(session.id, 'continue');
    await fs.appendFile(session.rawLogPath!, '\nReal response after user input.\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterUserOutput = db.getBoundSessionById(session.id);
    expect(afterUserOutput?.lastOutputAt).toBeTruthy();
    expect(afterUserOutput?.lastCompletedAt).toBeUndefined();
    expect(afterUserOutput?.isWorking).toBe(true);
    expect(rawOutputEvents).toBe(1);

    unsubscribe();
    db.close();
  });

  it('does not count echoed user input as assistant output for recency', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Ready when you are.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let rawOutputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.raw-output') {
        rawOutputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-echoed-input-no-recency',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendInput(session.id, 'review current changes');
    await fs.appendFile(session.rawLogPath!, '\n› review current changes\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterEcho = db.getBoundSessionById(session.id);
    expect(afterEcho?.lastOutputAt).toBeUndefined();
    expect(afterEcho?.lastCompletedAt).toBeUndefined();
    expect(afterEcho?.isWorking).toBe(false);
    expect(rawOutputEvents).toBe(0);

    unsubscribe();
    db.close();
  });

  it('does not reactivate a stale Working screen when the output heartbeat is old', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-stale-working-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const staleTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: staleTimestamp,
      lastCompletedAt: staleTimestamp,
      lastActivityAt: staleTimestamp,
    });
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '• Working (9m 42s • esc to interrupt)',
      '',
      '› review current changes',
      'gpt-5.4 xhigh · 92% left · ~/demo',
    ].join('\n');

    await manager.getSessionScreen(session.id);

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBe(staleTimestamp);
    db.close();
  });

  it('does not refresh completion recency during recovery when a stale working session comes back idle', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');

    const firstManager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await firstManager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-recovery-recency',
      title: 'Conversation',
      kind: 'history',
    });

    const staleOutputAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const staleCompletedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: true,
      lastActivityAt: staleOutputAt,
      lastOutputAt: staleOutputAt,
      lastCompletedAt: staleCompletedAt,
    });

    const recoveredManager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    await recoveredManager.ensureSession(session.id);

    const recovered = db.getBoundSessionById(session.id);
    expect(recovered?.isWorking).toBe(false);
    expect(recovered?.lastCompletedAt).toBe(staleCompletedAt);
    db.close();
  });

  it('expires working sessions after the heartbeat goes cold even if the pane still shows Working', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '• Working (5s • esc to interrupt)',
      '',
      '› review current changes',
      'gpt-5.4 xhigh · 92% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-working-expiry',
      title: 'Conversation',
      kind: 'history',
    });

    const staleHeartbeatAt = new Date(Date.now() - 61_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: true,
      lastActivityAt: staleHeartbeatAt,
      lastOutputAt: undefined,
      lastCompletedAt: undefined,
    });
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '• Working (1m 1s • esc to interrupt)',
      '',
      '› review current changes',
      'gpt-5.4 xhigh · 92% left · ~/demo',
      '',
    ].join('\n');
    await manager.getSessionScreen(session.id);

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBeUndefined();
    db.close();
  });

  it('marks output completed only after the output idle window has elapsed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-output-idle-completion',
      title: 'Conversation',
      kind: 'history',
    });

    const outputAt = new Date(Date.now() - 61_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: true,
      lastOutputAt: outputAt,
      lastCompletedAt: undefined,
    });

    await (manager as unknown as {
      handleWorkingIdleExpiry: (sessionId: string, expectedHeartbeatAt: string) => Promise<void>;
    }).handleWorkingIdleExpiry(session.id, outputAt);

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBe(outputAt);
    db.close();
  });

  it('does not treat idle housekeeping output as fresh completion activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Review complete.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-housekeeping-ignore',
      title: 'Conversation',
      kind: 'history',
    });

    const previousTimestamp = '2026-03-14T21:00:00.000Z';
    const tracked = db.getBoundSessionById(session.id)!;
    db.upsertBoundSession({
      ...tracked,
      updatedAt: previousTimestamp,
      lastActivityAt: previousTimestamp,
      lastOutputAt: undefined,
      lastCompletedAt: previousTimestamp,
      isWorking: false,
    });
    tmux.paneText = [
      'Claude Code',
      '',
      'Checking for updates',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    await fs.appendFile(tracked.rawLogPath!, 'Checking for updates\n');
    await new Promise((resolve) => setTimeout(resolve, 350));

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.lastOutputAt).toBeUndefined();
    expect(updated?.lastCompletedAt).toBe(previousTimestamp);
    db.close();
  });

  it('preserves stale idle completion timestamps even when event logs contain older output', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Review complete.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-housekeeping-repair',
      title: 'Conversation',
      kind: 'history',
    });

    const meaningfulTimestamp = '2026-03-14T21:37:41.960Z';
    const housekeepingTimestamp = '2026-03-14T21:59:15.684Z';
    const tracked = db.getBoundSessionById(session.id)!;
    await fs.appendFile(tracked.eventLogPath!, `${JSON.stringify({
      type: 'raw-output',
      text: 'Real assistant output',
      timestamp: meaningfulTimestamp,
    })}\n`);
    await fs.appendFile(tracked.eventLogPath!, `${JSON.stringify({
      type: 'raw-output',
      text: 'Checking for updates',
      timestamp: housekeepingTimestamp,
    })}\n`);
    db.upsertBoundSession({
      ...tracked,
      updatedAt: housekeepingTimestamp,
      lastActivityAt: housekeepingTimestamp,
      lastOutputAt: housekeepingTimestamp,
      lastCompletedAt: housekeepingTimestamp,
      isWorking: false,
    });

    await manager.getSessionScreen(session.id);

    const trackedAfterScreen = db.getBoundSessionById(session.id);
    expect(trackedAfterScreen?.lastOutputAt).toBe(housekeepingTimestamp);
    expect(trackedAfterScreen?.lastCompletedAt).toBe(housekeepingTimestamp);
    db.close();
  });

});
