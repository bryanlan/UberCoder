import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import { SessionManager, SessionInputRejectedError } from '../src/sessions/session-manager.js';
import { resolveDefaultTransport } from '../src/sessions/structured/default-transport.js';
import { FakeTmux, claudeProvider, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { FakeTransportPlugin } from './helpers/structured-fixtures.js';
import { structuredSessionsConfig, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

const bind = (f: StructuredSessionFixture, conversationRef: string, extra: { transport?: 'tmux' | 'structured'; claude?: boolean } = {}) =>
  f.manager.bindConversation({
    project, provider: extra.claude ? claudeProvider : provider, providerSettings, conversationRef, title: 'History', kind: 'history',
    ...(extra.transport ? { transport: extra.transport } : {}),
  });

describe('resolveDefaultTransport', () => {
  it('is structured only when it is the default and the provider lane is on', () => {
    expect(resolveDefaultTransport('structured', ['codex'], 'codex')).toBe('structured');
    expect(resolveDefaultTransport('structured', ['codex'], 'claude')).toBe('tmux');
    expect(resolveDefaultTransport('structured', [], 'codex')).toBe('tmux');
    expect(resolveDefaultTransport('tmux', ['codex', 'claude'], 'codex')).toBe('tmux');
  });
});

describe('A bind that names no transport', () => {
  it('gets the structured transport when it is the default and the provider lane is on', async () => {
    const f = fixture({ manager: { defaultTransport: 'structured' } });
    expect(f.manager.defaultTransportFor('codex')).toBe('structured');
    const session = await bind(f, 'native-default');
    expect(session).toMatchObject({ transport: 'structured', status: 'bound', tmuxSessionName: `structured:${session.id}` });
    expect(f.tmuxTouched()).toBe(0);
    expect(f.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe('native-default');
  });

  it('still gets tmux when tmux is the default, or when the config names no default', async () => {
    const tmuxDefault = fixture({ manager: { defaultTransport: 'tmux' } });
    expect((await bind(tmuxDefault, 'native-a')).transport).toBe('tmux');
    const unset = fixture();
    expect((await bind(unset, 'native-b')).transport).toBe('tmux');
    expect(unset.plugin.instances).toHaveLength(0);
  });

  it('can still ask for tmux explicitly while structured is the default', async () => {
    const f = fixture({ manager: { defaultTransport: 'structured' } });
    const session = await bind(f, 'native-explicit', { transport: 'tmux' });
    expect(session.transport).toBe('tmux');
    expect(f.tmux.created).toHaveLength(1);
    expect(f.plugin.instances).toHaveLength(0);
  });

  it('takes a conversation as it is bound: a tmux row that has not moved over is not refused, an explicit structured request is', async () => {
    const f = fixture({ manager: { defaultTransport: 'structured' } });
    const tmuxRow = await bind(f, 'native-bound-first', { transport: 'tmux' });
    f.tmux.paneText = 'OpenAI Codex\n› \ngpt-6.1-sol xhigh · 98% left · ~/demo';
    const again = await bind(f, 'native-bound-first');
    expect(again.id).toBe(tmuxRow.id);
    expect(f.row(tmuxRow.id).transport).toBe('tmux');
    await expect(bind(f, 'native-bound-first', { transport: 'structured' })).rejects.toBeInstanceOf(SessionInputRejectedError);
  });

  it('falls back to tmux when structured is the default but the provider lane is off, and says so once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-default-'));
    const db = new AppDatabase(path.join(root, 'state.sqlite'));
    const tmux = new FakeTmux();
    const registry = new TransportPluginRegistry();
    registry.register(new FakeTransportPlugin());
    const logger = { warn: vi.fn(), info: vi.fn() };
    const manager = new SessionManager(db, tmux, root, new RealtimeEventBus(), {
      projectService: { getProjectBySlug: async () => project, getMergedProviderSettings: () => providerSettings },
      providerRegistry: { get: () => provider },
    }, logger, {
      coordinationEnabled: true, transportPlugins: registry, defaultTransport: 'structured',
      // Codex is on; the Claude lane is off, so a Claude bind that names no transport cannot be structured.
      structuredSessions: { codex: structuredSessionsConfig.codex, claude: { ...structuredSessionsConfig.claude, enabled: false } },
    });
    cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

    expect(manager.defaultTransportFor('codex')).toBe('structured');
    expect(manager.defaultTransportFor('claude')).toBe('tmux');
    expect(manager.defaultTransportFor('claude')).toBe('tmux');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ provider: 'claude' }, expect.stringMatching(/defaultTransport.*structured.*not enabled/));
    expect(manager.enabledStructuredProviders()).toEqual(['codex']);
  });

  it('serves a Claude conversation structurally once the Claude lane is on', async () => {
    const f = fixture({
      plugin: { id: 'claude', capabilities: { processModel: 'per-session', nativeIds: 'client-allocated' } },
      manager: { defaultTransport: 'structured' },
    });
    const session = await bind(f, 'claude-native-default', { claude: true });
    expect(session).toMatchObject({ transport: 'structured', provider: 'claude' });
    expect(f.plugin.instance!.sessions[0]!.options.env).toMatchObject({ AGENT_CONSOLE_SESSION_ID: session.id });
  });
});
