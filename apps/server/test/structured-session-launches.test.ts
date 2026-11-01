import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId } from '@agent-console/shared';
import { CoordinationService } from '../src/coordination/service.js';
import { GrantService } from '../src/grants/service.js';
import { AgentSessionLaunches } from '../src/grants/session-launches.js';
import { grantAgentSchema } from '../src/grants/schema.js';
import { project, providerSettings } from './helpers/session-fixtures.js';
import { structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: Array<{ f: StructuredSessionFixture; launches: AgentSessionLaunches }> = [];
afterEach(async () => { for (const { f, launches } of open.splice(0)) { await launches.stop(); await f.cleanup(); } });

/**
 * A granted helper launch. The planner (the launcher) is an ordinary bound row with a grant recorded from its own human message.
 */
async function launcher(providerId: ProviderId, options: { disabled?: boolean } = {}) {
  let grants: GrantService | undefined;
  const f = structuredSessionFixture({
    plugin: providerId === 'claude' ? { id: 'claude', capabilities: { processModel: 'per-session', nativeIds: 'client-allocated' } } : undefined,
    disabled: options.disabled,
    manager: {
      launchAuthorityContext: context => grants?.authorityContext(context),
    },
  });
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
    id: lead, provider: providerId, projectSlug: project.slug, conversationRef: native, status: 'bound', shouldRestore: true,
    title: 'Planner lead', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventLogPath: log,
  });
  const grant = await grants.record(actor, { grantee: { kind: 'assignment', id: actor }, scope: words, limits: { maxConcurrentSessions: 2, models: [] } }, `live:${lead}:0`);
  const launches = new AgentSessionLaunches(f.db, grants, f.manager,
    { getProjectBySlug: async slug => (slug === project.slug ? project : undefined), getMergedProviderSettings: () => providerSettings },
    { get: () => f.adapter }, f.bus, 1024 * 1024, () => 'MemAvailable: 8000000 kB');
  open.push({ f, launches });
  const launch = async () => {
    const requested = await launches.request(actor, 'launch_session', { projectSlug: project.slug, provider: providerId, prompt: 'Complete the planner lane.', title: 'Planner lane' });
    await launches.drain();
    const id = (requested as { requests: Array<{ id: string }> }).requests[0]!.id;
    return launches.status(actor, id).requests[0]!;
  };
  return { f, grant, actor, launch };
}

describe('Granted launches', () => {
  it.each(['codex', 'claude'] as const)('launches a %s helper on the structured transport, with its grant authority', async providerId => {
    const { f, launch, actor, grant } = await launcher(providerId);
    const request = await launch();

    expect(request).toMatchObject({ status: 'completed' });
    const helper = f.row(request.sessionId);
    expect(helper).toMatchObject({
      status: 'bound', shouldRestore: true, provider: providerId, launchContext: { launchedBy: actor, grantIds: [grant.id] },
    });

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

  it('fails a launch whose provider lane is off, and starts nothing', async () => {
    const { f, launch } = await launcher('codex', { disabled: true });
    const request = await launch();
    expect(request).toMatchObject({ status: 'failed', reason: expect.stringMatching(/not enabled for codex/) });
    expect(f.plugin.instances.flatMap(instance => instance.sessions)).toHaveLength(0);
  });
});

describe('Launch flags', () => {
  const base = { action: 'launch', assignmentId: randomUUID(), token: 'x'.repeat(32), projectSlug: 'demo', provider: 'codex', prompt: 'Work.' };

  it('accepts a launch request with no flags or an empty list, as existing callers send', () => {
    expect(grantAgentSchema.safeParse(base).success).toBe(true);
    expect(grantAgentSchema.safeParse({ ...base, flags: [] }).success).toBe(true);
  });

  it('refuses a launch request that carries a flag, saying the structured transport takes none', () => {
    const parsed = grantAgentSchema.safeParse({ ...base, flags: ['--add-dir', '/srv/shared'] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/Launch flags are not supported/);
  });
});
