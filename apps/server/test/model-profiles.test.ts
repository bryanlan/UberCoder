import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelLevelUnavailableError,
  ModelProfileService,
  ModelProfilesUnavailableError,
  ROUTE_REPLY_MAX_CHARS,
  ROUTE_TASK_MAX_CHARS,
  composeRerouteTask,
  fallbackDecision,
  peekSessionModelTarget,
  sessionModelTarget,
  type WoRunner,
} from '../src/model-profiles/service.js';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
// Grok has no Ultra or High model, so `wo profiles` lists no entry for those levels.
const PROFILES_JSON = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: {
    ultra: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), high: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'),
    medium: level('gpt-6.1-terra', 'GPT-6.1 Terra', 'high'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
  } },
  claude: { provider: 'anthropic', levels: {
    ultra: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), high: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'),
    medium: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'), low: level('claude-haiku-5-5', 'Claude Haiku 5.5', 'high'),
  } },
  grok: { provider: 'xai', levels: {
    medium: level('grok-4.7', 'Grok 4.7', 'high'), low: level('grok-4.6', 'Grok 4.6', 'medium'),
  } },
} });
const ROUTE_JSON = {
  status: 'route', role: 'implementer', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'low', launch_name: 'claude-sonnet-5-5',
  quota_state: 'on_pace', reason: 'Best implementer fit.', classifier: { status: 'ok', role_choice: 'implementer',
    role_probabilities: { implementer: 0.912, reviewer: 0.088 }, difficulty_choice: 'lighter' },
};

function runner(handlers: { profiles?: () => string | Error; route?: (args: string[]) => string | Error }): { run: WoRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: WoRunner = async (_wo, args) => {
    calls.push(args);
    const answer = args[0] === 'profiles' ? handlers.profiles?.() : handlers.route?.(args);
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? '', stderr: '' };
  };
  return { run, calls };
}

describe('model profile list', () => {
  it('loads the profiles once and reuses them while fresh', async () => {
    const { run, calls } = runner({ profiles: () => PROFILES_JSON });
    let now = 1_000;
    const service = new ModelProfileService({ profilesCacheMs: 60_000 }, run, undefined, () => now);
    const first = await service.profiles();
    expect(first.providers.claude.levels.medium).toEqual({ model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'high', launchName: 'claude-sonnet-5-5' });
    expect(Object.keys(first.providers.grok.levels)).toEqual(['medium', 'low']);
    expect(first.providers.codex.routerProvider).toBe('openai');
    expect(first.providers.vibe).toEqual({ routerProvider: 'mistral', levels: {} });
    now += 30_000;
    await service.profiles();
    expect(calls).toEqual([['profiles', '--json']]);
    now += 31_000;
    await service.profiles();
    expect(calls).toHaveLength(2);
  });

  it('shares one load between concurrent callers', async () => {
    const { run, calls } = runner({ profiles: () => PROFILES_JSON });
    const service = new ModelProfileService({}, run);
    await Promise.all([service.profiles(), service.profiles(), service.entry('codex', 'high')]);
    expect(calls).toHaveLength(1);
  });

  it('fails with a readable reason, and keeps failing until a read works', async () => {
    let answer: string | Error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    const { run, calls } = runner({ profiles: () => answer });
    const service = new ModelProfileService({ woPath: '/nowhere/wo' }, run);
    // The test suite points AGENT_CONSOLE_WO_PATH at the stand-in; the message names whichever path was used.
    await expect(service.profiles()).rejects.toThrow(/^Model profiles unavailable: wo was not found at /);
    await expect(service.entry('codex', 'high')).rejects.toBeInstanceOf(ModelProfilesUnavailableError);
    expect(calls).toHaveLength(2);
    answer = PROFILES_JSON;
    await expect(service.entry('codex', 'ultra')).resolves.toMatchObject({ model: 'gpt-6-astra' });
  });

  it('names the provider and level when a provider has no model at that level, as a kind of unavailable profile', async () => {
    const service = new ModelProfileService({}, runner({ profiles: () => PROFILES_JSON }).run);
    const missing = service.entry('grok', 'ultra');
    await expect(missing).rejects.toBeInstanceOf(ModelLevelUnavailableError);
    await expect(missing).rejects.toBeInstanceOf(ModelProfilesUnavailableError);
    await expect(service.entry('grok', 'high')).rejects.toThrow(/^Grok has no High model\.$/);
    await expect(sessionModelTarget(service, { provider: 'grok', grokProfile: 'ultra' })).rejects.toThrow('Grok has no Ultra model.');
    expect(peekSessionModelTarget(service, { provider: 'grok', grokProfile: 'ultra' })).toBeUndefined();
    // Every provider must have a Medium model: the Console falls back to it.
    const noMedium = JSON.parse(PROFILES_JSON);
    delete noMedium.profiles.grok.levels.medium;
    await expect(new ModelProfileService({}, runner({ profiles: () => JSON.stringify(noMedium) }).run).profiles()).rejects.toThrow(/unreadable answer/);
  });

  it('reports a timeout, a failed command and an unreadable answer in plain words', async () => {
    const timeout = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    const failure = Object.assign(new Error('Command failed'), { code: 1, stderr: 'noise\nwo profiles: catalog is broken\n' });
    for (const [answer, expected] of [[timeout, /timed out after 10 s$/], [failure, /catalog is broken$/], ['not json', /unreadable answer$/]] as const) {
      const { run } = runner({ profiles: () => answer });
      await expect(new ModelProfileService({}, run).profiles()).rejects.toThrow(expected);
    }
    // A catalog that lists a vendor's models under the wrong provider is refused, not guessed around.
    const swapped = JSON.stringify({ profiles: { ...JSON.parse(PROFILES_JSON).profiles, codex: { ...JSON.parse(PROFILES_JSON).profiles.claude } } });
    await expect(new ModelProfileService({}, runner({ profiles: () => swapped }).run).profiles()).rejects.toThrow(/lists anthropic models for codex/);
  });

  it('serves the last good answer when a later read fails, and logs it', async () => {
    let answer: string | Error = PROFILES_JSON;
    const { run } = runner({ profiles: () => answer });
    const warn = vi.fn();
    let now = 0;
    const service = new ModelProfileService({ profilesCacheMs: 10 }, run, { warn }, () => now);
    await service.profiles();
    answer = new Error('boom');
    now = 1_000;
    await expect(service.profiles()).resolves.toMatchObject({ providers: { codex: { routerProvider: 'openai' } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('turns a session row into the model and effort its profile means', async () => {
    const service = new ModelProfileService({}, runner({ profiles: () => PROFILES_JSON }).run);
    const claude = { provider: 'claude' as const };
    expect(await sessionModelTarget(service, { ...claude })).toBeUndefined();
    expect(peekSessionModelTarget(service, { ...claude, claudeProfile: 'medium' })).toBeUndefined(); // nothing loaded yet
    expect(await sessionModelTarget(service, { ...claude, claudeProfile: 'medium' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(peekSessionModelTarget(service, { ...claude, claudeProfile: 'high' })).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(peekSessionModelTarget(service, { ...claude, claudeProfile: 'ultra' })).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh' });
    // Auto runs on its latest decision and has no model before the first routing.
    expect(await sessionModelTarget(service, { ...claude, claudeProfile: 'auto', autoRoute: { routePending: true } })).toBeUndefined();
    expect(await sessionModelTarget(service, { ...claude, claudeProfile: 'auto', autoRoute: { routePending: false,
      decision: { source: 'router', decidedAt: 'x', launchName: 'claude-sonnet-5-5', effort: 'low' } } })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
  });
});

describe('Auto routing call', () => {
  it('sends the first 2,000 characters, the console launcher and the session provider, and reads the typed answer', async () => {
    const { run, calls } = runner({ route: () => JSON.stringify(ROUTE_JSON) });
    const service = new ModelProfileService({}, run);
    const outcome = await service.route('claude', 'x'.repeat(ROUTE_TASK_MAX_CHARS + 500));
    expect(calls[0]).toEqual(['route', '--task', 'x'.repeat(ROUTE_TASK_MAX_CHARS), '--launcher', 'console', '--provider', 'anthropic', '--json']);
    expect(outcome).toMatchObject({ ok: true, decision: {
      source: 'router', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'low', launchName: 'claude-sonnet-5-5',
      role: 'implementer', rolePercent: 91, difficulty: 'lighter', classifierStatus: 'ok', quotaState: 'on_pace', reason: 'Best implementer fit.',
    } });
    await service.route('codex', 'add a flag');
    expect(calls[1]!.slice(-3)).toEqual(['--provider', 'openai', '--json']);
  });

  it('sends the newest message so the router can see a level or thinking level the person asked for, and keeps it final', async () => {
    const asked = { ...ROUTE_JSON, role: null, model: 'claude-fable-5-1', label: 'Claude Fable 5.1', effort: 'medium', launch_name: 'claude-fable-5-1',
      level: 'ultra', level_source: 'classifier', requested_effort: 'medium', classifier: { status: 'ok', role_choice: 'implementer' },
      reason: 'Your latest message asked for the ultra level and medium thinking. Best ultra-level fit is Claude Fable 5.1.' };
    const { run, calls } = runner({ route: () => JSON.stringify(asked) });
    const service = new ModelProfileService({}, run);
    const outcome = await service.route('claude', 'new prompt\n\nreply\n\nold prompt', { latestMessage: `use ultra, medium thinking${'y'.repeat(ROUTE_TASK_MAX_CHARS)}` });
    expect(calls[0]!.slice(0, 5)).toEqual(['route', '--task', 'new prompt\n\nreply\n\nold prompt', '--latest-message', `use ultra, medium thinking${'y'.repeat(ROUTE_TASK_MAX_CHARS - 26)}`]);
    expect(outcome).toMatchObject({ ok: true, decision: { launchName: 'claude-fable-5-1', effort: 'medium', level: 'ultra', levelSource: 'classifier', requestedEffort: 'medium' } });
    expect(outcome.ok && 'role' in outcome.decision).toBe(false);
    // A blank latest message is not sent.
    await service.route('claude', 'task', { latestMessage: '   ' });
    expect(calls[1]).not.toContain('--latest-message');
  });

  it('routes by a level with no classifier call, and reports a level the vendor lacks', async () => {
    const levelRoute = { status: 'route', role: null, provider: 'openai', model: 'gpt-6-astra', label: 'GPT-6 Astra', effort: 'xhigh', launch_name: 'gpt-6-astra',
      quota_state: 'surplus', level: 'ultra', level_source: 'caller', requested_effort: null, classifier: null, reason: 'Best ultra-level fit is GPT-6 Astra.' };
    const { run, calls } = runner({ route: () => JSON.stringify(levelRoute) });
    const outcome = await new ModelProfileService({}, run).routeLevel('ultra', undefined);
    expect(calls[0]).toEqual(['route', '--level', 'ultra', '--launcher', 'console', '--json']);
    expect(outcome).toEqual({ ok: true, provider: 'codex', decision: expect.objectContaining({ launchName: 'gpt-6-astra', level: 'ultra', levelSource: 'caller' }) });
    const lacking = Object.assign(new Error('exit 4'), { code: 4, stdout: JSON.stringify({ status: 'unavailable', role: null, level: 'ultra',
      reason: 'The ultra level has no model from xAI that the console launcher can start.' }) });
    const grok = await new ModelProfileService({}, runner({ route: () => lacking }).run).routeLevel('ultra', 'grok');
    expect(grok).toEqual({ ok: false, reason: 'The ultra level has no model from xAI that the console launcher can start.' });
  });

  it('leaves out role percent and difficulty when the classifier did not answer', async () => {
    const answer = { ...ROUTE_JSON, classifier: { status: 'fallback', role_choice: null, role_probabilities: null, difficulty_choice: null } };
    const outcome = await new ModelProfileService({}, runner({ route: () => JSON.stringify(answer) }).run).route('claude', 'hi');
    expect(outcome.ok && outcome.decision).toMatchObject({ role: 'implementer', classifierStatus: 'fallback' });
    expect(outcome.ok && 'rolePercent' in outcome.decision).toBe(false);
    expect(outcome.ok && 'difficulty' in outcome.decision).toBe(false);
  });

  it('returns a failure, never throws, for a timeout, a bad exit, a bad answer and no model', async () => {
    const timeout = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    const noModel = Object.assign(new Error('exit 4'), { code: 4, stdout: JSON.stringify({ status: 'unavailable', reason: 'Every acceptable model is near its cap.' }) });
    const cases: Array<[string | Error, RegExp]> = [
      [timeout, /^timed out after 8 s$/],
      [noModel, /^Every acceptable model is near its cap\.$/],
      ['not json', /unreadable answer/],
      [JSON.stringify({ status: 'defer', reason: 'Background work waits.' }), /chose no model \(Background work waits\.\)/],
    ];
    for (const [answer, expected] of cases) {
      const outcome = await new ModelProfileService({}, runner({ route: () => answer }).run).route('claude', 'do the thing');
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.reason).toMatch(expected);
    }
    const none = await new ModelProfileService({}, runner({}).run).route('claude', '   ');
    expect(none).toEqual({ ok: false, reason: 'the message has no text to route' });
  });

  it('refuses a model from the other vendor', async () => {
    const wrong = JSON.stringify({ ...ROUTE_JSON, provider: 'openai' });
    const outcome = await new ModelProfileService({}, runner({ route: () => wrong }).run).route('claude', 'do it');
    expect(outcome).toEqual({ ok: false, reason: 'the router chose a model from openai for a claude session' });
  });

  it('builds the Medium fallback decision with a visible warning', () => {
    const medium = { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'high', launchName: 'claude-sonnet-5-5' };
    expect(fallbackDecision('timed out after 8 s.', medium)).toMatchObject({
      source: 'fallback', model: 'claude-sonnet-5-5', effort: 'high', launchName: 'claude-sonnet-5-5',
      warning: 'Auto unavailable: timed out after 8 s. Using Medium.',
    });
    const none = fallbackDecision('wo is missing', undefined);
    expect(none.warning).toBe('Auto unavailable: wo is missing. Keeping the current model.');
    expect(none.launchName).toBeUndefined();
  });
});

describe('the stand-in wo command (real subprocess path)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-wo-'));
  afterEach(() => { delete process.env.FAKE_WO_MODE; delete process.env.FAKE_WO_LOG; });

  it('runs the configured executable without a shell and reads its JSON', async () => {
    const log = path.join(root, 'calls.jsonl');
    process.env.FAKE_WO_LOG = log;
    const service = new ModelProfileService({});
    expect((await service.profiles()).providers.codex.levels.ultra?.launchName).toBe('gpt-6-astra');
    const hostile = 'fix `rm -rf /` $(whoami); echo "quoted" \'single\'';
    const outcome = await service.route('codex', hostile);
    expect(outcome).toMatchObject({ ok: true, decision: { launchName: 'gpt-6.1-terra' } });
    const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(logged[1]![2]).toBe(hostile); // arrives as one argument, unchanged
  });

  it('reports the real failures of the subprocess', async () => {
    process.env.FAKE_WO_MODE = 'fail';
    await expect(new ModelProfileService({}).profiles()).rejects.toThrow(/catalog is broken/);
    process.env.FAKE_WO_MODE = 'garbage';
    await expect(new ModelProfileService({}).profiles()).rejects.toThrow(/unreadable answer/);
    process.env.FAKE_WO_MODE = 'hang';
    const slow = new ModelProfileService({ profilesTimeoutMs: 400, routeTimeoutMs: 400 });
    await expect(slow.profiles()).rejects.toThrow(/timed out after 0\.4 s/);
    const outcome = await slow.route('claude', 'anything');
    expect(!outcome.ok && outcome.reason).toBe('timed out after 0.4 s');
    process.env.FAKE_WO_MODE = 'nomodel';
    const none = await new ModelProfileService({}).route('claude', 'anything');
    expect(!none.ok && none.reason).toBe('Every acceptable implementer model is near its weekly cap.');
  });

  it('names a missing executable', async () => {
    const saved = process.env.AGENT_CONSOLE_WO_PATH;
    delete process.env.AGENT_CONSOLE_WO_PATH;
    try {
      await expect(new ModelProfileService({ woPath: '/nonexistent/dir/wo' }).profiles()).rejects.toThrow('Model profiles unavailable: wo was not found at /nonexistent/dir/wo');
    } finally {
      process.env.AGENT_CONSOLE_WO_PATH = saved;
    }
  });
});

describe('Grok and the provider-neutral route', () => {
  const grokAnswer = { ...ROUTE_JSON, provider: 'xai', model: 'grok-4.7', label: 'Grok 4.7', effort: 'high', launch_name: 'grok-4.7', quota_state: 'unknown' };

  it('serves Grok\'s Medium and Low profiles from `wo profiles`', async () => {
    const service = new ModelProfileService({}, runner({ profiles: () => PROFILES_JSON }).run);
    const profiles = await service.profiles();
    expect(profiles.providers.grok.routerProvider).toBe('xai');
    expect(profiles.providers.grok.levels.low).toEqual({ model: 'grok-4.6', label: 'Grok 4.6', effort: 'medium', launchName: 'grok-4.6' });
    expect(await service.entry('grok', 'medium')).toMatchObject({ launchName: 'grok-4.7', effort: 'high' });
  });

  it('asks the router with no --provider when no provider is given, and says which Console provider won', async () => {
    const { run, calls } = runner({ route: () => JSON.stringify(grokAnswer) });
    const outcome = await new ModelProfileService({}, run).route(undefined, 'add a flag');
    expect(calls[0]).toEqual(['route', '--task', 'add a flag', '--launcher', 'console', '--json']);
    expect(outcome).toMatchObject({ ok: true, provider: 'grok', decision: { model: 'grok-4.7', launchName: 'grok-4.7', quotaState: 'unknown' } });
    for (const [vendor, expected] of [['openai', 'codex'], ['anthropic', 'claude'], ['xai', 'grok'], ['mistral', 'vibe']] as const) {
      const routed = await new ModelProfileService({}, runner({ route: () => JSON.stringify({ ...ROUTE_JSON, provider: vendor }) }).run).route(undefined, 'x');
      expect(routed).toMatchObject({ ok: true, provider: expected });
    }
  });

  it('passes xai for a Grok session and refuses an answer from another vendor', async () => {
    const { run, calls } = runner({ route: () => JSON.stringify({ ...ROUTE_JSON, provider: 'openai' }) });
    const outcome = await new ModelProfileService({}, run).route('grok', 'x');
    expect(calls[0]!.slice(-3)).toEqual(['--provider', 'xai', '--json']);
    expect(outcome).toEqual({ ok: false, reason: 'the router chose a model from openai for a grok session' });
  });

  it('refuses a vendor the Console has no provider for', async () => {
    const outcome = await new ModelProfileService({}, runner({ route: () => JSON.stringify({ ...ROUTE_JSON, provider: 'unknown-vendor' }) }).run).route(undefined, 'x');
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('unknown-vendor') });
  });

  it('serves Vibe Medium and Low from the optional mistral catalog block', async () => {
    const listed = JSON.parse(PROFILES_JSON) as { profiles: Record<string, unknown> };
    listed.profiles.vibe = {
      provider: 'mistral',
      levels: {
        medium: { model: 'glm-5.3', label: 'GLM 5.3', effort: 'high', launch_name: 'glm-5-3' },
        low: { model: 'glm-5.3-flash', label: 'GLM 5.3 Flash', effort: 'high', launch_name: 'zai-glm-5-3-flash' },
      },
    };
    const service = new ModelProfileService({}, runner({ profiles: () => JSON.stringify(listed) }).run);
    const profiles = await service.profiles();
    expect(profiles.providers.vibe.routerProvider).toBe('mistral');
    expect(profiles.providers.vibe.levels.medium).toEqual({ model: 'glm-5.3', label: 'GLM 5.3', effort: 'high', launchName: 'glm-5-3' });
    expect(profiles.providers.vibe.levels.low).toEqual({ model: 'glm-5.3-flash', label: 'GLM 5.3 Flash', effort: 'high', launchName: 'zai-glm-5-3-flash' });
    expect(profiles.providers.vibe.levels.ultra).toBeUndefined();
    expect(profiles.providers.vibe.levels.high).toBeUndefined();
    const wrong = JSON.parse(PROFILES_JSON) as { profiles: Record<string, unknown> };
    wrong.profiles.vibe = { provider: 'openai', levels: { medium: level('glm-5.3', 'GLM 5.3', 'high') } };
    await expect(new ModelProfileService({}, runner({ profiles: () => JSON.stringify(wrong) }).run).profiles()).rejects.toThrow(/models for vibe/);
  });

  it('uses the router\'s best alternative on a provider that can take new chats when its first choice cannot', async () => {
    const answer = { ...grokAnswer, alternatives: [
      { provider: 'xai', model: 'grok-4.6', label: 'Grok 4.6', effort: 'low', launch_name: 'grok-4.6', quota_state: 'unknown' },
      { provider: 'openai', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'high', launch_name: 'gpt-6.1-terra', quota_state: 'tight' },
    ] };
    const service = new ModelProfileService({}, runner({ route: () => JSON.stringify(answer) }).run);
    const outcome = await service.route(undefined, 'x', { acceptProvider: provider => provider !== 'grok' });
    expect(outcome).toMatchObject({ ok: true, provider: 'codex', decision: {
      model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'high', launchName: 'gpt-6.1-terra', quotaState: 'tight',
      reason: expect.stringContaining('GPT-6.1 Terra was used because Grok is not available for new chats'),
    } });
    const none = await service.route(undefined, 'x', { acceptProvider: () => false });
    expect(none).toEqual({ ok: false, reason: 'the router chose no model that a new chat can run on' });
    // The first choice is used as it is when its provider can take the chat.
    expect(await service.route(undefined, 'x', { acceptProvider: () => true })).toMatchObject({ ok: true, provider: 'grok' });
  });
});

describe('Auto decision labels and the provisional flag', () => {
  it('shows the role and difficulty the classifier read whatever its status says', async () => {
    const answer = { ...ROUTE_JSON, provisional: true, classifier: { status: 'cannot_tell', role_choice: 'implementer',
      role_probabilities: { implementer: 0.41, reviewer: 0.38 }, difficulty_choice: 'lighter' } };
    const outcome = await new ModelProfileService({}, runner({ route: () => JSON.stringify(answer) }).run).route('claude', 'hm');
    expect(outcome).toMatchObject({ ok: true, decision: { role: 'implementer', rolePercent: 41, difficulty: 'lighter', classifierStatus: 'cannot_tell', provisional: true } });
  });

  it('records provisional only when the router says so; an older router without the field means a clear result', async () => {
    const clear = await new ModelProfileService({}, runner({ route: () => JSON.stringify(ROUTE_JSON) }).run).route('claude', 'x');
    expect(clear.ok && 'provisional' in clear.decision).toBe(false);
    const explicit = await new ModelProfileService({}, runner({ route: () => JSON.stringify({ ...ROUTE_JSON, provisional: false }) }).run).route('claude', 'x');
    expect(explicit.ok && 'provisional' in explicit.decision).toBe(false);
    const provisional = await new ModelProfileService({}, runner({ route: () => JSON.stringify({ ...ROUTE_JSON, provisional: true }) }).run).route('claude', 'x');
    expect(provisional.ok && provisional.decision.provisional).toBe(true);
  });
});

describe('composeRerouteTask', () => {
  it('puts the new prompt first, then the start of the last reply, then the earlier prompt, within 2,000 characters', () => {
    const task = composeRerouteTask({ prompt: 'new question', assistantReply: 'A'.repeat(900), previousPrompt: 'earlier ask' });
    expect(task.startsWith('new question\n\n' + 'A'.repeat(ROUTE_REPLY_MAX_CHARS) + '\n\nearlier ask')).toBe(true);
    expect(task).toHaveLength('new question\n\n'.length + ROUTE_REPLY_MAX_CHARS + '\n\nearlier ask'.length);
    const long = composeRerouteTask({ prompt: 'p'.repeat(1_900), assistantReply: 'r'.repeat(400), previousPrompt: 'q'.repeat(400) });
    expect(long).toHaveLength(ROUTE_TASK_MAX_CHARS);
    expect(long.startsWith('p'.repeat(1_900))).toBe(true);
  });

  it('leaves out what is missing', () => {
    expect(composeRerouteTask({ prompt: ' only this ' })).toBe('only this');
    expect(composeRerouteTask({ prompt: 'now', previousPrompt: 'before' })).toBe('now\n\nbefore');
    expect(composeRerouteTask({ prompt: 'now', assistantReply: '   ' })).toBe('now');
  });
});
