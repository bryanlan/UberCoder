import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '@agent-console/shared';
import { CoordinationService } from '../src/coordination/service.js';
import { GrantService } from '../src/grants/service.js';
import { AgentSessionLaunches } from '../src/grants/session-launches.js';
import { project, providerSettings } from './helpers/session-fixtures.js';
import { eventLogLines, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: Array<{ f: StructuredSessionFixture; launches: AgentSessionLaunches }> = [];
afterEach(async () => { for (const { f, launches } of open.splice(0)) { await launches.stop(); await f.cleanup(); } });

const IDLE_CODEX_SCREEN = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';

/**
 * A granted helper launch against a Console whose default transport is structured. The planner (the launcher) is an
 * ordinary bound row with a grant recorded from its own human message, as in the tmux launch tests.
 */
async function launcher(providerId: ProviderId, options: { defaultTransport?: 'tmux' | 'structured'; disabled?: boolean } = {}) {
  let grants: GrantService | undefined;
  const f = structuredSessionFixture({
    plugin: providerId === 'claude' ? { id: 'claude', capabilities: { processModel: 'per-session', nativeIds: 'client-allocated' } } : undefined,
    disabled: options.disabled,
    manager: {
      defaultTransport: options.defaultTransport ?? 'structured',
      launchAuthorityContext: context => grants?.authorityContext(context),
      queueCodexNotice: async (_id, _settings, _cwd, prompt) => { f.tmux.sent.push(prompt); },
    },
  });
  f.tmux.paneText = IDLE_CODEX_SCREEN;
  grants = new GrantService(f.db, f.bus);
  const coordination = new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, undefined, grants);
  const native = randomUUID();
  const actor = coordination.register({ provider: providerId, nativeSessionId: native, token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
  coordination.update(actor, { description: 'Planner lead', continuation: 'unattended' });
  const lead = randomUUID();
  const log = path.join(f.root, 'lead.jsonl');
  const words = 'I authorize all planner demo work, including launch, restart and helper delegation.';
  fs.writeFileSync(log, `${JSON.stringify({ type: 'user-input', text: words, timestamp: new Date().toISOString() })}\n`);
  f.db.boundSessions.upsert({
    id: lead, provider: providerId, projectSlug: project.slug, conversationRef: native, tmuxSessionName: 'lead', status: 'bound', shouldRestore: true,
    title: 'Planner lead', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventLogPath: log,
  });
  const grant = await grants.record(actor, { grantee: { kind: 'assignment', id: actor }, scope: words, limits: { maxConcurrentSessions: 2, models: [] } }, `live:${lead}:0`);
  const launches = new AgentSessionLaunches(f.db, grants, f.manager,
    { getProjectBySlug: async slug => (slug === project.slug ? project : undefined), getMergedProviderSettings: () => providerSettings },
    { get: () => f.adapter }, f.bus, 1024 * 1024, () => 'MemAvailable: 8000000 kB');
  open.push({ f, launches });
  const launch = async (extra: { flags?: string[] } = {}) => {
    const requested = await launches.request(actor, 'launch_session', { projectSlug: project.slug, provider: providerId, prompt: 'Complete the planner lane.', title: 'Planner lane', ...extra });
    await launches.drain();
    const id = (requested as { requests: Array<{ id: string }> }).requests[0]!.id;
    return launches.status(actor, id).requests[0]!;
  };
  return { f, grant, actor, launch };
}

describe('Granted launches follow the default transport', () => {
  it.each(['codex', 'claude'] as const)('launches a %s helper on the structured transport, with its grant authority, when structured is the default', async providerId => {
    const { f, launch, actor, grant } = await launcher(providerId);
    const request = await launch();

    expect(request).toMatchObject({ status: 'completed' });
    const helper = f.row(request.sessionId);
    expect(helper).toMatchObject({
      transport: 'structured', status: 'bound', shouldRestore: true, provider: providerId, tmuxSessionName: `structured:${request.sessionId}`,
      launchContext: { launchedBy: actor, grantIds: [grant.id] },
    });
    expect(f.tmuxTouched()).toBe(0);

    const options = f.plugin.instance!.sessions.at(-1)!.options;
    expect(options.conversationId).toBe(request.sessionId);
    expect(options.appendSystemPrompt).toContain('Standing human authority supplied by the Agent Console backend');
    expect(options.appendSystemPrompt).toContain(grant.id);
    if (providerId === 'claude') {
      expect(options.env).toMatchObject({ AGENT_CONSOLE_SESSION_ID: request.sessionId });
      expect(options.consoleIdentity).toMatchObject({ sessionId: request.sessionId, runtimeDir: f.root });
    } else {
      expect(options.env).toBeUndefined();
    }
    // The opening task went through the transport as the first turn, and the journal calls it agent input.
    const turns = f.plugin.instance!.sessions.at(-1)!.calls.filter(call => call.method === 'sendTurn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.args[0]).toMatchObject({ text: expect.stringContaining('Complete the planner lane.') });
    expect(fs.readFileSync(helper.eventLogPath!, 'utf8')).toContain('"type":"agent-input"');
  });

  it('launches on tmux when tmux is the default', async () => {
    const { f, launch } = await launcher('codex', { defaultTransport: 'tmux' });
    const request = await launch();
    expect(request.status).toBe('completed');
    expect(f.row(request.sessionId).transport).toBe('tmux');
    expect(f.tmux.created).toHaveLength(1);
    expect(f.plugin.instances.flatMap(instance => instance.sessions)).toHaveLength(0);
  });

  it('falls back to tmux when structured is the default but the provider lane is off', async () => {
    const { f, launch } = await launcher('codex', { disabled: true });
    const request = await launch();
    expect(request.status).toBe('completed');
    expect(f.row(request.sessionId).transport).toBe('tmux');
    expect(f.tmux.created).toHaveLength(1);
    expect(f.plugin.instances.flatMap(instance => instance.sessions)).toHaveLength(0);
  });

  it.each(['codex', 'claude'] as const)('keeps a %s launch that carries command-line flags on tmux, with a warning and a line on the row', async providerId => {
    const { f, launch } = await launcher(providerId);
    const warn = vi.fn();
    (f.manager as unknown as { logger?: unknown }).logger = { warn, info: vi.fn() };
    const request = await launch({ flags: ['--add-dir', '/srv/shared', '--permission-mode', 'plan'] });

    expect(request.status).toBe('completed');
    const helper = f.row(request.sessionId);
    // The structured transport sends no flags, so the helper starts the old way and with them.
    expect(helper).toMatchObject({ transport: 'tmux', launchContext: { flags: ['--add-dir', '/srv/shared', '--permission-mode', 'plan'] } });
    expect(f.tmux.created).toHaveLength(1);
    expect(f.plugin.instances.flatMap(instance => instance.sessions)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ provider: providerId, sessionId: request.sessionId, flagCount: 4 }), expect.stringMatching(/flags the structured transport does not apply/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/srv/shared');
    const statuses = eventLogLines(helper).filter(line => line.type === 'status').map(line => line.text);
    expect(statuses).toContain('Started on tmux: the structured transport does not apply the launch flags this session was given.');
  });

  it('still launches a helper with no flags on the structured transport, beside one that has them', async () => {
    const { f, launch } = await launcher('codex');
    const flagged = await launch({ flags: ['--add-dir', '/srv/shared'] });
    const plain = await launch();
    expect(f.row(flagged.sessionId).transport).toBe('tmux');
    expect(f.row(plain.sessionId).transport).toBe('structured');
  });

  it('refuses to bind a conversation with flags as a structured session when structured is asked for by name', async () => {
    const f = structuredSessionFixture();
    open.push({ f, launches: { stop: async () => undefined } as AgentSessionLaunches });
    const launchContext = { launchedBy: 'a', launcherName: 'A', grantIds: [], requestId: 'r', flags: ['--add-dir', '/srv/shared'], supervisorId: 'a' };
    await expect(f.bindNew({ launchContext })).rejects.toMatchObject({ name: 'SessionInputRejectedError', message: expect.stringMatching(/do not apply launch flags/) });
    expect(f.db.boundSessions.list()).toHaveLength(0);
    expect(f.plugin.instances.flatMap(instance => instance.sessions)).toHaveLength(0);
    expect(f.tmuxTouched()).toBe(0);
  });

  it('does not move a granted tmux row with flags to the structured transport when the default flips', async () => {
    const { f } = await launcher('codex', { defaultTransport: 'tmux' });
    const flagged = await f.manager.bindConversation({
      project, provider: f.adapter, providerSettings, conversationRef: 'native-flagged', title: 'Flagged helper', kind: 'history', transport: 'tmux',
      launchContext: { launchedBy: 'a', launcherName: 'A', grantIds: [], requestId: 'r', flags: ['--add-dir', '/srv/shared'], supervisorId: 'a' },
    });
    const plain = await f.manager.bindConversation({
      project, provider: f.adapter, providerSettings, conversationRef: 'native-plain', title: 'Plain helper', kind: 'history', transport: 'tmux',
    });
    // The flip: structured becomes the default and the lane is on.
    (f.manager as unknown as { defaultTransport: string }).defaultTransport = 'structured';
    const report = await f.manager.structuredMigrationReport();
    expect(Object.fromEntries(report.rows.map(row => [row.id, row.outcome]))).toMatchObject({ [flagged.id]: 'launchFlags', [plain.id]: 'idle' });
    await f.manager.reconcileSessions();
    expect(f.row(flagged.id).transport).toBe('tmux');
    expect(f.row(plain.id).transport).toBe('structured');
  });
});
