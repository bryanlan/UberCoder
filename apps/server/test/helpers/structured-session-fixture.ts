import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BoundSession, ConversationSummary, SessionEvent } from '@agent-console/shared';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { AppDatabase } from '../../src/db/database.js';
import { RealtimeEventBus } from '../../src/realtime/event-bus.js';
import { TransportPluginRegistry } from '../../src/providers/transport/registry.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './session-fixtures.js';
import { FakeTransportPlugin, type FakeTransportPluginOptions, type FakeTransportSession } from './structured-fixtures.js';

export const structuredSessionsConfig = {
  codex: { enabled: true, command: ['fake-codex', 'app-server'], idleUnloadMinutes: 60, env: {} },
  claude: { enabled: true, command: ['fake-claude'], idleUnloadMinutes: 60, env: {} },
};

export interface StructuredSessionFixtureOptions {
  /** The main plugin; its `id` ('codex' by default, or 'claude') decides which provider the bind helpers use. */
  plugin?: FakeTransportPluginOptions;
  /** More plugins registered beside the main one (for example a Claude plugin beside the Codex one). */
  extraPlugins?: FakeTransportPluginOptions[];
  manager?: Parameters<typeof createRecoveryManager>[6];
  /** Leave the structured lane off to prove binds are refused. */
  disabled?: boolean;
  /** The provider adapter the manager sees (for example one with a run monitor over a rollout file). */
  provider?: ProviderAdapter;
}

/** Everything a structured-session test needs: a database, a FakeTmux that must stay untouched, and a fake plugin. */
export function structuredSessionFixture(options: StructuredSessionFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-session-'));
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const tmux = new FakeTmux();
  const plugin = new FakeTransportPlugin(options.plugin);
  const extraPlugins = (options.extraPlugins ?? []).map(extra => new FakeTransportPlugin(extra));
  const registry = new TransportPluginRegistry();
  registry.register(plugin);
  for (const extra of extraPlugins) registry.register(extra);
  const providerId: 'codex' | 'claude' = plugin.id === 'claude' ? 'claude' : 'codex';
  const adapter = options.provider ?? (providerId === 'claude' ? claudeProvider : provider);
  const providerName = providerId === 'claude' ? 'Claude' : 'Codex';
  const bus = new RealtimeEventBus();
  const events: SessionEvent[] = [];
  bus.subscribe((event) => { events.push(event); });
  const manager = createRecoveryManager(db, tmux, root, bus, adapter, providerSettings, {
    transportPlugins: registry,
    structuredSessions: options.disabled ? undefined : structuredSessionsConfig,
    ...options.manager,
  });

  /** New chat the way the route does it: the pending alias row exists before the bind. */
  const bindNew = async (extra: Partial<Parameters<typeof manager.bindConversation>[0]> = {}) => {
    const pendingRef = `pending:${randomUUID()}`;
    const now = new Date().toISOString();
    const pending: ConversationSummary = {
      ref: pendingRef, kind: 'pending', projectSlug: project.slug, provider: providerId, title: `New ${providerName} conversation`,
      createdAt: now, updatedAt: now, isBound: false, degraded: false, rawMetadata: { pending: true },
    };
    db.pendingConversations.put(pending);
    const session = await manager.bindConversation({
      project, provider: adapter, providerSettings, conversationRef: pendingRef, title: pending.title, kind: 'pending', transport: 'structured', ...extra,
    });
    return { session, pendingRef };
  };

  const bindHistory = (conversationRef: string, extra: Partial<Parameters<typeof manager.bindConversation>[0]> = {}) =>
    manager.bindConversation({
      project, provider: adapter, providerSettings, conversationRef, title: 'History', kind: 'history', transport: 'structured', ...extra,
    });

  const row = (id: string): BoundSession => db.boundSessions.getById(id)!;
  /** The FakeTransportSession currently serving a bound row. */
  const thread = (nativeSessionId: string): FakeTransportSession =>
    [...plugin.instances.flatMap(instance => instance.sessions)].reverse().find(session => session.nativeSessionId === nativeSessionId)!;
  const calls = (nativeSessionId: string, method?: string) =>
    thread(nativeSessionId).calls.filter(call => !method || call.method === method);
  const eventTypes = () => events.map(event => event.type);

  const tmuxTouched = () => tmux.created.length + tmux.sent.length + tmux.pasted.length + tmux.sentKeys.length
    + tmux.options.length + tmux.pipedToFiles.length + tmux.captureStartLines.length + tmux.windowSizeChecks.length;

  const restarted: Array<{ manager: typeof manager; plugin: FakeTransportPlugin; tmux: FakeTmux }> = [];
  /**
   * A new backend process over the same database: fresh plugin instances, fresh tmux fake, no loaded threads. `survivors`
   * names the provider processes that outlived the old backend behind their session hosts (native id -> pid).
   */
  const restartBackend = async (restart: { survivors?: Record<string, number> } = {}) => {
    await manager.stop();
    const nextPlugin = new FakeTransportPlugin({ ...options.plugin, ...(restart.survivors ? { survivors: restart.survivors } : {}) });
    const nextRegistry = new TransportPluginRegistry();
    nextRegistry.register(nextPlugin);
    for (const extra of options.extraPlugins ?? []) nextRegistry.register(new FakeTransportPlugin(extra));
    const nextTmux = new FakeTmux();
    const nextManager = createRecoveryManager(db, nextTmux, root, bus, adapter, providerSettings, {
      transportPlugins: nextRegistry, structuredSessions: structuredSessionsConfig, ...options.manager,
    });
    const next = { manager: nextManager, plugin: nextPlugin, tmux: nextTmux };
    restarted.push(next);
    return next;
  };

  const cleanup = async () => {
    await manager.stop();
    for (const next of restarted) await next.manager.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { root, db, tmux, plugin, extraPlugins, providerId, adapter, registry, bus, events, manager, restartBackend, bindNew, bindHistory, row, thread, calls, eventTypes, tmuxTouched, cleanup };
}

export type StructuredSessionFixture = ReturnType<typeof structuredSessionFixture>;

/** Let queued microtasks and the plugin event loop run. */
export async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

export function eventLogLines(session: BoundSession): Array<{ type: string; text: string }> {
  if (!session.eventLogPath || !fs.existsSync(session.eventLogPath)) return [];
  return fs.readFileSync(session.eventLogPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; text: string });
}
