import { afterEach, describe, expect, it } from 'vitest';
import type { FixedModelProfileKey, ProviderId } from '@agent-console/shared';
import { ModelProfileService, type WoRunner } from '../src/model-profiles/service.js';
import { StartUnavailableError, startConversation, type StartDefault } from '../src/sessions/start-conversation.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';
import { eventLogLines, structuredSessionFixture, structuredSessionsConfig, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
const PROFILES = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: { ultra: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), high: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'), medium: level('gpt-6.1-terra', 'GPT-6.1 Terra', 'high'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh') } },
  claude: { provider: 'anthropic', levels: { ultra: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), high: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'), medium: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'), low: level('claude-haiku-5-5', 'Claude Haiku 5.5', 'high') } },
  // Grok has no Ultra or High model.
  grok: { provider: 'xai', levels: { medium: level('grok-4.7', 'Grok 4.7', 'high'), low: level('grok-4.6', 'Grok 4.6', 'medium') } },
} });
const routed = (vendor: string, model: string, label: string, effort: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  status: 'route', schema_version: 2, selection_source: 'jev', provider: vendor, model, label, effort, launch_name: model, quota_state: 'tight',
  reason: `JEV selected ${label} from task demands, capability guidance and current quota.`,
  selector: { status: 'ok', choice: `${model}@${effort}`, probability: 0.94 }, ...extra,
});

/** The router's answer to `route --level`: no role, the level and who asked for it. */
const levelRouted = (vendor: string, model: string, label: string, effort: string, level: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  status: 'route', role: null, level, level_source: 'caller', provider: vendor, model, label, effort, launch_name: model, quota_state: 'on_pace',
  reason: `Best ${level}-level fit is ${label} at ${effort} effort; it is on pace for its weekly quota.`, classifier: null, ...extra,
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
    extraPlugins: [{ id: 'claude' }, { id: 'grok' }, { id: 'vibe' }],
    manager: {
      modelProfiles: wo.service,
      structuredSessions: { ...structuredSessionsConfig, grok: { enabled: grokOn, command: ['fake-grok'], idleUnloadMinutes: 60, env: {} } },
    },
  });
  open.push(f);
  const plugins: Record<ProviderId, (typeof f)['plugin']> = { codex: f.plugin, claude: f.extraPlugins[0]!, grok: f.extraPlugins[1]!, vibe: f.extraPlugins[2]! };
  const deps = {
    db: f.db,
    projectService: { getMergedProviderSettings: () => providerSettings } as never,
    providerRegistry: { get: (id: ProviderId) => ({ ...provider, id }) } as never,
    sessions: f.manager,
    modelProfiles: wo.service,
    startDefault: options.startDefault ?? { provider: 'codex', profile: 'medium' },
  };
  const turns = (id: ProviderId) => (plugins[id].instance?.sessions ?? []).flatMap(session => session.calls.filter(call => call.method === 'sendTurn').map(call => call.args[0] as { text: string; model?: string; effort?: string }));
  return {
    f, wo, deps, plugins, turns,
    start: (prompt: string) => startConversation(deps, { project, prompt }),
    startAt: (level: FixedModelProfileKey, prompt: string) => startConversation(deps, { project, prompt, level }),
  };
}

describe('Provider-neutral Start', () => {
  it('asks the router with no provider, creates the chat on the provider it picks and sends the prompt as the first turn', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high'));
    const started = await start('review the quota pacing code');

    expect(wo.routeCalls).toEqual([['route', '--task', 'review the quota pacing code', '--latest-message', 'review the quota pacing code', '--launcher', 'console', '--providers', 'openai,anthropic,xai', '--json']]);
    expect(started).toMatchObject({ provider: 'grok', conversationRef: expect.stringMatching(/^pending:/) });
    expect(started.warning).toBeUndefined();
    expect(started.session).toMatchObject({ provider: 'grok' });
    expect(f.row(started.session.id)).toMatchObject({
      provider: 'grok', grokProfile: 'auto',
      // A clear Start choice is still checked once at the session's second prompt.
      autoRoute: { routePending: true, routedPrompts: 1, previousPrompt: 'review the quota pacing code', decision: { source: 'router', model: 'grok-4.7', label: 'Grok 4.7', effort: 'high', launchName: 'grok-4.7',
        quotaState: 'tight' } },
    });
    expect(f.row(started.session.id).autoRoute?.decision).not.toHaveProperty('role');
    // The process starts on the routed model, and the prompt is the first turn on it, sent once and not routed again.
    expect(f.extraPlugins[1]!.instance!.sessions[0]!.options).toMatchObject({ model: 'grok-4.7', effort: 'high' });
    expect(turns('grok')).toEqual([expect.objectContaining({ text: 'review the quota pacing code', model: 'grok-4.7', effort: 'high' })]);
    expect(wo.routeCalls).toHaveLength(1);
    expect(turns('codex')).toEqual([]);
    expect(turns('claude')).toEqual([]);
    // The pending alias is adopted by the native conversation, and the compact decision line has what it needs.
    expect(f.db.pendingConversations.get(started.conversationRef)).toMatchObject({ provider: 'grok', title: expect.stringContaining('Grok'), rawMetadata: { adoptedConversationRef: expect.any(String) } });
    expect(eventLogLines(f.row(started.session.id)).some(line => line.type === 'status' && line.text.startsWith('Auto chose Grok 4.7, high'))).toBe(true);
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

  it('limits selection to enabled lanes and visibly rejects an out-of-scope answer', async () => {
    const { f, wo, start } = startFixture({ grok: false });
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high', { alternatives: [
      { provider: 'openai', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'high', launch_name: 'gpt-6.1-terra', quota_state: 'tight' },
    ] }));
    const started = await start('plan a migration');
    expect(started.provider).toBe('codex');
    expect(wo.routeCalls[0]).toContain('openai,anthropic');
    expect(started.warning).toContain('the router chose a model outside the enabled provider scope');
    expect(f.row(started.session.id)).toMatchObject({ codexProfile: 'medium' });
    expect(f.row(started.session.id).autoRoute).toBeUndefined();
  });

  it('falls back to the configured default with a visible warning when routing fails, and still sends the prompt', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
    const started = await start('do the thing');
    expect(started.provider).toBe('codex');
    expect(started.warning).toBe('Auto could not pick a provider (timed out after 8 s). Started on Codex Medium.');
    expect(f.row(started.session.id)).toMatchObject({ provider: 'codex', codexProfile: 'medium' });
    expect(f.row(started.session.id).autoRoute).toBeUndefined();
    expect(turns('codex')).toEqual([expect.objectContaining({ text: 'do the thing', model: 'gpt-6.1-terra', effort: 'high' })]);
    expect(eventLogLines(f.row(started.session.id)).some(line => line.type === 'status' && line.text === started.warning)).toBe(true);
  });

  it('uses the default named in config, and another enabled provider when that one has no lane', async () => {
    const claudeDefault = startFixture({ startDefault: { provider: 'claude', profile: 'low' } });
    claudeDefault.wo.answers.push(new Error('no route'));
    const low = await claudeDefault.start('x');
    expect(low).toMatchObject({ provider: 'claude', warning: expect.stringContaining('Started on Claude Low') });
    expect(claudeDefault.turns('claude')).toEqual([expect.objectContaining({ model: 'claude-haiku-5-5', effort: 'high' })]);

    const noGrok = startFixture({ grok: false, startDefault: { provider: 'grok', profile: 'high' } });
    noGrok.wo.answers.push(new Error('no route'));
    expect(await noGrok.start('x')).toMatchObject({ provider: 'codex', warning: expect.stringContaining('Started on Codex High') });
  });

  it('starts on Auto with no model chosen when the router and the model list are both unavailable', async () => {
    const { f, wo, start, turns } = startFixture({ profilesFail: true });
    wo.answers.push(new Error('no route'));
    const started = await start('hello');
    expect(started.warning).toContain('Started on Codex with its own default model');
    expect(f.row(started.session.id)).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: true, routedPrompts: 1, decision: { source: 'fallback', warning: expect.stringContaining('Auto unavailable') } } });
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

  it('checks a clear Start choice once more at the second prompt, inside the provider Start chose, and a changed model is final', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.6', 'Grok 4.6', 'low'));
    const started = await start('hi, a question about the exporter');
    const id = started.session.id;
    expect(wo.routeCalls).toHaveLength(1);
    f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(id).isWorking).toBe(false);

    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'high'));
    await f.manager.sendInput(id, 'it must stream rows');
    expect(wo.routeCalls[1]).toEqual(['route', '--task', 'it must stream rows\n\nhi, a question about the exporter', '--latest-message', 'it must stream rows', '--launcher', 'console', '--provider', 'xai', '--json']);
    expect(turns('grok').at(-1)).toMatchObject({ text: 'it must stream rows', model: 'grok-4.7', effort: 'high' });
    expect(f.row(id).autoRoute).toMatchObject({ routePending: false, decision: { launchName: 'grok-4.7' } });
    f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(id).isWorking).toBe(false);
    await f.manager.sendInput(id, 'and one more');
    expect(wo.routeCalls).toHaveLength(2);
  });

  it('re-routes a provisional Start choice on the next prompt, inside the provider Start chose', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'low', { provisional: true }));
    const started = await start('look at this');
    expect(f.row(started.session.id).autoRoute).toMatchObject({ routePending: true, routedPrompts: 1, previousPrompt: 'look at this', decision: { provisional: true } });
    // The opening prompt was not routed a second time.
    expect(wo.routeCalls).toHaveLength(1);

    f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(started.session.id).isWorking).toBe(false);
    wo.answers.push(routed('xai', 'grok-4.6', 'Grok 4.6', 'high'));
    await f.manager.sendInput(started.session.id, 'refactor the exporter');
    expect(wo.routeCalls[1]).toEqual(['route', '--task', 'refactor the exporter\n\nlook at this', '--latest-message', 'refactor the exporter', '--launcher', 'console', '--provider', 'xai', '--json']);
    expect(turns('grok').at(-1)).toMatchObject({ text: 'refactor the exporter', model: 'grok-4.6', effort: 'high' });
    expect(f.row(started.session.id).autoRoute).toMatchObject({ routePending: false, decision: { launchName: 'grok-4.6' } });
  });
});

describe('Start on a level the person picked', () => {
  it('asks the router for that level with no provider, and starts on the level\'s profile with the router\'s reason', async () => {
    const { f, wo, startAt, turns } = startFixture();
    wo.answers.push(levelRouted('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 'xhigh', 'ultra'));
    const started = await startAt('ultra', 'design the quota pacing rewrite');

    expect(wo.routeCalls).toEqual([['route', '--level', 'ultra', '--launcher', 'console', '--providers', 'openai,anthropic,xai', '--json']]);
    expect(started).toMatchObject({ provider: 'claude' });
    expect(started.warning).toBeUndefined();
    // The chat holds the level, not Auto: its next messages are not routed again.
    expect(f.row(started.session.id)).toMatchObject({ provider: 'claude', claudeProfile: 'ultra' });
    expect(f.row(started.session.id).autoRoute).toBeUndefined();
    expect(turns('claude')).toEqual([expect.objectContaining({ text: 'design the quota pacing rewrite', model: 'claude-fable-5-1', effort: 'xhigh' })]);
    expect(eventLogLines(f.row(started.session.id)).some(line => line.type === 'status' && line.text.startsWith('Ultra: Best ultra-level fit is Claude Fable 5.1'))).toBe(true);
    await f.manager.sendInput(started.session.id, 'and the tests');
    expect(wo.routeCalls).toHaveLength(1);
  });

  it('keeps the requested level and warns when the answer is outside enabled lanes', async () => {
    const { f, wo, startAt } = startFixture({ grok: false });
    wo.answers.push(levelRouted('xai', 'grok-4.7', 'Grok 4.7', 'high', 'medium', { alternatives: [
      { provider: 'openai', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'high', launch_name: 'gpt-6.1-terra', quota_state: 'on_pace' },
    ] }));
    const started = await startAt('medium', 'x');
    expect(started.provider).toBe('codex');
    expect(started.warning).toContain('the router chose a model outside the enabled provider scope');
    expect(f.row(started.session.id)).toMatchObject({ codexProfile: 'medium' });
  });

  it('starts at the level on the configured default provider, with a warning, when the router cannot answer', async () => {
    const { f, wo, startAt, turns } = startFixture({ startDefault: { provider: 'claude', profile: 'low' } });
    wo.answers.push(new Error('no route'));
    const started = await startAt('high', 'review the exporter');
    expect(started).toMatchObject({ provider: 'claude', warning: 'The router could not pick a provider for High (no route). Started on Claude High.' });
    expect(f.row(started.session.id)).toMatchObject({ claudeProfile: 'high' });
    expect(turns('claude')).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', effort: 'xhigh' })]);
  });

  it('skips a default provider that has no model at the level', async () => {
    const { wo, startAt } = startFixture({ startDefault: { provider: 'grok', profile: 'medium' } });
    wo.answers.push(new Error('no route'));
    expect(await startAt('ultra', 'x')).toMatchObject({ provider: 'codex', warning: expect.stringContaining('Started on Codex Ultra') });
  });

  it('refuses, rather than start on another level, when no startable provider has a model at the level', async () => {
    const f = structuredSessionFixture({ plugin: { id: 'grok' } });
    open.push(f);
    const wo = stubWo();
    wo.answers.push(new Error('no route'));
    const start = startConversation({
      db: f.db, projectService: { getMergedProviderSettings: (_project: unknown, id: ProviderId) => ({ ...providerSettings, enabled: id === 'grok' }) } as never,
      providerRegistry: { get: (id: ProviderId) => ({ ...provider, id }) } as never,
      sessions: { enabledStructuredProviders: () => ['grok'] } as never, modelProfiles: wo.service, startDefault: { provider: 'codex', profile: 'medium' },
    }, { project, prompt: 'x', level: 'ultra' });
    await expect(start).rejects.toThrow('No provider that can start a chat in this project offers the Ultra level (no route).');
    await expect(start).rejects.toBeInstanceOf(StartUnavailableError);
    expect(f.db.pendingConversations.list()).toEqual([]);
  });

  it('refuses when neither the router nor the model list can answer', async () => {
    const { wo, startAt } = startFixture({ profilesFail: true });
    wo.answers.push(new Error('no route'));
    await expect(startAt('low', 'x')).rejects.toBeInstanceOf(StartUnavailableError);
  });
});

describe('Grok sessions in the Console', () => {
  it('applies Medium, Low and Auto to the next turn of a Grok session, without restarting its process, and refuses Ultra and High', async () => {
    const { f, wo, start, turns } = startFixture();
    wo.answers.push(routed('xai', 'grok-4.7', 'Grok 4.7', 'low'));
    const started = await start('first');
    const id = started.session.id;
    const finish = async () => { f.extraPlugins[1]!.instance!.sessions[0]!.completeTurn(); await expect.poll(() => f.row(id).isWorking).toBe(false); };
    await finish();

    for (const profile of ['ultra', 'high'] as const) {
      await expect(f.manager.requestModelProfile(id, profile)).rejects.toThrow(`Grok has no ${profile === 'ultra' ? 'Ultra' : 'High'} model.`);
      expect(f.row(id)).toMatchObject({ grokProfile: 'auto', modelProfileRequest: undefined });
    }
    for (const [profile, model, effort] of [['medium', 'grok-4.7', 'high'], ['low', 'grok-4.6', 'medium']] as const) {
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

  it('refuses a Grok conversation with the not-enabled message while its lane is off', async () => {
    const off = startFixture({ grok: false });
    await expect(off.f.manager.bindConversation({
      project, provider: { ...provider, id: 'grok' }, conversationRef: 'pending:y', title: 'New', kind: 'pending', grokProfile: 'auto',
    })).rejects.toThrow(/not enabled/i);
  });

  it('can resume a past Grok conversation by its native id like any other structured session', async () => {
    const { f } = startFixture();
    const resumed = await f.manager.bindConversation({
      project, provider: { ...provider, id: 'grok' as const }, conversationRef: 'native-grok-session', title: 'Earlier chat', kind: 'history', grokProfile: 'medium',
    });
    expect(resumed).toMatchObject({ provider: 'grok', grokProfile: 'medium', resumeConversationRef: 'native-grok-session' });
    const calls = f.extraPlugins[1]!.instance!.calls.filter(call => call.method === 'resume');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe('native-grok-session');
    expect(calls[0]!.args[1]).toMatchObject({ model: 'grok-4.7', effort: 'high' });
  });
});
