import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileService, type WoRunner } from '../src/model-profiles/service.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { eventLogLines, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
const PROFILES = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: {
    high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
  } },
  claude: { provider: 'anthropic', levels: {
    high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'), low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
  } },
  grok: { provider: 'xai', levels: {
    high: level('grok-4.7', 'Grok 4.7', 'xhigh'), medium: level('grok-4.7', 'Grok 4.7', 'high'), low: level('grok-4.6', 'Grok 4.6', 'medium'),
  } },
} });
const routed = (model: string, label: string, effort: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  status: 'route', role: 'implementer', model, label, effort, launch_name: model, quota_state: 'on_pace',
  reason: `Best implementer fit is ${label} at ${effort} effort.`,
  classifier: { status: 'ok', role_choice: 'implementer', role_probabilities: { implementer: 0.91 }, difficulty_choice: 'lighter' }, ...extra,
});

/** A `wo` stand-in the test steers: the router's next answers, and every route call it received. */
function stubWo() {
  const routeCalls: string[][] = [];
  const answers: Array<string | Error> = [];
  const run: WoRunner = async (_wo, args) => {
    if (args[0] === 'profiles') return { stdout: PROFILES, stderr: '' };
    routeCalls.push(args);
    const next = answers.shift() ?? new Error('no route answer queued');
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: '' };
  };
  return { service: new ModelProfileService({}, run), routeCalls, answers };
}

const open: StructuredSessionFixture[] = [];
function autoFixture() {
  const wo = stubWo();
  const f = structuredSessionFixture({ manager: { modelProfiles: wo.service } });
  open.push(f);
  return { f, ...wo };
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });
const sentTurns = (f: StructuredSessionFixture, ref: string) => f.calls(ref, 'sendTurn').map(call => call.args[0] as { text: string; model?: string; effort?: string });

describe('Auto model profile on a structured session', () => {
  it('starts a session on Auto with the next message waiting to be routed, and no model chosen yet', async () => {
    const { f, routeCalls } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    expect(f.row(session.id)).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: true } });
    expect(f.row(session.id).autoRoute?.decision).toBeUndefined();
    expect(f.plugin.instance!.sessions[0]!.options.model).toBeUndefined();
    expect(routeCalls).toHaveLength(0);
    expect(f.tmuxTouched()).toBe(0);
  });

  it('routes the first message once, applies the model and effort before the turn, and records the decision', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));

    await f.manager.sendInput(session.id, 'add a --json flag to the export command');
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]).toEqual(['route', '--task', 'add a --json flag to the export command', '--launcher', 'console', '--provider', 'openai', '--json']);
    expect(sentTurns(f, session.conversationRef)).toEqual([expect.objectContaining({ text: 'add a --json flag to the export command', model: 'gpt-6.1-terra', effort: 'low' })]);
    expect(f.row(session.id)).toMatchObject({
      codexProfile: 'auto', modelProfileRequest: undefined,
      autoRoute: { routePending: false, decision: {
        source: 'router', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'low', launchName: 'gpt-6.1-terra',
        role: 'implementer', rolePercent: 91, difficulty: 'lighter', quotaState: 'on_pace', reason: 'Best implementer fit is GPT-6.1 Terra at low effort.',
      } },
    });
    expect((await f.manager.getSessionScreen(session.id))!.screen.model).toBe('gpt-6.1-terra low');
  });

  it('holds the choice: later messages are not routed again and keep the model', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendInput(session.id, 'first');
    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);
    await f.manager.sendInput(session.id, 'second');
    expect(routeCalls).toHaveLength(1);
    expect(sentTurns(f, session.conversationRef).map(turn => turn.model)).toEqual(['gpt-6.1-terra', 'gpt-6.1-terra']);
  });

  it('routes again on the next message after A is pressed again, keeping the old model until then', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendInput(session.id, 'first');
    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);

    const pressed = await f.manager.requestModelProfile(session.id, 'auto');
    expect(pressed.session).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: true, decision: { model: 'gpt-6.1-terra' } }, modelProfileRequest: undefined });
    expect(routeCalls).toHaveLength(1);

    answers.push(routed('gpt-6.1-sol', 'GPT-6.1 Sol', 'high'));
    await f.manager.sendInput(session.id, 'a much harder second task');
    expect(routeCalls).toHaveLength(2);
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: false, decision: { model: 'gpt-6.1-sol' } });
  });

  it('applies Medium and records a visible warning when the router fails, without holding the message back', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));

    await f.manager.sendInput(session.id, 'do the thing');
    expect(sentTurns(f, session.conversationRef)).toEqual([expect.objectContaining({ text: 'do the thing', model: 'gpt-6.1-sol', effort: 'xhigh' })]);
    expect(f.row(session.id)).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: false, decision: {
      source: 'fallback', model: 'gpt-6.1-sol', effort: 'xhigh', warning: 'Auto unavailable: timed out after 8 s. Using Medium.',
    } } });
    // One routing per selection of A: the failure is not retried on the next message.
    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);
    await f.manager.sendInput(session.id, 'and again');
    expect(routeCalls).toHaveLength(1);
  });

  it('applies Medium when the router answers without a model', async () => {
    const { f, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(JSON.stringify({ status: 'defer', reason: 'Background work waits.' }));
    await f.manager.sendInput(session.id, 'x');
    expect(f.row(session.id).autoRoute?.decision).toMatchObject({ source: 'fallback', model: 'gpt-6.1-sol' });
    expect(f.row(session.id).autoRoute?.decision?.warning).toMatch(/^Auto unavailable: the router chose no model.* Using Medium\.$/);
  });

  it('routes the opening prompt of a session that starts on Auto, before its first turn', async () => {
    const { f, routeCalls, answers } = autoFixture();
    answers.push(routed('gpt-6-luna', 'GPT-6 Luna', 'medium'));
    const { session } = await f.bindNew({ codexProfile: 'auto', initialPrompt: 'summarize the readme' });
    expect(routeCalls).toHaveLength(1);
    expect(sentTurns(f, session.conversationRef)).toEqual([expect.objectContaining({ text: 'summarize the readme', model: 'gpt-6-luna', effort: 'medium' })]);
    expect(f.row(session.id).autoRoute?.routePending).toBe(false);
  });

  it('routes a queued message the same way, once', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendKeystrokes(session.id, { submissionId: randomUUID(), text: 'queued task', submittedText: 'queued task', keys: ['Enter'] });
    await expect.poll(() => sentTurns(f, session.conversationRef)).toHaveLength(1);
    expect(routeCalls).toHaveLength(1);
    expect(sentTurns(f, session.conversationRef)[0]).toMatchObject({ model: 'gpt-6.1-terra', effort: 'low' });
  });

  it('does not route a message that steers a running turn, and routes the next turn instead', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendInput(session.id, 'start a turn');
    await f.manager.requestModelProfile(session.id, 'auto'); // A again while the turn runs: the next turn is routed afresh
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: true });

    await f.manager.sendInput(session.id, 'and also this');
    expect(routeCalls).toHaveLength(1);
    expect(f.calls(session.conversationRef, 'steer')).toHaveLength(1);
    expect(f.row(session.id).autoRoute?.routePending).toBe(true);

    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);
    answers.push(routed('gpt-6.1-sol', 'GPT-6.1 Sol', 'high'));
    await f.manager.sendInput(session.id, 'next turn');
    expect(routeCalls).toHaveLength(2);
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
  });
});

describe('Switching to and from Auto', () => {
  it('pressing H after Auto clears the Auto state and later messages are not routed', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendInput(session.id, 'first');
    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);

    await f.manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => f.row(session.id).codexProfile).toBe('high');
    expect(f.row(session.id).autoRoute).toBeUndefined();
    await f.manager.sendInput(session.id, 'second');
    expect(routeCalls).toHaveLength(1);
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' });
  });

  it('pressing A on a High session keeps its model until the next message is routed', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'high' });
    const pressed = await f.manager.requestModelProfile(session.id, 'auto');
    expect(pressed.session.modelProfileRequest).toMatchObject({ profile: 'auto', autoRoute: { routePending: true } });
    await expect.poll(() => f.row(session.id).codexProfile).toBe('auto');
    expect(f.row(session.id)).toMatchObject({ modelProfileRequest: undefined, autoRoute: { routePending: true } });
    expect(f.plugin.instance!.sessions[0]!.options.model).toBe('gpt-6-astra');

    answers.push(routed('gpt-6.1-terra', 'GPT-6.1 Terra', 'low'));
    await f.manager.sendInput(session.id, 'now route me');
    expect(routeCalls).toHaveLength(1);
    expect(sentTurns(f, session.conversationRef)[0]).toMatchObject({ model: 'gpt-6.1-terra', effort: 'low' });
  });

  it('refuses Auto on a session that runs in a terminal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tmux-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    try {
      const tmux = new FakeTmux();
      tmux.paneText = 'OpenAI Codex\n› \ngpt-5.6-sol medium · 98% left · ~/demo';
      const launches: Array<Parameters<typeof provider.getLaunchCommand>[3]> = [];
      const spying = { ...provider, getLaunchCommand: (...args: Parameters<typeof provider.getLaunchCommand>) => { launches.push(args[3]); return provider.getLaunchCommand(...args); } };
      const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus(), spying, providerSettings, { modelProfiles: stubWo().service });
      const session = await manager.bindConversation({
        project, provider: spying, providerSettings, conversationRef: 'history-auto-tmux', title: 'Terminal chat', kind: 'history', transport: 'tmux',
      });
      await expect(manager.requestModelProfile(session.id, 'auto')).rejects.toBeInstanceOf(SessionInputRejectedError);
      await expect(manager.requestModelProfile(session.id, 'auto')).rejects.toThrow(/structured sessions only/);
      expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
      // A new terminal-backed chat asked to start on Auto gets the default Medium profile instead.
      const fresh = await manager.bindConversation({
        project, provider: spying, providerSettings, conversationRef: 'pending:auto-tmux', title: 'New', kind: 'pending', transport: 'tmux', codexProfile: 'auto',
      });
      expect(fresh.codexProfile).toBe('medium');
      expect(launches.at(-1)).toMatchObject({ defaultTarget: { model: 'gpt-6.1-sol', effort: 'xhigh' }, profileTarget: undefined });
    } finally { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); }
  });
});

describe('Provisional Auto choices', () => {
  const provisional = (model: string, label: string, effort: string) => routed(model, label, effort, { provisional: true, classifier: { status: 'cannot_tell', role_choice: 'implementer', role_probabilities: { implementer: 0.4 }, difficulty_choice: 'lighter' } });
  const finishTurn = async (f: StructuredSessionFixture, id: string) => {
    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(id).isWorking).toBe(false);
  };

  it('records the flag, keeps the next prompt waiting to be routed, and remembers the text it saw', async () => {
    const { f, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'hmm, look at this');
    expect(sentTurns(f, session.conversationRef)[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    expect(f.row(session.id).autoRoute).toMatchObject({
      routePending: true, provisionalRoutes: 1, previousPrompt: 'hmm, look at this',
      decision: { source: 'router', provisional: true, launchName: 'gpt-6-luna', role: 'implementer', rolePercent: 40, difficulty: 'lighter', classifierStatus: 'cannot_tell' },
    });
  });

  it('routes again on the next prompt from the new prompt and the earlier one, newest first, and applies a changed model', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'first, vague');
    await finishTurn(f, session.id);

    answers.push(routed('gpt-6.1-sol', 'GPT-6.1 Sol', 'high')); // a clear answer this time
    await f.manager.sendInput(session.id, 'second, rewrite the export module');
    expect(routeCalls).toHaveLength(2);
    // The new prompt first, then the earlier one (the fixture's provider has no transcript to read a reply from).
    expect(routeCalls[1]).toEqual(['route', '--task', 'second, rewrite the export module\n\nfirst, vague', '--launcher', 'console', '--provider', 'openai', '--json']);
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ text: 'second, rewrite the export module', model: 'gpt-6.1-sol', effort: 'high' });
    expect(f.row(session.id).autoRoute).toEqual({ routePending: false, decision: expect.objectContaining({ launchName: 'gpt-6.1-sol', role: 'implementer' }) });
    expect(f.row(session.id).autoRoute?.decision).not.toHaveProperty('provisional');
    // A clear result ends the re-routing.
    await finishTurn(f, session.id);
    await f.manager.sendInput(session.id, 'third');
    expect(routeCalls).toHaveLength(2);
  });

  it('adds the start of the last assistant reply, read from the provider\'s transcript, between the two prompts', async () => {
    const wo = stubWo();
    const reply = 'I read the export module and found three problems with how it batches rows. '.repeat(20);
    const asked: string[] = [];
    const transcriptProvider = { ...provider, getConversation: async (_project: unknown, ref: string) => {
      asked.push(ref);
      return { summary: {} as never, messages: [
        { id: '1', provider: 'codex' as const, role: 'user' as const, lifecycle: 'durable' as const, text: 'first, vague', timestamp: '2026-11-01T10:00:00Z', conversationRef: ref, source: 'history-file' as const },
        { id: '2', provider: 'codex' as const, role: 'assistant' as const, lifecycle: 'durable' as const, text: reply, timestamp: '2026-11-01T10:00:05Z', conversationRef: ref, source: 'history-file' as const },
      ] };
    } };
    const f = structuredSessionFixture({ manager: { modelProfiles: wo.service }, provider: transcriptProvider });
    open.push(f);
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    wo.answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'first, vague');
    await finishTurn(f, session.id);
    wo.answers.push(routed('gpt-6.1-sol', 'GPT-6.1 Sol', 'high'));
    await f.manager.sendInput(session.id, 'now do it properly');
    const task = wo.routeCalls[1]![2]!;
    expect(task).toBe(`now do it properly\n\n${reply.trim().slice(0, 500)}\n\nfirst, vague`);
    expect(asked.at(-1)).toBe(f.row(session.id).resumeConversationRef);
  });

  it('keeps the model without a status line when the new routing picks the same one, and goes on while it stays provisional', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'one');
    await finishTurn(f, session.id);
    const statusLines = () => eventLogLines(f.row(session.id)).filter(line => line.type === 'status' && line.text.startsWith('Auto chose')).length;
    const before = statusLines();

    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'two');
    expect(routeCalls).toHaveLength(2);
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: true, provisionalRoutes: 2, previousPrompt: 'two', decision: { provisional: true } });
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    expect(statusLines()).toBe(before);
  });

  it('stops after three provisional routings, keeps the last choice and marks it final', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'one');
    await finishTurn(f, session.id);
    answers.push(provisional('gpt-6.1-terra', 'GPT-6.1 Terra', 'medium'));
    await f.manager.sendInput(session.id, 'two');
    await finishTurn(f, session.id);
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: true, provisionalRoutes: 2 });
    answers.push(provisional('gpt-6.1-sol', 'GPT-6.1 Sol', 'medium'));
    await f.manager.sendInput(session.id, 'three');
    expect(routeCalls).toHaveLength(3);
    // The third provisional answer is applied, then kept as the final choice.
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: false, decision: { launchName: 'gpt-6.1-sol', provisional: false } });
    expect(f.row(session.id).autoRoute?.provisionalRoutes).toBeUndefined();

    await finishTurn(f, session.id);
    await f.manager.sendInput(session.id, 'four');
    expect(routeCalls).toHaveLength(3);
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ model: 'gpt-6.1-sol' });
  });

  it('keeps the first guess when the router fails on a re-route, counting the attempt', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'one');
    await finishTurn(f, session.id);
    answers.push(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
    await f.manager.sendInput(session.id, 'two');
    expect(routeCalls).toHaveLength(2);
    // No drop to Medium: the message runs on the model the session has.
    expect(sentTurns(f, session.conversationRef).at(-1)).toMatchObject({ text: 'two', model: 'gpt-6-luna', effort: 'low' });
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: true, provisionalRoutes: 2, previousPrompt: 'two', decision: { source: 'router', provisional: true, launchName: 'gpt-6-luna' } });
    expect(eventLogLines(f.row(session.id)).some(line => line.type === 'status' && /Auto could not re-route \(timed out after 8 s\)\. Keeping GPT-6 Luna/.test(line.text))).toBe(true);
  });

  it('starts counting afresh when A is pressed again', async () => {
    const { f, routeCalls, answers } = autoFixture();
    const { session } = await f.bindNew({ codexProfile: 'auto' });
    answers.push(provisional('gpt-6-luna', 'GPT-6 Luna', 'low'));
    await f.manager.sendInput(session.id, 'one');
    await finishTurn(f, session.id);
    await f.manager.requestModelProfile(session.id, 'auto');
    expect(f.row(session.id).autoRoute).toMatchObject({ routePending: true, decision: { provisional: true } });
    expect(f.row(session.id).autoRoute?.provisionalRoutes).toBeUndefined();
    answers.push(routed('gpt-6.1-sol', 'GPT-6.1 Sol', 'high'));
    await f.manager.sendInput(session.id, 'two');
    // Routed from the new prompt alone: pressing A discarded the notes of the provisional run.
    expect(routeCalls[1]![2]).toBe('two');
  });
});
