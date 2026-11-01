import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergedProviderSettings } from '../src/config/service.js';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import { createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { FakeTransportInstance, FakeTransportPlugin } from './helpers/structured-fixtures.js';
import { settle, structuredSessionsConfig } from './helpers/structured-session-fixture.js';

// Bind, auto-track and restore bookkeeping that does not depend on the provider: the structured-session-* files cover what the
// transport does with each step.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-'));
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const plugin = new FakeTransportPlugin();
  const registry = new TransportPluginRegistry();
  registry.register(plugin);
  const settings: MergedProviderSettings = { ...providerSettings };
  const manager = createRecoveryManager(db, path.join(root, 'runtime'), new RealtimeEventBus(), provider, settings,
    { transportPlugins: registry, structuredSessions: structuredSessionsConfig });
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const resumes = () => plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume');
  return { root, db, plugin, settings, manager, resumes };
}

const conversation = (ref: string, projectSlug = project.slug) => ({
  ref, kind: 'history' as const, projectSlug, provider: 'codex' as const, title: ref,
  updatedAt: '2026-03-07T07:00:00.000Z', isBound: false, degraded: false,
});

describe('SessionManager lifecycle', () => {
  it('auto-tracks unique indexed conversations with failure isolation and separate provenance', async () => {
    const f = fixture();
    const recent = conversation('recent-external-conversation');
    const result = await f.manager.autoTrackConversations([recent, recent, conversation('missing-project-conversation', 'missing')], '2026-03-07T08:00:00.000Z');

    expect(result.attempted).toBe(2);
    expect(result.tracked).toHaveLength(1);
    expect(result.failed).toEqual([expect.objectContaining({ projectSlug: 'missing', conversationRef: 'missing-project-conversation', error: 'Project not found.' })]);
    expect(f.resumes()).toHaveLength(1);
    expect(f.db.boundSessions.getById(result.tracked[0]!.id)).toMatchObject({
      conversationRef: 'recent-external-conversation',
      resumeConversationRef: 'recent-external-conversation',
      autoTrackedAt: '2026-03-07T08:00:00.000Z',
      lastActivityAt: undefined,
      lastCompletedAt: undefined,
    });
  });

  it('keeps auto-track launch concurrency global across concurrent refresh calls', async () => {
    const f = fixture();
    let active = 0, maxActive = 0;
    const resume = FakeTransportInstance.prototype.resume;
    vi.spyOn(FakeTransportInstance.prototype, 'resume').mockImplementation(async function (this: FakeTransportInstance, ...args) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        return await resume.apply(this, args);
      } finally { active -= 1; }
    });

    await Promise.all([
      f.manager.autoTrackConversations([conversation('first'), conversation('second')], '2026-03-07T08:00:00.000Z'),
      f.manager.autoTrackConversations([conversation('third'), conversation('fourth')], '2026-03-07T08:00:00.000Z'),
    ]);

    expect(f.resumes()).toHaveLength(4);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('coalesces concurrent binds for the same provider conversation', async () => {
    const f = fixture();
    const input = { project, provider, conversationRef: 'concurrent-bind', title: 'Concurrent bind', kind: 'history' as const };
    const [first, second] = await Promise.all([
      f.manager.bindConversation(input),
      f.manager.bindConversation({ ...input, autoTrackedAt: '2026-03-07T08:00:00.000Z' }),
    ]);

    expect(first.id).toBe(second.id);
    expect(second.autoTrackedAt).toBe('2026-03-07T08:00:00.000Z');
    expect(f.db.boundSessions.getById(first.id)?.autoTrackedAt).toBe('2026-03-07T08:00:00.000Z');
    expect(f.resumes()).toHaveLength(1);
  });

  it('keeps repeated restore failures from refreshing session recency or duplicating status lines', async () => {
    const f = fixture();
    const session = await f.manager.bindConversation({ project, provider, conversationRef: 'history-restore-failure', title: 'Restore failure', kind: 'history' });
    // The provider loses the conversation, and every later instance refuses to resume it.
    await f.plugin.instance!.dispose('restart');
    await settle();
    const create = f.plugin.create.bind(f.plugin);
    f.plugin.create = (config, context) => { const instance = create(config, context); instance.failResume = true; return instance; };
    const eventLog = () => fs.readFileSync(f.db.boundSessions.getById(session.id)!.eventLogPath!, 'utf8');

    await f.manager.ensureSession(session.id);
    const firstFailure = f.db.boundSessions.getById(session.id)!;
    const firstLog = eventLog();
    expect(firstFailure.status).toBe('error');
    expect(firstLog).toContain('Failed to restore session:');

    await f.manager.ensureSession(session.id);
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(session.id)).toMatchObject({ status: 'error', updatedAt: firstFailure.updatedAt });
    expect(eventLog()).toBe(firstLog);

    f.settings.enabled = false;
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(session.id)?.updatedAt).toBe(firstFailure.updatedAt);
    expect(eventLog()).toContain('Failed to restore session: provider is disabled.');
    expect(firstFailure.lastActivityAt).toBe(session.lastActivityAt);
  });
});
