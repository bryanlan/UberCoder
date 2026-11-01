import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId } from '@agent-console/shared';
import { ModelProfileService, type WoRunner } from '../src/model-profiles/service.js';
import { StartUnavailableError, startConversation, type StartDefault } from '../src/sessions/start-conversation.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';
import { eventLogLines, structuredSessionFixture, structuredSessionsConfig, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
const PROFILES = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: { high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh') } },
  claude: { provider: 'anthropic', levels: { high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'), low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high') } },
  grok: { provider: 'xai', levels: { high: level('grok-4.7', 'Grok 4.7', 'xhigh'), medium: level('grok-4.7', 'Grok 4.7', 'high'), low: level('grok-4.6', 'Grok 4.6', 'medium') } },
} });
const routed = (vendor: string, model: string, label: string, effort: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  status: 'route', role: 'implementer', provider: vendor, model, label, effort, launch_name: model, quota_state: 'tight',
  reason: `Best implementer fit is ${label}.`,
  classifier: { status: 'ok', role_choice: 'implementer', role_probabilities: { implementer: 0.72 }, difficulty_choice: 'lighter' }, ...extra,
});

function stubWo(options: { profilesFail?: boolean } = {}) {
  const routeCalls: string[][] = [];
  const answers: Array<string | Error> = [];
  const run: WoRunner = async (_wo, args) => {
    if (args[0] === 'profiles') {
      if (options.profilesFail) throw new Error('wo profiles failed');
      return { stdout: PROFILES, stderr: '' };
    }
    routeCalls.push(args);
    const next = answers.shift() ?? new Error('no route answer queued');
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: '' };
  };
  return { service: new ModelProfileService({}, run), routeCalls, answers };
}

const open: StructuredSessionFixture[] = [];
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** A Console with the Codex, Claude and Grok lanes (Grok's optional), all served by fake transports. */
function startFixture(options: { grok?: boolean; profilesFail?: boolean; startDefault?: StartDefault } = {}) {
  const wo = stubWo({ profilesFail: options.profilesFail });
  const grokOn = options.grok !== false;
  const f = structuredSessionFixture({
    plugin: { id: 'codex' },
    extraPlugins: [{ id: 'claude' }, { id: 'grok' }],
    manager: {
      modelProfiles: wo.service,
      structuredSessions: { ...structuredSessionsConfig, grok: { enabled: grokOn, command: ['fake-grok'], idleUnloadMinutes: 60, env: {} } },
    },
  });
  open.push(f);
  const plugins: Record<ProviderId, (typeof f)['plugin']> = { codex: f.plugin, claude: f.extraPlugins[0]!, grok: f.extraPlugins[1]! };
  const deps = {
    db: f.db,
    projectService: { getMergedProviderSettings: () => providerSettings } as never,
    providerRegistry: { get: (id: ProviderId) => ({ ...provider, id }) } as never,
    sessions: f.manager,
    modelProfiles: wo.service,
    startDefault: options.startDefault ?? { provider: 'codex', profile: 'medium' },
  };
  const turns = (id: ProviderId) => (plugins[id].instance?.sessions ?? []).flatMap(session => session.calls.filter(call => call.method === 'sendTurn').map(call => call.args[0] as { text: string; model?: string; effort?: string }));
  return { f, wo, deps, plugins, turns, start: (prompt: string) => startConversation(deps, { project, prompt }) };
}

describe('Provider-neutral Start', () => {
  it('asks the router with no provider, creates the chat on the provider it picks and sends the prompt as the first turn', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high'));
    const started = await start('review the quota pacing code');

    expect(wo.routeCalls).toEqual([['route', '--task', 'review the quota pacing code', '--launcher', 'console', '--json']]);
    expect(started).toMatchObject({ provider: 'grok', conversationRef: expect.stringMatching(/^pending:/) });
    expect(started.warning).toBeUndefined();
    expect(started.session).toMatchObject({ provider: 'grok', transport: 'structured' });
    expect(f.row(started.session.id)).toMatchObject({
      provider: 'grok', grokProfile: 'auto', transport: 'structured',
      autoRoute: { routePending: false, decision: { source: 'router', model: 'grok-4.7', label: 'Grok 4.7', effort: 'high', launchName: 'grok-4.7',
        role: 'implementer', rolePercent: 72, difficulty: 'lighter', quotaState: 'tight' } },
    });
    // The process starts on the routed model, and the prompt is the first turn on it, sent once and not routed again.
    expect(f.extraPlugins[1]!.instance!.sessions[0]!.options).toMatchObject({ model: 'grok-4.7', effort: 'high' });
    expect(turns('grok')).toEqual([expect.objectContaining({ text: 'review the quota pacing code', model: 'grok-4.7', effort: 'high' })]);
    expect(wo.routeCalls).toHaveLength(1);
    expect(turns('codex')).toEqual([]);
    expect(turns('claude')).toEqual([]);
    // The pending alias is adopted by the native conversation, and the compact decision line has what it needs.
    expect(f.db.pendingConversations.get(started.conversationRef)).toMatchObject({ provider: 'grok', title: expect.stringContaining('Grok'), rawMetadata: { adoptedConversationRef: expect.any(String) } });
    expect(eventLogLines(f.row(started.session.id)).some(line => line.type === 'status' && line.text.startsWith('Auto chose Grok 4.7, high'))).toBe(true);
    expect(f.tmuxTouched()).toBe(0);
  });

  it('maps the router\'s vendors to Codex and Claude', async () => {
    for (const [vendor, model, label, expected] of [['openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', 'codex'], ['anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'claude']] as const) {
      const { f, wo, start } = startFixture();
      wo.answers.push(routed(vendor, model, label, 'medium'));
      const started = await start('add a flag');
      expect(started.provider).toBe(expected);
      expect(f.row(started.session.id)).toMatchObject({ provider: expected, [`${expected}Profile`]: 'auto', autoRoute: { decision: { launchName: model } } });
    }
  });

  it('uses the router\'s best alternative when the provider it prefers has no lane', async () => {
    const { f, wo, start } = startFixture({ grok: false });
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high', { alternatives: [
      { provider: 'openai', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'high', launch_name: 'gpt-6.1-terra', quota_state: 'tight' },
    ] }));
    const started = await start('plan a migration');
    expect(started.provider).toBe('codex');
    expect(f.row(started.session.id).autoRoute?.decision).toMatchObject({ launchName: 'gpt-6.1-terra', reason: expect.stringContaining('Grok is not available for new chats') });
  });

  it('falls back to the configured default with a visible warning when routing fails, and still sends the prompt', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
    const started = await start('do the thing');
    expect(started.provider).toBe('codex');
    expect(started.warning).toBe('Auto could not pick a provider (timed out after 8 s). Started on Codex Medium.');
    expect(f.row(started.session.id)).toMatchObject({ provider: 'codex', codexProfile: 'medium' });
    expect(f.row(started.session.id).autoRoute).toBeUndefined();
    expect(turns('codex')).toEqual([expect.objectContaining({ text: 'do the thing', model: 'gpt-6.1-sol', effort: 'xhigh' })]);
    expect(eventLogLines(f.row(started.session.id)).some(line => line.type === 'status' && line.text === started.warning)).toBe(true);
  });

  it('uses the default named in config, and another enabled provider when that one has no lane', async () => {
    const claudeDefault = startFixture({ startDefault: { provider: 'claude', profile: 'low' } });
    claudeDefault.wo.answers.push(new Error('no route'));
    const low = await claudeDefault.start('x');
    expect(low).toMatchObject({ provider: 'claude', warning: expect.stringContaining('Started on Claude Low') });
    expect(claudeDefault.turns('claude')).toEqual([expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'high' })]);

    const noGrok = startFixture({ grok: false, startDefault: { provider: 'grok', profile: 'high' } });
    noGrok.wo.answers.push(new Error('no route'));
    expect(await noGrok.start('x')).toMatchObject({ provider: 'codex', warning: expect.stringContaining('Started on Codex High') });
  });

  it('starts on Auto with no model chosen when the router and the model list are both unavailable', async () => {
    const { f, wo, start, turns } = startFixture({ profilesFail: true });
    wo.answers.push(new Error('no route'));
    const started = await start('hello');
    expect(started.warning).toContain('Started on Codex with its own default model');
    expect(f.row(started.session.id)).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: false, decision: { source: 'fallback', warning: expect.stringContaining('Auto unavailable') } } });
    expect(turns('codex')).toEqual([expect.objectContaining({ text: 'hello' })]);
    expect(turns('codex')[0]!.model).toBeUndefined();
  });

  it('refuses when no provider can start a chat in the project', async () => {
    const f = structuredSessionFixture({ disabled: true });
    open.push(f);
    await expect(startConversation({
      db: f.db, projectService: { getMergedProviderSettings: () => providerSettings } as never, providerRegistry: { get: () => provider } as never,
      sessions: f.manager, modelProfiles: stubWo().service, startDefault: { provider: 'codex', profile: 'medium' },
    }, { project, prompt: 'x' })).rejects.toBeInstanceOf(StartUnavailableError);
    expect(f.db.pendingConversations.list()).toEqual([]);
  });

  it('leaves no pending chat behind when the bind fails', async () => {
    const { f, wo, start } = startFixture();
    wo.answers.push(routed('openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', 'high'));
    (f.plugin as unknown as { create: (...args: unknown[]) => unknown }).create = () => { throw new Error('plugin cannot start'); };
    await expect(start('x')).rejects.toThrow();
    expect(f.db.pendingConversations.list()).toEqual([]);
  });

  it('re-routes a provisional Start choice on the next prompt, inside the provider Start chose', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'low', { provisional: true }));
    const started = await start('look at this');
    expect(f.row(started.session.id).autoRoute).toMatchObject({ routePending: true, provisionalRoutes: 1, previousPrompt: 'look at this', decision: { provisional: true } });
    // The opening prompt was not routed a second time.
    expect(wo.routeCalls).toHaveLength(1);

    f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(started.session.id).isWorking).toBe(false);
    wo.answers.push(routed('xai', 'grok-4.6', 'Grok 4.6', 'high'));
    await f.manager.sendInput(started.session.id, 'refactor the exporter');
    expect(wo.routeCalls[1]).toEqual(['route', '--task', 'refactor the exporter\n\nlook at this', '--launcher', 'console', '--provider', 'xai', '--json']);
    expect(turns('grok').at(-1)).toMatchObject({ text: 'refactor the exporter', model: 'grok-4.6', effort: 'high' });
    expect(f.row(started.session.id).autoRoute).toMatchObject({ routePending: false, decision: { launchName: 'grok-4.6' } });
  });
});

describe('Grok sessions in the Console', () => {
  it('applies High, Medium, Low and Auto to the next turn of a Grok session, without restarting its process', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'low'));
    const started = await start('first');
    const id = started.session.id;
    const finish = async () => { f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn(); await expect.poll(() => f.row(id).isWorking).toBe(false); };
    await finish();

    for (const [profile, model, effort] of [['high', 'grok-4.7', 'xhigh'], ['medium', 'grok-4.7', 'high'], ['low', 'grok-4.6', 'medium']] as const) {
      await f.manager.requestModelProfile(id, profile);
      await expect.poll(() => f.row(id).grokProfile).toBe(profile);
      expect(f.row(id)).toMatchObject({ modelProfileRequest: undefined, autoRoute: undefined });
      await f.manager.sendInput(id, `use ${profile}`);
      expect(turns('grok').at(-1)).toMatchObject({ text: `use ${profile}`, model, effort });
      await finish();
    }
    expect(f.extraPlugins[1]!.instances).toHaveLength(1);
    expect(f.extraPlugins[1]!.instance!.sessions).toHaveLength(1); // the same process throughout

    // Auto again: the next message is routed afresh, inside xai.
    await f.manager.requestModelProfile(id, 'auto');
    await expect.poll(() => f.row(id).grokProfile).toBe('auto');
    expect(f.row(id).autoRoute).toMatchObject({ routePending: true });
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high'));
    await f.manager.sendInput(id, 'and a harder one');
    expect(wo.routeCalls.at(-1)!.slice(-3)).toEqual(['--provider', 'xai', '--json']);
    expect(turns('grok').at(-1)).toMatchObject({ model: 'grok-4.7', effort: 'high' });
  });

  it('never gives a Grok conversation a terminal', async () => {
    const { f } = startFixture();
    await expect(f.manager.bindConversation({
      project, provider: { ...provider, id: 'grok' }, providerSettings, conversationRef: 'pending:x', title: 'New', kind: 'pending', transport: 'tmux',
    })).rejects.toThrow('Grok runs on the structured transport only.');
    expect(f.tmuxTouched()).toBe(0);

    const off = startFixture({ grok: false });
    await expect(off.f.manager.bindConversation({
      project, provider: { ...provider, id: 'grok' }, providerSettings, conversationRef: 'pending:y', title: 'New', kind: 'pending', grokProfile: 'auto',
    })).rejects.toThrow(/not enabled/i);
    expect(off.f.tmuxTouched()).toBe(0);
  });

  it('can resume a past Grok conversation by its native id like any other structured session', async () => {
    const { f } = startFixture();
    const resumed = await f.manager.bindConversation({
      project, provider: { ...provider, id: 'grok' as const }, providerSettings, conversationRef: 'native-grok-session', title: 'Earlier chat', kind: 'history', transport: 'structured', grokProfile: 'medium',
    });
    expect(resumed).toMatchObject({ provider: 'grok', transport: 'structured', grokProfile: 'medium', resumeConversationRef: 'native-grok-session' });
    const calls = f.extraPlugins[1]!.instance!.calls.filter(call => call.method === 'resume');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe('native-grok-session');
    expect(calls[0]!.args[1]).toMatchObject({ model: 'grok-4.7', effort: 'high' });
  });
});
