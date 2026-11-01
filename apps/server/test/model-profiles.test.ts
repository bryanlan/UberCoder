import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelProfileService,
  ModelProfilesUnavailableError,
  ROUTE_TASK_MAX_CHARS,
  fallbackDecision,
  peekSessionModelTarget,
  sessionModelTarget,
  type WoRunner,
} from '../src/model-profiles/service.js';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
const PROFILES_JSON = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: {
    high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
  } },
  claude: { provider: 'anthropic', levels: {
    high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'), low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
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
    expect(first.providers.claude.levels.low).toEqual({ model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'high', launchName: 'claude-sonnet-5-5' });
    expect(first.providers.codex.routerProvider).toBe('openai');
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
    await expect(service.entry('codex', 'high')).resolves.toMatchObject({ model: 'gpt-6-astra' });
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
    expect(peekSessionModelTarget(service, { ...claude, claudeProfile: 'low' })).toBeUndefined(); // nothing loaded yet
    expect(await sessionModelTarget(service, { ...claude, claudeProfile: 'low' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(peekSessionModelTarget(service, { ...claude, claudeProfile: 'medium' })).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
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
    const medium = { model: 'claude-opus-5-5', label: 'Claude Opus 5.5', effort: 'xhigh', launchName: 'claude-opus-5-5' };
    expect(fallbackDecision('timed out after 8 s.', medium)).toMatchObject({
      source: 'fallback', model: 'claude-opus-5-5', effort: 'xhigh', launchName: 'claude-opus-5-5',
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
    expect((await service.profiles()).providers.codex.levels.high.launchName).toBe('gpt-6-astra');
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
