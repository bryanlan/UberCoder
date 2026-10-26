import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppServerCommand,
  buildAppServerEnv,
  expandHome,
  type CodexAppServerInstance,
} from '../src/providers/transport/codex/app-server-instance.js';
import {
  buildTurnStartParams,
  declinedServerRequest,
  itemKind,
  itemTitle,
  sandboxPolicyFor,
} from '../src/providers/transport/codex/app-server-session.js';
import {
  classifyCodexFailure,
  codexErrorInfoCode,
  codexExhaustionHttpStatus,
  codexUsageLimitError,
  mergeTurnErrors,
  parseCodexRetryProgress,
  TurnAlreadyCompletedError,
} from '../src/providers/transport/codex/errors.js';
import {
  JsonRpcClient,
  JsonRpcExitError,
  JsonRpcReplyError,
  JsonRpcRequestError,
  JsonRpcTimeoutError,
  LineSplitter,
  type JsonRpcExit,
  type JsonRpcNotification,
} from '../src/providers/transport/codex/jsonrpc.js';
import type { CodexThreadTokenUsage, CodexTurnError } from '../src/providers/transport/codex/protocol.js';
import { redactCodexProtocolValue, redactFreeText } from '../src/providers/transport/codex/redact.js';
import {
  accumulateTurnTokenUsage,
  completeTurnTokenUsage,
  contextFill,
  makeTurnTokenUsageState,
  mergeRateLimits,
  rateLimitsToWindows,
  usageLimitResetAt,
} from '../src/providers/transport/codex/usage.js';
import { PreviousTurnActiveError, ResumeFailedError, TransportUnavailableError, type TransportEvent, type TransportSession } from '../src/providers/transport/types.js';
import {
  agentMessageItem,
  baseHandlers,
  commandItem,
  EventLog,
  FAKE_APP_SERVER,
  FAST_TIMINGS,
  itemCompleted,
  itemStarted,
  makeContext,
  makeTempDir,
  notification,
  OPEN_OPTIONS,
  rateLimitSnapshot,
  rateLimitsRead,
  readLog,
  receivedFrames,
  receivedRequests,
  serverRequest,
  setupFake,
  setupReplay,
  sleep,
  threadResult,
  tokenUsage,
  turnCompleted,
  turnObject,
  turnStarted,
  userMessageItem,
  waitUntil,
  writeScenario,
  type FakeSetup,
} from './helpers/codex-harness.js';
import { createCodexAppServerPlugin } from '../src/providers/transport/codex/index.js';

vi.setConfig({ testTimeout: 20_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

function track<T extends FakeSetup>(setup: T): T {
  cleanups.push(async () => {
    await setup.instance.dispose('shutdown');
    fs.rmSync(setup.dir, { recursive: true, force: true });
  });
  return setup;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const THREAD = 'thread-1';
const TURN = 'turn-1';

/** A scenario whose `turn/start` answers with a queued turn (`startedAt: null`) and then plays `after`. */
function turnScenario(after: unknown[], extra: Record<string, unknown> = {}, turnStartExtra: Record<string, unknown> = {}) {
  return {
    handlers: {
      ...baseHandlers(THREAD),
      'turn/start': { result: { turn: turnObject(TURN, 'inProgress', null) }, emitAfter: after, ...turnStartExtra },
      ...extra,
    },
  };
}

function turnTerminals(log: EventLog) {
  return log.of('turn.terminal');
}

// ---------------------------------------------------------------------------------------------------------
describe('codex failure classification', () => {
  const failed = (codexErrorInfo: unknown, message = 'The turn failed', additionalDetails: string | null = null): CodexTurnError => ({
    message,
    codexErrorInfo: codexErrorInfo as CodexTurnError['codexErrorInfo'],
    additionalDetails,
  });

  it('maps overload and server errors to retryable provider errors with the codes RunRecovery retries', () => {
    expect(classifyCodexFailure(failed('serverOverloaded', 'Selected model is at capacity'))).toEqual({
      class: 'provider_error',
      code: 'server_overloaded',
      message: 'Selected model is at capacity',
      retryable: true,
    });
    expect(classifyCodexFailure(failed('internalServerError'))).toMatchObject({ class: 'provider_error', code: 'server_unavailable', retryable: true });
  });

  it('maps usage limits, including retry exhaustion on 429, and fills resetAt from the rate-limit snapshot', () => {
    const snapshot = { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_900_500_000 } };
    const resetAt = new Date(1_900_000_000 * 1000).toISOString();
    expect(classifyCodexFailure(failed('usageLimitExceeded'), snapshot)).toMatchObject({ class: 'usage_limit', code: 'usageLimitExceeded', resetAt, retryable: false });
    expect(classifyCodexFailure(failed('rateLimitExceeded'), snapshot)).toMatchObject({ class: 'usage_limit', resetAt });
    expect(classifyCodexFailure(failed({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }), snapshot)).toMatchObject({ class: 'usage_limit', code: 'responseTooManyFailedAttempts', resetAt });
    // Without a snapshot the class is still right; the reset time is simply unknown.
    expect(classifyCodexFailure(failed('usageLimitExceeded'))).not.toHaveProperty('resetAt');
    // Exhaustion on any other status is a provider problem, not a quota.
    expect(classifyCodexFailure(failed({ responseTooManyFailedAttempts: { httpStatusCode: 503 } }))).toMatchObject({ class: 'provider_error', code: 'responseTooManyFailedAttempts' });
  });

  it('maps permission, validation and transport codes and falls back to unknown', () => {
    for (const code of ['unauthorized', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials']) {
      expect(classifyCodexFailure(failed(code))).toMatchObject({ class: 'permission_error', code });
    }
    for (const code of ['contextWindowExceeded', 'badRequest']) {
      expect(classifyCodexFailure(failed(code))).toMatchObject({ class: 'validation_error', code });
    }
    expect(classifyCodexFailure(failed({ httpConnectionFailed: { httpStatusCode: null } }))).toMatchObject({ class: 'transport_error', code: 'httpConnectionFailed', retryable: true });
    expect(classifyCodexFailure(failed({ responseStreamDisconnected: { httpStatusCode: null } }))).toMatchObject({ class: 'transport_error', code: 'responseStreamDisconnected' });
    expect(classifyCodexFailure(failed('sandboxError'))).toMatchObject({ class: 'unknown', code: 'sandboxError' });
    expect(classifyCodexFailure(failed('other'))).toEqual({ class: 'unknown', message: 'The turn failed' });
    expect(classifyCodexFailure(null)).toMatchObject({ class: 'unknown', message: 'The Codex turn failed.' });
  });

  it('prefers additionalDetails and redacts credentials in the message', () => {
    const failure = classifyCodexFailure(failed('serverOverloaded', 'short', 'Authorization failed for Bearer abcdefghijklmnop and token=hunter2hunter2'));
    expect(failure.message).toContain('Bearer [REDACTED]');
    expect(failure.message).not.toContain('hunter2hunter2');
  });

  it('merges the willRetry:false notification with the failed completion', () => {
    const notificationError = failed('serverOverloaded', 'capacity', 'richer details');
    expect(mergeTurnErrors(failed('serverOverloaded', 'capacity'), notificationError)?.additionalDetails).toBe('richer details');
    // A different explicit code on the completion decides.
    expect(mergeTurnErrors(failed('badRequest'), notificationError)?.codexErrorInfo).toBe('badRequest');
    expect(mergeTurnErrors(null, notificationError)).toBe(notificationError);
    expect(mergeTurnErrors(failed('badRequest'), null)?.codexErrorInfo).toBe('badRequest');
  });

  it('keeps the copied T3 helpers behaving as the originals', () => {
    expect(parseCodexRetryProgress('Reconnecting... 2/5')).toEqual({ attempt: 2, maxAttempts: 5 });
    expect(parseCodexRetryProgress('no progress here')).toBeNull();
    expect(parseCodexRetryProgress('0/5')).toBeNull();
    expect(codexErrorInfoCode('serverOverloaded')).toBe('serverOverloaded');
    expect(codexErrorInfoCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe('httpConnectionFailed');
    expect(codexErrorInfoCode(null)).toBeNull();
    expect(codexExhaustionHttpStatus({ responseTooManyFailedAttempts: { httpStatusCode: 429 } })).toBe(429);
    expect(codexExhaustionHttpStatus('serverOverloaded')).toBeNull();
    expect(codexUsageLimitError('usageLimitExceeded', null)).toBe(true);
    expect(codexUsageLimitError('other', { responseTooManyFailedAttempts: { httpStatusCode: 429 } })).toBe(true);
    expect(codexUsageLimitError('other', null)).toBe(false);
  });
});

describe('codex usage', () => {
  it('merges partial rate-limit updates and ignores model-specific buckets', () => {
    const first = { limitId: 'codex', planType: 'pro', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_900_500_000 } };
    const merged = mergeRateLimits(first, { limitId: 'codex', primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_900_000_000 } });
    expect(merged?.secondary).toEqual(first.secondary); // omitted field keeps its earlier value
    expect(merged?.primary?.usedPercent).toBe(55);
    expect(mergeRateLimits(merged, { limitId: 'codex_spark', primary: { usedPercent: 99 } })).toBe(merged);
    expect(mergeRateLimits(merged, { limitId: 'codex', secondary: null })?.secondary).toBeNull(); // explicit null clears
    expect(mergeRateLimits(undefined, first)).toBe(first);
  });

  it('turns a snapshot into windows, with fallback durations when the CLI omits them', () => {
    expect(rateLimitsToWindows({ limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 10, windowDurationMins: 10_080 } })).toEqual([
      { id: 'primary', kind: 'session', label: 'Session', usedPercent: 40, windowDurationMins: 300, resetsAt: new Date(1_900_000_000_000).toISOString() },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 10, windowDurationMins: 10_080 },
    ]);
    expect(rateLimitsToWindows({ primary: { usedPercent: 5 }, secondary: { usedPercent: 6 } }).map((window) => window.kind)).toEqual(['session', 'weekly']);
    expect(rateLimitsToWindows({ planType: 'free', primary: { usedPercent: 5 } }).map((window) => window.kind)).toEqual(['monthly']);
    expect(rateLimitsToWindows({ limitId: 'codex_spark', primary: { usedPercent: 5 } })).toEqual([]);
    expect(rateLimitsToWindows({ primary: { usedPercent: 250 } })[0]?.usedPercent).toBe(100);
  });

  it('resets only after every exhausted window has reset', () => {
    const snapshot = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_900_500_000 } };
    expect(usageLimitResetAt(snapshot)).toBe(new Date(1_900_500_000_000).toISOString());
    expect(usageLimitResetAt({ primary: { usedPercent: 99, resetsAt: 1_900_000_000 } })).toBeNull();
    expect(usageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(usageLimitResetAt(undefined)).toBeNull();
  });

  it('computes context fill from the newest request, not the running total', () => {
    const usage = { total: { totalTokens: 900_000 }, last: { totalTokens: 129_200 }, modelContextWindow: 258_400 } as CodexThreadTokenUsage;
    expect(contextFill(usage)).toEqual({ usedTokens: 129_200, maxTokens: 258_400, fraction: 0.5 });
    expect(contextFill({ ...usage, modelContextWindow: null })).toEqual({ usedTokens: 129_200, maxTokens: null, fraction: null });
  });

  it('accumulates per-turn token usage from thread-wide totals', () => {
    const breakdown = (input: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
    const usage = (total: [number, number], last: [number, number]): CodexThreadTokenUsage => ({ total: breakdown(...total), last: breakdown(...last), modelContextWindow: 1000 });
    const state = makeTurnTokenUsageState();
    accumulateTurnTokenUsage(state, 'turn-0', usage([100, 10], [100, 10])); // not the active turn: only moves the baseline
    state.activeTurnId = 'turn-1';
    accumulateTurnTokenUsage(state, 'turn-1', usage([160, 30], [60, 20]));
    accumulateTurnTokenUsage(state, 'turn-1', usage([220, 45], [60, 15]));
    expect(completeTurnTokenUsage(state, 'turn-1', true)).toMatchObject({ usageStatus: 'complete', inputTokens: 120, outputTokens: 35 });
    expect(completeTurnTokenUsage(state, 'turn-1', true)).toEqual({ usageStatus: 'unavailable' });
  });
});

describe('codex protocol redaction', () => {
  it('redacts sensitive keys, bearer values and JSON embedded in strings', () => {
    expect(redactCodexProtocolValue({ Authorization: 'Bearer abc', nested: { api_key: 'k', ok: 1 }, list: [{ refreshToken: 'x' }], text: 'Bearer abc.def' })).toEqual({
      Authorization: '[REDACTED]',
      nested: { api_key: '[REDACTED]', ok: 1 },
      list: [{ refreshToken: '[REDACTED]' }],
      text: '[REDACTED]',
    });
    expect(redactCodexProtocolValue('{"password":"p","fine":"v"}')).toBe('{"password":"[REDACTED]","fine":"v"}');
    expect(redactCodexProtocolValue('plain text')).toBe('plain text');
  });

  it('redacts credentials in free text and bounds its length', () => {
    expect(redactFreeText('Bearer sk-abcdefghijklmnopqrstuvwxyz and api_key=abcdef123456')).toBe('Bearer [REDACTED] and api_key=[REDACTED]');
    expect(redactFreeText('x'.repeat(50), 10)).toBe('xxxxxxxxxx...');
  });
});

describe('codex JSON line splitter', () => {
  it('splits across chunk boundaries, strips carriage returns and keeps multibyte characters whole', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(1024, (line) => lines.push(line), () => undefined);
    const encoded = Buffer.from('{"a":"héllo"}\r\n{"b":2}\n\n{"c":3}', 'utf8');
    const cut = encoded.indexOf(Buffer.from('é')) + 1; // inside the two-byte character
    splitter.push(encoded.subarray(0, cut));
    splitter.push(encoded.subarray(cut, cut + 9));
    splitter.push(encoded.subarray(cut + 9));
    splitter.end();
    expect(lines).toEqual(['{"a":"héllo"}', '{"b":2}', '', '{"c":3}']);
  });

  it('reports a line above the cap once and stops', () => {
    const lines: string[] = [];
    const overflow: number[] = [];
    const splitter = new LineSplitter(10, (line) => lines.push(line), (bytes) => overflow.push(bytes));
    splitter.push(Buffer.from('short\n12345'));
    splitter.push(Buffer.from('678901\nnever'));
    splitter.push(Buffer.from('seen\n'));
    expect(lines).toEqual(['short']);
    expect(overflow).toHaveLength(1);
    expect(splitter.overflowed).toBe(true);
  });
});

describe('codex request building', () => {
  const policy = { approvals: 'never', sandbox: 'full-access' } as const;

  it('builds turn/start exactly as the plan states', () => {
    expect(buildTurnStartParams('t1', { text: 'hello', model: 'gpt-x', effort: 'high' }, policy, '/work', 'msg-1')).toEqual({
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }],
      clientUserMessageId: 'msg-1',
      model: 'gpt-x',
      effort: 'high',
      summary: 'detailed',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    const bare = buildTurnStartParams('t1', { text: 'hello' }, policy, '/work', 'msg-2');
    expect(bare).not.toHaveProperty('model');
    expect(bare).not.toHaveProperty('effort');
    expect(() => buildTurnStartParams('t1', { text: 'x', images: [{ path: '/a.png', mimeType: 'image/png' }] }, policy, '/work', 'm')).toThrow(/image/);
  });

  it('maps the other sandbox policies', () => {
    expect(sandboxPolicyFor({ approvals: 'on-request', sandbox: 'read-only' }, '/w')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(sandboxPolicyFor({ approvals: 'on-request', sandbox: 'workspace-write' }, '/w')).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/w'] });
  });

  it('builds the child environment and command', () => {
    const env = buildAppServerEnv({ PATH: '/bin', CODEX_HOME: '~/alt-codex', AGENT_CONSOLE_SESSION_ID: 'stale', CODEX_THREAD_ID: 'stale' }, '/home/tester');
    expect(env).toMatchObject({ PATH: '/bin', CODEX_HOME: '/home/tester/alt-codex', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'agent_console' });
    expect(env).not.toHaveProperty('AGENT_CONSOLE_SESSION_ID');
    expect(env).not.toHaveProperty('CODEX_THREAD_ID');
    expect(buildAppServerEnv({}, '/h')).not.toHaveProperty('CODEX_HOME');
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('/abs', '/h')).toBe('/abs');
    expect(buildAppServerCommand(['codex', 'app-server'])).toEqual(['codex', 'app-server', '-c', 'check_for_update_on_startup=false']);
  });

  it('maps items to event kinds and answers every server request kind with a decline', () => {
    expect(itemKind({ type: 'agentMessage' } as never)).toBe('assistant');
    expect(itemKind({ type: 'reasoning' } as never)).toBe('reasoning');
    expect(itemKind(commandItem('c', 'p') as never)).toBe('command');
    expect(itemKind({ type: 'fileChange' } as never)).toBe('file_change');
    expect(itemKind({ type: 'mcpToolCall' } as never)).toBe('mcp');
    expect(itemKind({ type: 'webSearch' } as never)).toBe('search');
    expect(itemKind({ type: 'plan' } as never)).toBe('other');
    expect(itemTitle(userMessageItem('u', 'x') as never)).toBe('userMessage');
    expect(itemTitle(commandItem('c', 'p', 'inProgress', 'curl -H "Authorization: Bearer abcdefghijklmnop" x') as never)).toContain('Bearer [REDACTED]');
    expect(declinedServerRequest('item/permissions/requestApproval', {}).result).toEqual({ permissions: {}, scope: 'turn' });
    expect(declinedServerRequest('item/fileChange/requestApproval', {}).result).toEqual({ decision: 'decline' });
    expect(() => declinedServerRequest('item/tool/call', {})).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('codex JSON-RPC client over a fake app-server', () => {
  async function spawnClient(scenario: Record<string, unknown>, options: Partial<Parameters<typeof JsonRpcClient.spawn>[0]> = {}) {
    const dir = makeTempDir('codex-rpc-');
    const { scenarioPath, logFile } = writeScenario(dir, scenario);
    const client = await JsonRpcClient.spawn({ command: [process.execPath, FAKE_APP_SERVER, scenarioPath], cwd: dir, env: { PATH: process.env.PATH }, closeGraceMs: 300, termGraceMs: 300, ...options });
    cleanups.push(async () => {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { client, dir, logFile };
  }

  async function handshake(client: JsonRpcClient) {
    await client.request('initialize', { clientInfo: { name: 't', title: null, version: '1' }, capabilities: null });
    client.notify('initialized');
  }

  it('numbers requests from 1, routes responses by id and errors by shape', async () => {
    const { client, logFile } = await spawnClient({ handlers: { echo: { result: { echoed: '{{params.value}}' } }, broken: { error: { code: -32602, message: 'bad params' } } } });
    await handshake(client);
    await expect(client.request('echo', { value: 'a' })).resolves.toEqual({ echoed: 'a' });
    await expect(client.request('broken', {})).rejects.toMatchObject({ name: 'JsonRpcRequestError', code: -32602, message: 'bad params', method: 'broken' });
    await expect(client.request('nope', {})).rejects.toBeInstanceOf(JsonRpcRequestError);
    expect(receivedFrames(logFile).filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([1, 2, 3, 4]);
  });

  it('routes notifications, server requests and responses by shape, in order', async () => {
    const { client, logFile } = await spawnClient({
      afterInitialize: [notification('first', { n: 1 }), serverRequest('known/request', { q: 1 }), notification('second', { n: 2 })],
    });
    const seen: string[] = [];
    client.onNotification((n: JsonRpcNotification) => seen.push(`${n.method}:${n.emittedAtMs}`));
    client.handleRequest('known/request', (params) => {
      seen.push('request');
      return { answered: params };
    });
    await handshake(client);
    await waitUntil(() => readLog(logFile).some((entry) => entry.response), 5000, 'the answer to the server request');
    expect(seen).toEqual(['first:1790000000000', 'request', 'second:1790000000000']);
    expect(readLog(logFile).find((entry) => entry.response)?.response).toEqual({ id: 0, result: { answered: { q: 1 } } });
  });

  it('answers every server request: unknown methods get -32601, failing handlers -32603, reply errors keep their code', async () => {
    const { client, logFile } = await spawnClient({
      afterInitialize: [serverRequest('mystery/method', {}), serverRequest('throws/error', {}), serverRequest('replies/error', {}), serverRequest('async/handler', {})],
    });
    client.handleRequest('throws/error', () => {
      throw new Error('boom');
    });
    client.handleRequest('replies/error', () => {
      throw new JsonRpcReplyError(-32001, 'busy', { retry: true });
    });
    client.handleRequest('async/handler', async () => {
      await sleep(20);
      return { late: true };
    });
    await handshake(client);
    const responses = await waitUntil(() => {
      const found = readLog(logFile).filter((entry) => entry.response);
      return found.length === 4 ? found.map((entry) => entry.response!) : undefined;
    }, 5000, 'four answers');
    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(byId.get(0)).toMatchObject({ error: { code: -32601 } });
    expect(byId.get(1)).toMatchObject({ error: { code: -32603, message: 'Internal error: boom' } });
    expect(byId.get(2)).toMatchObject({ error: { code: -32001, message: 'busy', data: { retry: true } } });
    expect(byId.get(3)).toEqual({ id: 3, result: { late: true } });
  });

  it('reassembles very large lines and strips carriage returns', async () => {
    const { client } = await spawnClient({ afterInitialize: [{ bigLineBytes: 600_000 }, { raw: '{"method":"crlf","params":{"ok":true}}\r' }] });
    const received: JsonRpcNotification[] = [];
    client.onNotification((n) => received.push(n));
    await handshake(client);
    await waitUntil(() => received.length === 2, 5000, 'two notifications');
    expect(received[0]?.method).toBe('big/notification');
    expect((received[0]?.params as { data: string }).data).toHaveLength(600_000);
    expect(received[1]).toEqual({ method: 'crlf', params: { ok: true } });
  });

  it('fails the connection when a line exceeds the cap', async () => {
    const { client } = await spawnClient({ handlers: { hang: { noResponse: true } }, afterInitialize: [{ delayMs: 50, bigLineBytes: 5_000 }] }, { maxLineBytes: 1_000 });
    const exits: JsonRpcExit[] = [];
    client.onExit((exit) => exits.push(exit));
    await handshake(client);
    const pending = client.request('hang', {}, { timeoutMs: 5000 });
    await expect(pending).rejects.toBeInstanceOf(JsonRpcExitError);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.error?.message).toMatch(/exceeded the line limit/);
    expect(client.exited).toBe(true);
    await expect(client.request('after', {})).rejects.toBeInstanceOf(JsonRpcExitError);
  });

  it('times out a request that never answers and ignores its late answer', async () => {
    const { client } = await spawnClient({ handlers: { slow: { delayMs: 200, result: { late: true } } } });
    await handshake(client);
    await expect(client.request('slow', {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(JsonRpcTimeoutError);
    await sleep(250); // the late answer arrives and must not throw
    await expect(client.request('slow', {}, { timeoutMs: 2000 })).resolves.toEqual({ late: true });
  });

  it('rejects every pending request with the exit error and emits exit { code, signal }', async () => {
    const { client } = await spawnClient({
      stderr: '\u001b[31mERROR\u001b[0m something broke\n',
      handlers: { hang: { noResponse: true, emitAfter: [{ delayMs: 80, exit: { code: 7 } }] } },
    });
    const exits: JsonRpcExit[] = [];
    client.onExit((exit) => exits.push(exit));
    await handshake(client);
    const first = client.request('hang', {}, { timeoutMs: 5000 });
    const second = client.request('hang', {}, { timeoutMs: 5000 });
    const [one, two] = await Promise.allSettled([first, second]);
    for (const outcome of [one, two]) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(JsonRpcExitError);
      expect((outcome as PromiseRejectedResult).reason.exit).toMatchObject({ code: 7, signal: null, expected: false });
    }
    expect(exits).toEqual([expect.objectContaining({ code: 7, signal: null, expected: false })]);
    expect(exits[0]?.stderrTail).toContain('ERROR something broke'); // colour codes removed
    expect(client.exitInfo?.code).toBe(7);
  });

  it('keeps only the last 64 KiB of stderr', async () => {
    const { client } = await spawnClient({ afterInitialize: [{ stderr: 'a'.repeat(100_000) }, { delayMs: 30, stderr: 'TAIL-MARKER' }] });
    await handshake(client);
    await waitUntil(() => client.stderrTail().endsWith('TAIL-MARKER'), 5000, 'stderr');
    const tail = client.stderrTail();
    expect(tail.length).toBe(64 * 1024);
    expect(tail.endsWith('TAIL-MARKER')).toBe(true);
  });

  it('close() ends stdin first, then SIGTERM, then SIGKILL', async () => {
    const { client, logFile } = await spawnClient({ ignoreStdinEof: true, ignoreSigterm: true });
    await handshake(client);
    await client.close();
    const events = readLog(logFile).filter((entry) => entry.dir === 'event').map((entry) => entry.event);
    expect(events).toEqual(['start', 'stdin-eof', 'sigterm']);
    expect(client.exitInfo).toMatchObject({ signal: 'SIGKILL', expected: true });
  });

  it('close() stops at stdin EOF when the process exits on its own', async () => {
    const { client, logFile } = await spawnClient({});
    await handshake(client);
    await client.close();
    expect(readLog(logFile).filter((entry) => entry.dir === 'event').map((entry) => entry.event)).toEqual(['start', 'stdin-eof']);
    expect(client.exitInfo).toMatchObject({ code: 0, signal: null, expected: true });
  });

  it('fails to start a missing binary with a spawn error', async () => {
    await expect(JsonRpcClient.spawn({ command: ['/nonexistent/codex-binary'], cwd: os.tmpdir(), env: {} })).rejects.toMatchObject({ name: 'JsonRpcSpawnError' });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('codex instance and session against a scripted app-server', () => {
  it('handshakes with the reader running first, accepts notifications before initialized, and records the instance', async () => {
    const fake = track(
      setupFake(
        {
          version: '0.164.0',
          afterInitialize: [notification('configWarning', { summary: 'ignored setting', details: null }), notification('account/updated', { authMode: 'chatgpt', planType: 'pro' })],
          handlers: baseHandlers(THREAD),
        },
        undefined,
        { CODEX_HOME: '~/alt-codex-home', AGENT_CONSOLE_SESSION_ID: 'stale-session', CODEX_THREAD_ID: 'stale-thread' },
      ),
    );
    expect(await fake.instance.alive()).toEqual({ connected: false }); // nothing starts until first use
    const session = await fake.instance.start(OPEN_OPTIONS);

    const frames = receivedFrames(fake.logFile);
    expect(frames[0]).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent_console', title: 'Agent Console', version: '9.9.9' },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['turn/diff/updated'] },
      },
    });
    expect(frames[1]).toEqual({ method: 'initialized' });
    expect(fake.context.logs.info.some(([fields]) => (fields as { summary?: string }).summary === 'ignored setting')).toBe(true);

    const started = readLog(fake.logFile).find((entry) => entry.event === 'start') as unknown as { argv: string[]; cwd: string; env: Record<string, string | null> };
    expect(started.argv.slice(1)).toEqual(['-c', 'check_for_update_on_startup=false']);
    expect(started.env).toEqual({ CODEX_HOME: path.join(os.homedir(), 'alt-codex-home'), ORIGINATOR: 'agent_console', SESSION: null, THREAD: null });
    expect(fs.realpathSync(started.cwd)).toBe(fs.realpathSync(fake.context.runtimeDir));

    const alive = await fake.instance.alive();
    expect(alive.connected).toBe(true);
    const recorded = JSON.parse(fake.context.metaStore.get('structured-instance:codex')!) as { pid: number; startedAt: string; version: string };
    expect(recorded).toMatchObject({ pid: alive.pid, version: '0.164.0' });
    expect(Number.isNaN(Date.parse(recorded.startedAt))).toBe(false);
    expect(session.nativeSessionId).toBe(THREAD);
  });

  it('treats "Already initialized" as a successful handshake', async () => {
    const fake = track(setupFake({ initializeError: { code: -32600, message: 'Already initialized' }, handlers: baseHandlers(THREAD) }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    expect(session.nativeSessionId).toBe(THREAD);
    expect(receivedFrames(fake.logFile)[1]).toEqual({ method: 'initialized' }); // still sent
  });

  it('starts a thread with the plan parameters and reports the native id, path and readiness', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD, '/rollout/thread-1.jsonl') }));
    const session = await fake.instance.start({ ...OPEN_OPTIONS, model: 'gpt-x', effort: 'high' });
    expect(session.nativeSessionId).toBe(THREAD);
    expect(session.transcriptPath).toBe('/rollout/thread-1.jsonl');
    expect(session.capabilities).toMatchObject({ processModel: 'shared', nativeIds: 'server-allocated', resume: 'reattach', steer: 'native', interrupt: 'terminal-follows', images: false, modelSwitch: 'next-turn' });
    expect(receivedRequests(fake.logFile, 'thread/start')[0]?.params).toEqual({
      cwd: '/work/project',
      model: 'gpt-x',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
      config: { model_reasoning_effort: 'high' },
      ephemeral: false,
    });
    const log = new EventLog(session);
    await waitUntil(() => log.events.length >= 2);
    expect(log.events.slice(0, 2)).toEqual([
      { type: 'session.native', nativeSessionId: THREAD, transcriptPath: '/rollout/thread-1.jsonl' },
      { type: 'session.state', state: 'ready' },
    ]);
  });

  it('runs a turn: events in order, turn/start parameters exact, early turn/started adopted once', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': {
            // turn/started arrives BEFORE the response, and the response still says the turn is queued
            emitBefore: [turnStarted(THREAD, TURN)],
            result: { turn: turnObject(TURN, 'inProgress', null) },
            emitAfter: [
              itemCompleted(THREAD, TURN, userMessageItem('item-u', 'do the thing')),
              notification('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'item-a', delta: 'ignored' }),
              itemCompleted(THREAD, TURN, { type: 'reasoning', id: 'item-r', summary: [], content: [] }),
              itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'done')),
              tokenUsage(THREAD, TURN, 129_200),
              notification('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } }),
              turnCompleted(THREAD, TURN),
            ],
          },
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'do the thing', model: 'gpt-x', effort: 'high', clientMessageId: 'msg-1' });
    expect(turnId).toBe(TURN);
    const terminal = await log.waitForType('turn.terminal');

    expect(receivedRequests(fake.logFile, 'turn/start')[0]?.params).toEqual({
      threadId: THREAD,
      input: [{ type: 'text', text: 'do the thing' }],
      clientUserMessageId: 'msg-1',
      model: 'gpt-x',
      effort: 'high',
      summary: 'detailed',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    expect(log.types()).toEqual(['session.native', 'session.state', 'turn.started', 'item.completed', 'item.completed', 'item.completed', 'usage.updated', 'turn.terminal']);
    expect(log.of('turn.started')).toEqual([{ type: 'turn.started', turnId: TURN, origin: 'user', replay: false }]);
    expect(log.of('item.completed').map((event) => [event.kind, event.title])).toEqual([['other', 'userMessage'], ['reasoning', undefined], ['assistant', undefined]]);
    expect(log.of('usage.updated').find((event) => event.contextUsedTokens !== undefined)).toEqual({ type: 'usage.updated', contextUsedTokens: 129_200, contextMaxTokens: 258_400 });
    expect(terminal).toEqual({ type: 'turn.terminal', turnId: TURN, status: 'completed', sessionUsable: true, replay: false });
  });

  it('starts the turn from the response when the response already carries a start time', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'hi')), turnStarted(THREAD, TURN), turnCompleted(THREAD, TURN)] },
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    await log.waitForType('turn.terminal');
    expect(log.types()).toEqual(['session.native', 'session.state', 'turn.started', 'item.completed', 'turn.terminal']);
    expect(log.of('turn.started')).toHaveLength(1); // the later turn/started notification did not repeat it
  });

  it('buffers events that arrive before the turn is known and replays them in order once it is adopted', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': {
            // the item and a stray repeat of the completion are written before turn/started and before the response
            emitBefore: [itemCompleted(THREAD, TURN, agentMessageItem('item-early', 'early')), turnStarted(THREAD, TURN)],
            result: { turn: turnObject(TURN, 'inProgress', null) },
            emitAfter: [turnCompleted(THREAD, TURN)],
          },
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    await log.waitForType('turn.terminal');
    expect(log.types()).toEqual(['session.native', 'session.state', 'turn.started', 'item.completed', 'turn.terminal']);
    expect(log.of('item.completed')[0]).toMatchObject({ turnId: TURN, itemId: 'item-early', kind: 'assistant' });
  });

  it('reports the server package version as the client version by default', async () => {
    const dir = makeTempDir();
    const { scenarioPath, logFile } = writeScenario(dir, { handlers: baseHandlers(THREAD) });
    const instance = createCodexAppServerPlugin({ timings: FAST_TIMINGS }).create({ enabled: true, command: [process.execPath, FAKE_APP_SERVER, scenarioPath], idleUnloadMinutes: 60 }, makeContext(path.join(dir, 'runtime')));
    cleanups.push(async () => {
      await instance.dispose('shutdown');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await instance.start(OPEN_OPTIONS);
    const expected = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
    expect(receivedFrames(logFile)[0]?.params.clientInfo).toEqual({ name: 'agent_console', title: 'Agent Console', version: expected });
  });

  it('treats a queued turn (startedAt null) as not started until turn/started, and delays an interrupt until then', async () => {
    const fake = track(
      setupFake(
        turnScenario(
          [turnStarted(THREAD, TURN, 120)],
          { 'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'interrupted', null, 20)] } },
        ),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'queued' });
    expect(log.of('turn.started')).toHaveLength(0); // the response alone did not start it
    await session.interrupt(turnId); // waits for turn/started first
    const lines = readLog(fake.logFile);
    const startedAt = lines.findIndex((entry) => entry.dir === 'out' && entry.frame?.method === 'turn/started');
    const interruptAt = lines.findIndex((entry) => entry.dir === 'in' && entry.frame?.method === 'turn/interrupt');
    expect(startedAt).toBeGreaterThan(-1);
    expect(interruptAt).toBeGreaterThan(startedAt);
    expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
  });

  it('rejects sendTurn with PreviousTurnActiveError while a turn runs, and accepts the next one after the terminal', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': [
            { result: { turn: turnObject('turn-1', 'inProgress', null) }, emitAfter: [turnStarted(THREAD, 'turn-1')] },
            { result: { turn: turnObject('turn-2', 'inProgress', null) }, emitAfter: [turnStarted(THREAD, 'turn-2'), turnCompleted(THREAD, 'turn-2', 'completed', null, 30)] },
          ],
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'one' });
    await log.waitForType('turn.started');
    await expect(session.sendTurn({ text: 'two' })).rejects.toBeInstanceOf(PreviousTurnActiveError);
    expect(receivedRequests(fake.logFile, 'turn/start')).toHaveLength(1);
  });

  it('allows the next sendTurn from inside the terminal event handler', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': [
            { result: { turn: turnObject('turn-1', 'inProgress', null) }, emitAfter: [turnStarted(THREAD, 'turn-1'), turnCompleted(THREAD, 'turn-1', 'completed', null, 30)] },
            { result: { turn: turnObject('turn-2', 'inProgress', null) }, emitAfter: [turnStarted(THREAD, 'turn-2'), turnCompleted(THREAD, 'turn-2', 'completed', null, 30)] },
          ],
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    let second: Promise<{ turnId: string }> | undefined;
    const seen: TransportEvent[] = [];
    const consumer = (async () => {
      for await (const event of session.events) {
        seen.push(event);
        if (event.type === 'turn.terminal' && event.turnId === 'turn-1') second = session.sendTurn({ text: 'two' });
      }
    })();
    await session.sendTurn({ text: 'one' });
    await waitUntil(() => second, 5000, 'the second sendTurn');
    await expect(second).resolves.toEqual({ turnId: 'turn-2' });
    await waitUntil(() => seen.filter((event) => event.type === 'turn.terminal').length === 2);
    await session.close('release');
    await consumer;
  });

  it('delivers a steer as a second user item in the same turn', async () => {
    const fake = track(
      setupFake(
        turnScenario(
          [turnStarted(THREAD, TURN)],
          {
            'turn/steer': {
              result: { turnId: '{{params.expectedTurnId}}' },
              emitAfter: [
                itemCompleted(THREAD, TURN, userMessageItem('item-u2', 'Actually, do the other thing'), 10),
                itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'steered answer')),
                turnCompleted(THREAD, TURN),
              ],
            },
          },
        ),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'first' });
    await log.waitForType('turn.started');
    await session.steer!(turnId, { text: 'Actually, do the other thing', clientMessageId: 'steer-1' });
    await log.waitForType('turn.terminal');

    expect(receivedRequests(fake.logFile, 'turn/steer')[0]?.params).toEqual({
      threadId: THREAD,
      input: [{ type: 'text', text: 'Actually, do the other thing' }],
      expectedTurnId: TURN,
      clientUserMessageId: 'steer-1',
    });
    const userItems = log.of('item.completed').filter((event) => event.title === 'userMessage');
    expect(userItems).toEqual([expect.objectContaining({ turnId: TURN, itemId: 'item-u2', kind: 'other' })]);
    expect(log.of('turn.started')).toHaveLength(1);
    expect(turnTerminals(log)).toHaveLength(1);
  });

  it('throws TurnAlreadyCompletedError when a steer loses the race to the turn finishing', async () => {
    const fake = track(
      setupFake(
        turnScenario([turnStarted(THREAD, TURN)], {
          'turn/steer': { error: { code: -32600, message: 'no active turn to steer' } },
        }),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'first' });
    await log.waitForType('turn.started');
    // The server says there is no active turn, although the completion has not reached us yet.
    await expect(session.steer!(turnId, { text: 'late' })).rejects.toMatchObject({ name: 'TurnAlreadyCompletedError', code: 'turn_already_completed', turnId });
  });

  it('throws TurnAlreadyCompletedError for a finished turn, and rethrows other steer failures', async () => {
    const fake = track(
      setupFake(
        turnScenario([turnStarted(THREAD, TURN)], {
          'turn/steer': { error: { code: -32600, message: 'cannot steer a review turn' } },
        }),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'first' });
    await log.waitForType('turn.started');
    await expect(session.steer!(turnId, { text: 'x' })).rejects.toBeInstanceOf(JsonRpcRequestError);
    await expect(session.steer!('unknown-turn', { text: 'x' })).rejects.toBeInstanceOf(TurnAlreadyCompletedError);
  });

  describe('interrupt', () => {
    it('reports the late turn/completed as interrupted, exactly once', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN)], {
            'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'interrupted', null, 80)] },
          }),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'work' });
      await log.waitForType('turn.started');
      await session.interrupt(turnId);
      expect(turnTerminals(log)).toHaveLength(0); // the request was accepted; the terminal follows as an event
      expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
      await sleep(450); // past the 300 ms grace: the watchdog must not add a second terminal
      expect(turnTerminals(log)).toHaveLength(1);
      expect(receivedRequests(fake.logFile, 'turn/interrupt')[0]?.params).toEqual({ threadId: THREAD, turnId: TURN });
    });

    it('reports a completed status as interrupted when an interrupt is in flight', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN)], {
            'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'completed', null, 30)] },
          }),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'work' });
      await log.waitForType('turn.started');
      await session.interrupt(turnId);
      expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
    });

    it('closes the turn locally as interrupted when turn/completed never arrives, and ignores a late one', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN)], {
            'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'completed', null, 700)] },
          }),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'work' });
      await log.waitForType('turn.started');
      await session.interrupt(turnId);
      const terminal = await log.waitForType('turn.terminal', 3000);
      expect(terminal).toMatchObject({ turnId: TURN, status: 'interrupted', sessionUsable: true });
      expect(log.of('notice').some((notice) => notice.level === 'warn' && /closed locally/.test(notice.text))).toBe(true);
      // Wait until the server really has sent its late completion, then check it changed nothing.
      await waitUntil(() => readLog(fake.logFile).some((entry) => entry.dir === 'out' && entry.frame?.method === 'turn/completed'), 5000, 'the late completion');
      await sleep(100);
      expect(turnTerminals(log)).toHaveLength(1);
    });

    it('terminates tracked background commands after the interrupt, using the live terminal list', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN), itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1')), itemStarted(THREAD, TURN, commandItem('cmd-2', 'proc-2')), itemStarted(THREAD, TURN, commandItem('cmd-3', 'proc-3')), itemCompleted(THREAD, TURN, commandItem('cmd-3', 'proc-3', 'completed'))], {
            'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'interrupted', null, 60)] },
            'thread/backgroundTerminals/list': { result: { data: [{ itemId: 'cmd-1', processId: 'proc-1', command: 'sleep 30', cwd: '/work/project', osPid: 1, cpuPercent: null, rssKb: null }], nextCursor: null } },
            'thread/backgroundTerminals/terminate': { result: { terminated: true } },
          }),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'run commands' });
      await log.waitFor((event) => event.type === 'item.completed');
      await session.interrupt(turnId);
      await waitUntil(() => receivedRequests(fake.logFile, 'thread/backgroundTerminals/terminate').length >= 1, 5000, 'terminate');
      await log.waitForType('turn.terminal');
      // proc-2 is not in the live list and proc-3 already completed: only proc-1 is terminated.
      expect(receivedRequests(fake.logFile, 'thread/backgroundTerminals/terminate').map((frame) => frame.params)).toEqual([{ threadId: THREAD, processId: 'proc-1' }]);
    });

    it('tries every tracked command when the terminal list is unavailable, and tolerates terminate errors', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN), itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1')), itemStarted(THREAD, TURN, commandItem('cmd-2', 'proc-2'))], {
            'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'interrupted', null, 200)] },
            // no handler for thread/backgroundTerminals/list: the fake answers -32601
            'thread/backgroundTerminals/terminate': [{ error: { code: -32600, message: 'thread not found: gone' } }, { result: { terminated: true } }],
          }),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'run commands' });
      await log.waitForType('turn.started');
      await sleep(60); // let the item/started frames land
      await session.interrupt(turnId);
      await waitUntil(() => receivedRequests(fake.logFile, 'thread/backgroundTerminals/terminate').length === 2, 5000, 'two terminate calls');
      expect(receivedRequests(fake.logFile, 'thread/backgroundTerminals/terminate').map((frame) => frame.params.processId)).toEqual(['proc-1', 'proc-2']);
      expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
    });

    it('surfaces a rejected interrupt and leaves the turn running', async () => {
      const fake = track(setupFake(turnScenario([turnStarted(THREAD, TURN)], { 'turn/interrupt': { error: { code: -32600, message: 'cannot interrupt' } } })));
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'work' });
      await log.waitForType('turn.started');
      await expect(session.interrupt(turnId)).rejects.toBeInstanceOf(JsonRpcRequestError);
      await sleep(400);
      expect(turnTerminals(log)).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('classifies serverOverloaded and merges the richer willRetry:false message', async () => {
      const error = { message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded', additionalDetails: null };
      const fake = track(
        setupFake(
          turnScenario([
            turnStarted(THREAD, TURN),
            notification('error', { error: { ...error, additionalDetails: 'Please try a different model.' }, willRetry: false, threadId: THREAD, turnId: TURN }),
            turnCompleted(THREAD, TURN, 'failed', error),
          ]),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      await session.sendTurn({ text: 'go' });
      const terminal = await log.waitForType('turn.terminal');
      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { class: 'provider_error', code: 'server_overloaded', message: 'Please try a different model.', retryable: true },
      });
    });

    it('classifies usageLimitExceeded with resetAt from the merged rate-limit snapshot', async () => {
      const fake = track(
        setupFake(
          turnScenario([
            turnStarted(THREAD, TURN),
            notification('account/rateLimits/updated', { rateLimits: rateLimitSnapshot({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 } }) }),
            turnCompleted(THREAD, TURN, 'failed', { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }),
          ]),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      await session.sendTurn({ text: 'go' });
      const terminal = await log.waitForType('turn.terminal');
      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { class: 'usage_limit', code: 'usageLimitExceeded', resetAt: new Date(1_900_000_000_000).toISOString(), retryable: false },
      });
    });

    it('classifies retry exhaustion on 429 as a usage limit', async () => {
      const fake = track(
        setupFake(
          turnScenario([turnStarted(THREAD, TURN), turnCompleted(THREAD, TURN, 'failed', { message: 'exceeded retry limit, last status: 429 Too Many Requests', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, additionalDetails: null })]),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      await session.sendTurn({ text: 'go' });
      const terminal = await log.waitForType('turn.terminal');
      expect(terminal).toMatchObject({ status: 'failed', failure: { class: 'usage_limit', code: 'responseTooManyFailedAttempts' } });
    });

    it('turns willRetry:true into a notice and keeps the turn running', async () => {
      const fake = track(
        setupFake(
          turnScenario([
            turnStarted(THREAD, TURN),
            notification('error', { error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null }, willRetry: true, threadId: THREAD, turnId: TURN }),
            notification('warning', { threadId: THREAD, message: 'Heads up' }),
            notification('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'coordination', status: 'failed', error: 'spawn failed', failureReason: null }),
            notification('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'other', status: 'ready', error: null, failureReason: null }),
          ]),
        ),
      );
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      await session.sendTurn({ text: 'go' });
      await waitUntil(() => log.of('notice').length === 3);
      expect(log.of('notice').map((notice) => [notice.level, notice.text])).toEqual([
        ['warn', 'Codex is retrying (2/5): Reconnecting... 2/5'],
        ['warn', 'Heads up'],
        ['warn', 'MCP server "coordination" failed to start: spawn failed'],
      ]);
      expect(turnTerminals(log)).toHaveLength(0);
    });

    it('emits exactly one terminal per turn even when the completion repeats', async () => {
      const fake = track(setupFake(turnScenario([turnStarted(THREAD, TURN), turnCompleted(THREAD, TURN), turnCompleted(THREAD, TURN), turnCompleted(THREAD, TURN, 'failed', { message: 'x', codexErrorInfo: null, additionalDetails: null }), turnStarted(THREAD, TURN)])));
      const session = await fake.instance.start(OPEN_OPTIONS);
      const log = new EventLog(session);
      await session.sendTurn({ text: 'go' });
      await log.waitForType('turn.terminal');
      await sleep(150);
      expect(turnTerminals(log)).toHaveLength(1);
      expect(log.of('turn.started')).toHaveLength(1);
    });
  });

  it('merges partial rate-limit updates into usage windows', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'account/rateLimits/read': { error: { code: -32600, message: 'not available' } },
          'turn/start': {
            result: { turn: turnObject(TURN, 'inProgress', null) },
            emitAfter: [
              turnStarted(THREAD, TURN),
              notification('account/rateLimits/updated', { rateLimits: rateLimitSnapshot({ primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_900_500_000 } }) }),
              // partial: only the primary window; the secondary must survive
              notification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_900_000_000 } } }),
              // a model-specific bucket must not replace the main one
              notification('account/rateLimits/updated', { rateLimits: rateLimitSnapshot({ limitId: 'codex_spark', primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_900_000_000 } }) }),
            ],
          },
        },
      }),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    await waitUntil(() => log.of('usage.updated').filter((event) => event.windows).length >= 2);
    await sleep(100);
    const updates = log.of('usage.updated').filter((event) => event.windows);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.windows).toEqual([
      { id: 'primary', usedPercent: 55, resetsAt: new Date(1_900_000_000_000).toISOString() },
      { id: 'secondary', usedPercent: 10, resetsAt: new Date(1_900_500_000_000).toISOString() },
    ]);
  });

  it('answers every server request with a decline and records request events', async () => {
    const fake = track(
      setupFake(
        turnScenario([
          turnStarted(THREAD, TURN),
          serverRequest('item/tool/requestUserInput', { threadId: THREAD, turnId: TURN, itemId: 'i1', questions: [{ id: 'q', header: 'Pick one', question: 'Strict or flexible?', isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null }),
          serverRequest('mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'gmail', mode: 'form', message: 'Allow sending?', requestedSchema: {}, _meta: null }),
          serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'i2', startedAtMs: 1, environmentId: null, command: 'rm -rf /tmp/x' }),
          serverRequest('item/fileChange/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'i3', startedAtMs: 1, reason: 'write outside the workspace' }),
          serverRequest('item/permissions/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'i4', environmentId: null, startedAtMs: 1, cwd: '/work', reason: 'needs network', permissions: { network: {}, fileSystem: null } }),
          serverRequest('item/tool/call', { threadId: THREAD, turnId: TURN }),
          serverRequest('currentTime/read', { threadId: THREAD }),
        ]),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    const responses = await waitUntil(() => {
      const found = readLog(fake.logFile).filter((entry) => entry.response);
      return found.length === 7 ? found.map((entry) => entry.response!) : undefined;
    }, 5000, 'seven answers');
    const byId = new Map(responses.map((response) => [response.id as number, response]));
    expect(byId.get(0)).toEqual({ id: 0, result: { answers: {} } });
    expect(byId.get(1)).toEqual({ id: 1, result: { action: 'decline', content: null, _meta: null } });
    expect(byId.get(2)).toEqual({ id: 2, result: { decision: 'decline' } });
    expect(byId.get(3)).toEqual({ id: 3, result: { decision: 'decline' } });
    expect(byId.get(4)).toEqual({ id: 4, result: { permissions: {}, scope: 'turn' } });
    expect(byId.get(5)).toMatchObject({ id: 5, error: { code: -32601 } }); // dynamic tool calls are not supported
    expect(byId.get(6)).toMatchObject({ id: 6, result: { currentTimeAt: expect.any(Number) } });

    const opened = log.of('request.opened');
    expect(opened.map((event) => [event.requestId, event.kind])).toEqual([['0', 'question'], ['1', 'mcp'], ['2', 'command'], ['3', 'file_change'], ['4', 'permission']]);
    expect(opened[0]?.summary).toBe('Pick one: Strict or flexible?');
    expect(log.of('request.closed')).toEqual(['0', '1', '2', '3', '4'].map((requestId) => ({ type: 'request.closed', requestId, outcome: 'declined' })));
    // respond() after the fact is accepted and changes nothing.
    await expect(session.respond('0', 'cancel')).resolves.toBeUndefined();
  });

  it('keeps subagent threads out of the parent session and still answers their requests', async () => {
    const child = 'child-thread';
    const fake = track(
      setupFake(
        turnScenario([
          turnStarted(THREAD, TURN),
          notification('thread/started', { thread: { ...(threadResult(child).thread as object), parentThreadId: THREAD } }),
          notification('turn/started', { threadId: child, turn: turnObject('child-turn', 'inProgress', 1) }),
          itemCompleted(child, 'child-turn', agentMessageItem('child-item', 'from the subagent')),
          serverRequest('item/commandExecution/requestApproval', { threadId: child, turnId: 'child-turn', itemId: 'ci', startedAtMs: 1, environmentId: null }),
          turnCompleted(child, 'child-turn'),
          notification('account/updated', { authMode: 'chatgpt', planType: 'pro' }),
          itemCompleted(THREAD, TURN, agentMessageItem('parent-item', 'parent answer')),
          turnCompleted(THREAD, TURN),
        ]),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'delegate' });
    await log.waitForType('turn.terminal');
    await waitUntil(() => fake.instance.unknownThreadFrames.serverRequests === 1);

    expect(log.events.some((event) => 'turnId' in event && event.turnId === 'child-turn')).toBe(false);
    expect(log.of('item.completed').map((event) => event.itemId)).toEqual(['parent-item']);
    expect(log.of('request.opened')).toHaveLength(0); // the child's approval is not the parent's request
    expect(log.of('turn.started')).toHaveLength(1);
    expect(turnTerminals(log).map((event) => event.turnId)).toEqual([TURN]);
    expect(fake.instance.unknownThreadFrames.notifications).toBe(4); // thread/started, turn/started, item/completed, turn/completed
    expect(fake.instance.unknownThreadFrames.serverRequests).toBe(1);
    expect(fake.instance.unknownThreadFrames.byMethod.get('item/completed')).toBe(1);
    expect(fake.context.logs.debug.some(([, message]) => /no session owns/.test(message))).toBe(true);
    const answer = readLog(fake.logFile).find((entry) => entry.response);
    expect(answer?.response).toEqual({ id: 0, result: { decision: 'decline' } });
  });

  it('ends open sessions with error then stopped when the process dies, rejects pending requests, and respawns on next use', async () => {
    const fake = track(
      setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'turn/start': { noResponse: true, emitAfter: [{ delayMs: 80, exit: { code: 3 } }] },
        },
      }),
    );
    const first = await fake.instance.start(OPEN_OPTIONS);
    const second = await fake.instance.start({ ...OPEN_OPTIONS, conversationId: 'conversation-2' });
    expect(fake.instance.openThreadIds).toEqual([THREAD]); // the fake returns the same thread id; the second session replaced the first
    const firstLog = new EventLog(first);
    const secondLog = new EventLog(second);
    const firstPid = (await fake.instance.alive()).pid;

    await expect(second.sendTurn({ text: 'never answered' })).rejects.toBeInstanceOf(TransportUnavailableError);
    await secondLog.done;
    expect(secondLog.types()).toEqual(['session.native', 'session.state', 'session.state', 'session.state']);
    const error = secondLog.events.find((event) => event.type === 'session.state' && event.state === 'error');
    expect(error).toMatchObject({ failure: { class: 'transport_error', code: 'process_exited', retryable: true } });
    expect(secondLog.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });
    // The replaced first session was ended locally when the second took over its thread id.
    await firstLog.done;
    expect(firstLog.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });

    expect(fake.instance.needsRespawn).toBe(true);
    expect(await fake.instance.alive()).toEqual({ connected: false });
    expect(fake.context.metaStore.has('structured-instance:codex')).toBe(false);

    // The replacement process reads the scenario file again: let its turn/start succeed this time.
    writeScenario(fake.dir, { handlers: { ...baseHandlers(THREAD), 'turn/start': { result: { turn: turnObject('turn-9', 'inProgress', 1) } } } });
    const third = await fake.instance.start(OPEN_OPTIONS); // lazily respawned
    expect(fake.instance.needsRespawn).toBe(false);
    const secondPid = (await fake.instance.alive()).pid;
    expect(secondPid).not.toBe(firstPid);
    expect(JSON.parse(fake.context.metaStore.get('structured-instance:codex')!).pid).toBe(secondPid);
    await expect(third.sendTurn({ text: 'works now' })).resolves.toEqual({ turnId: 'turn-9' });
  });

  it('dispose ends sessions first, then closes the process by ending stdin', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await fake.instance.dispose('shutdown');
    await log.done;
    expect(log.types()).toEqual(['session.native', 'session.state', 'session.state']);
    expect(log.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });
    expect(log.events.some((event) => event.type === 'session.state' && event.state === 'error')).toBe(false); // a planned exit is not a failure
    expect(readLog(fake.logFile).filter((entry) => entry.dir === 'event').map((entry) => entry.event)).toEqual(['start', 'stdin-eof']);
    expect(await fake.instance.alive()).toEqual({ connected: false });
    expect(fake.instance.needsRespawn).toBe(false);
    expect(fake.context.metaStore.has('structured-instance:codex')).toBe(false);
    await expect(fake.instance.start(OPEN_OPTIONS)).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('unload sends thread/unsubscribe and ends the event stream', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.unload();
    await log.done;
    expect(receivedRequests(fake.logFile, 'thread/unsubscribe')[0]?.params).toEqual({ threadId: THREAD });
    expect(log.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });
    expect(fake.instance.openThreadIds).toEqual([]);
    await expect(session.sendTurn({ text: 'after unload' })).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('ends the session when the server closes the thread, failing a turn that was still running', async () => {
    const fake = track(setupFake(turnScenario([turnStarted(THREAD, TURN), notification('thread/closed', { threadId: THREAD })])));
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    await log.done;
    expect(turnTerminals(log)).toEqual([expect.objectContaining({ turnId: TURN, status: 'failed', failure: expect.objectContaining({ class: 'transport_error', code: 'thread_closed' }) })]);
    expect(log.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });
  });

  it('close(release) unsubscribes the thread', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    const log = new EventLog(session);
    await session.close('release');
    await log.done;
    expect(receivedRequests(fake.logFile, 'thread/unsubscribe')).toHaveLength(1);
    await session.close('release'); // idempotent
    expect(receivedRequests(fake.logFile, 'thread/unsubscribe')).toHaveLength(1);
  });

  describe('resume', () => {
    it('resumes by thread id without history and with the standing policy', async () => {
      const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
      const session = await fake.instance.resume(THREAD, { ...OPEN_OPTIONS, model: 'gpt-x', effort: 'low' });
      expect(session.nativeSessionId).toBe(THREAD);
      expect(receivedRequests(fake.logFile, 'thread/resume')[0]?.params).toEqual({
        threadId: THREAD,
        excludeTurns: true,
        cwd: '/work/project',
        model: 'gpt-x',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        config: { model_reasoning_effort: 'low' },
      });
      const log = new EventLog(session);
      await waitUntil(() => log.events.length >= 2);
      expect(log.events[1]).toEqual({ type: 'session.state', state: 'ready' });
    });

    it('unarchives an archived thread and retries once', async () => {
      const archived = { error: { code: -32600, message: `session ${THREAD} is archived; run codex unarchive` } };
      const fake = track(
        setupFake({
          handlers: {
            ...baseHandlers(THREAD),
            'thread/resume': [archived, { result: { ...threadResult(THREAD), turnsBackwardsCursor: null, itemsBackwardsCursor: null } }],
            'thread/unarchive': { result: threadResult(THREAD) },
          },
        }),
      );
      const session = await fake.instance.resume(THREAD, OPEN_OPTIONS);
      expect(session.nativeSessionId).toBe(THREAD);
      const methods = receivedFrames(fake.logFile).map((frame) => frame.method);
      expect(methods.filter((method) => method === 'thread/resume' || method === 'thread/unarchive')).toEqual(['thread/resume', 'thread/unarchive', 'thread/resume']);
    });

    it('throws ResumeFailedError when the server refuses the thread', async () => {
      const fake = track(setupFake({ handlers: { ...baseHandlers(THREAD), 'thread/resume': { error: { code: -32600, message: 'thread not found: missing-thread' } } } }));
      await expect(fake.instance.resume('missing-thread', OPEN_OPTIONS)).rejects.toBeInstanceOf(ResumeFailedError);
      await expect(fake.instance.resume('missing-thread', OPEN_OPTIONS)).rejects.toThrow(/thread not found/);
    });
  });

  it('fills the transcript path from thread/read after the first terminal when thread/start had none', async () => {
    const fake = track(
      setupFake(
        turnScenario([turnStarted(THREAD, TURN), turnCompleted(THREAD, TURN)], {
          ...baseHandlers(THREAD, null),
          'thread/read': { result: { thread: (threadResult(THREAD, '/rollout/late.jsonl') as { thread: unknown }).thread, readState: null } },
        }),
      ),
    );
    const session = await fake.instance.start(OPEN_OPTIONS);
    expect(session.transcriptPath).toBeUndefined();
    const log = new EventLog(session);
    await session.sendTurn({ text: 'go' });
    const native = await log.waitFor((event): event is Extract<TransportEvent, { type: 'session.native' }> => event.type === 'session.native' && event.transcriptPath !== undefined);
    expect(native.transcriptPath).toBe('/rollout/late.jsonl');
    expect(session.transcriptPath).toBe('/rollout/late.jsonl');
    expect(receivedRequests(fake.logFile, 'thread/read')[0]?.params).toEqual({ threadId: THREAD, includeTurns: false });
    expect((session as { refreshTranscriptPath(): Promise<string | undefined> }).refreshTranscriptPath).toBeTypeOf('function');
    await expect((session as { refreshTranscriptPath(): Promise<string | undefined> }).refreshTranscriptPath()).resolves.toBe('/rollout/late.jsonl');
    expect(receivedRequests(fake.logFile, 'thread/read')).toHaveLength(1); // already known: no second read
  });

  describe('probe', () => {
    it('reads auth and pages through the model list', async () => {
      const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, model: id, displayName: `Model ${id}`, description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low', inputModalities: ['text'], ...extra });
      const fake = track(
        setupFake({
          version: '0.164.0',
          handlers: {
            ...baseHandlers(THREAD),
            'account/read': { result: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' }, requiresOpenaiAuth: true } },
            'model/list': [{ result: { data: [model('m1'), model('hidden-one', { hidden: true })], nextCursor: 'page-2' } }, { result: { data: [model('m2')], nextCursor: null } }],
          },
        }),
      );
      expect(await fake.instance.probe()).toEqual({
        installed: true,
        version: '0.164.0',
        auth: 'ok',
        models: [
          { id: 'm1', label: 'Model m1', efforts: ['low', 'high'] },
          { id: 'm2', label: 'Model m2', efforts: ['low', 'high'] },
        ],
      });
      expect(receivedRequests(fake.logFile, 'model/list').map((frame) => frame.params.cursor)).toEqual([undefined, 'page-2']);
    });

    it('reports missing auth, and a missing binary', async () => {
      const fake = track(setupFake({ handlers: { ...baseHandlers(THREAD), 'account/read': { result: { account: null, requiresOpenaiAuth: true } }, 'model/list': { result: { data: [], nextCursor: null } } } }));
      expect(await fake.instance.probe()).toMatchObject({ installed: true, auth: 'missing', models: [] });

      const dir = makeTempDir();
      cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
      const missing = createCodexAppServerPlugin().create({ enabled: true, command: ['/nonexistent/codex-binary', 'app-server'], idleUnloadMinutes: 60 }, makeContext(path.join(dir, 'runtime')));
      expect(await missing.probe()).toEqual({ installed: false, auth: 'unknown', models: [] });
      await expect(missing.start(OPEN_OPTIONS)).rejects.toBeInstanceOf(TransportUnavailableError);
    });
  });

  it('shares the event stream contract: single consumer, ends after stopped', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    const iterator = session.events[Symbol.asyncIterator]();
    expect(() => session.events[Symbol.asyncIterator]()).toThrow(/single consumer/);
    expect((await iterator.next()).value).toMatchObject({ type: 'session.native' });
    await session.close('shutdown');
    expect((await iterator.next()).value).toMatchObject({ type: 'session.state', state: 'ready' });
    expect((await iterator.next()).value).toMatchObject({ type: 'session.state', state: 'stopped' });
    expect((await iterator.next()).done).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The real client and plugin against traffic recorded from codex 0.156.1 (T3 Code fixtures).
describe('codex plugin against recorded app-server traffic', () => {
  const SIMPLE_THREAD = '01a0d5eb-f0c0-7481-a417-5e8871805cbc';

  async function open(fixture: string) {
    const replay = track(setupReplay(fixture));
    const session = await replay.instance.start(OPEN_OPTIONS);
    return { replay, session, log: new EventLog(session) };
  }

  /** Events up to and including the nth terminal (the replay process exits at the end of the transcript). */
  function untilTerminal(log: EventLog, count = 1): string[] {
    const types: string[] = [];
    let seen = 0;
    for (const event of log.events) {
      if (event.type === 'usage.updated' && event.windows) continue;
      types.push(event.type);
      if (event.type === 'turn.terminal' && (seen += 1) === count) break;
    }
    return types;
  }

  it('simple: one thread and one turn', async () => {
    const { replay, session, log } = await open('simple');
    expect(session.nativeSessionId).toBe(SIMPLE_THREAD);
    expect(session.transcriptPath).toBe(`/home/replay-user/.codex/sessions/2026/09/24/rollout-2026-09-24T17-16-44-${SIMPLE_THREAD}.jsonl`);
    const { turnId } = await session.sendTurn({ text: 'Respond with exactly: simple fixture turn complete', effort: 'high' });
    expect(turnId).toBe('01a0d5eb-f176-71d0-8e1c-a459700443de');
    const terminal = await log.waitForType('turn.terminal');
    expect(terminal).toMatchObject({ status: 'completed', replay: false, sessionUsable: true });
    expect(untilTerminal(log)).toEqual(['session.native', 'session.state', 'turn.started', 'item.completed', 'item.completed', 'usage.updated', 'turn.terminal']);
    expect(log.of('item.completed').map((event) => event.kind)).toEqual(['other', 'assistant']);
    expect(log.of('usage.updated').find((event) => event.contextUsedTokens !== undefined)?.contextMaxTokens).toBeGreaterThan(0);
    // The plugin's own turn/start parameters (the transcript's were T3 Code's).
    expect(replayFrames(replay.replayLog, 'turn/start')[0]?.params).toEqual({
      threadId: SIMPLE_THREAD,
      input: [{ type: 'text', text: 'Respond with exactly: simple fixture turn complete' }],
      clientUserMessageId: expect.any(String),
      effort: 'high',
      summary: 'detailed',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('multi_turn: two sequential turns on one thread', async () => {
    const { session, log } = await open('multi_turn');
    const one = await session.sendTurn({ text: 'Respond with exactly: first fixture turn complete' });
    await waitUntil(() => turnTerminals(log).length === 1);
    const two = await session.sendTurn({ text: 'Respond with exactly: second fixture turn complete' });
    await waitUntil(() => turnTerminals(log).length === 2);
    expect([one.turnId, two.turnId]).toEqual(['01a0d5ed-1957-7a22-8399-d0172af342fd', '01a0d5ed-2b29-7353-a6d5-7745731173b7']);
    expect(turnTerminals(log).map((event) => event.status)).toEqual(['completed', 'completed']);
    expect(log.of('turn.started').map((event) => event.turnId)).toEqual([one.turnId, two.turnId]);
  });

  it('queued_turn: a message queued by the host starts after the first turn completes', async () => {
    const { session, log } = await open('queued_turn');
    await session.sendTurn({ text: 'first' });
    await expect(session.sendTurn({ text: 'second, while the first runs' })).rejects.toBeInstanceOf(PreviousTurnActiveError);
    await waitUntil(() => turnTerminals(log).length === 1);
    await session.sendTurn({ text: 'second' });
    await waitUntil(() => turnTerminals(log).length === 2);
    expect(turnTerminals(log).map((event) => event.status)).toEqual(['completed', 'completed']);
  });

  it('message_steering: the steer appears as a second user message inside the same turn', async () => {
    const { replay, session, log } = await open('message_steering');
    const { turnId } = await session.sendTurn({ text: 'Respond with exactly: steering fixture initial response' });
    await log.waitForType('turn.started');
    await session.steer!(turnId, { text: 'Actually, respond with exactly: steering fixture observed' });
    await log.waitForType('turn.terminal');
    const userItems = log.of('item.completed').filter((event) => event.title === 'userMessage');
    expect(userItems).toHaveLength(2);
    expect(new Set(userItems.map((event) => event.turnId))).toEqual(new Set([turnId]));
    expect(turnTerminals(log)).toHaveLength(1);
    expect(replayFrames(replay.replayLog, 'turn/steer')[0]?.params).toMatchObject({ expectedTurnId: turnId, input: [{ type: 'text', text: 'Actually, respond with exactly: steering fixture observed' }] });
  });

  it('turn_interrupt: Stop ends the turn as interrupted', async () => {
    const { session, log } = await open('turn_interrupt');
    const { turnId } = await session.sendTurn({ text: 'Do not answer immediately. First run `sleep 30`.' });
    await log.waitForType('turn.started');
    await session.interrupt(turnId);
    const terminal = await log.waitForType('turn.terminal');
    expect(terminal).toMatchObject({ turnId, status: 'interrupted' });
    expect(turnTerminals(log)).toHaveLength(1);
  });

  it('turn_interrupt_mid_tool: a running command is terminated after the interrupt', async () => {
    const { replay, session, log } = await open('turn_interrupt_mid_tool');
    const { turnId } = await session.sendTurn({ text: 'Run this exact local command: node -e "setTimeout(() => {}, 30000)"' });
    await log.waitFor((event) => event.type === 'item.completed' && event.kind === 'reasoning');
    await sleep(100); // the command's item/started follows the reasoning item
    await session.interrupt(turnId);
    const terminal = await log.waitForType('turn.terminal');
    expect(terminal).toMatchObject({ turnId, status: 'interrupted' });
    await waitUntil(() => replayFrames(replay.replayLog, 'thread/backgroundTerminals/terminate').length === 1);
    expect(replayFrames(replay.replayLog, 'thread/backgroundTerminals/terminate')[0]?.params).toEqual({ threadId: session.nativeSessionId, processId: '87302' });
    // The recording has no list call; the plugin asked, was told it is not in the transcript, and terminated anyway.
    expect(replayFrames(replay.replayLog, 'thread/backgroundTerminals/list')).toHaveLength(1);
  });

  it('provider_thread_resume: the process ends, the thread resumes by id in a new process, and a turn completes', async () => {
    const { replay, session, log } = await open('provider_thread_resume');
    const threadId = session.nativeSessionId;
    await session.sendTurn({ text: 'Respond with exactly: provider thread resume fixture first turn complete' });
    await log.waitForType('turn.terminal');
    // The transcript ends the first launch here: the process exits and the session sees error, then stopped.
    await log.done;
    expect(log.events.at(-2)).toMatchObject({ type: 'session.state', state: 'error', failure: { class: 'transport_error', code: 'process_exited' } });
    expect(replay.instance.needsRespawn).toBe(true);

    const resumed = await replay.instance.resume(threadId, OPEN_OPTIONS);
    expect(resumed.nativeSessionId).toBe(threadId);
    const resumedLog = new EventLog(resumed);
    const { turnId } = await resumed.sendTurn({ text: 'Using the conversation history available in this resumed thread, repeat the final answer.' });
    expect(turnId).toBe('01a0d5ef-77e2-7e22-a198-4864f687b8b5');
    expect((await resumedLog.waitForType('turn.terminal')).status).toBe('completed');
    expect(replayFrames(replay.replayLog, 'thread/resume')[0]?.params).toMatchObject({ threadId, excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' });
    expect(replayFrames(replay.replayLog, 'initialize')).toHaveLength(2);
  });

  it('command_output_streaming: output deltas are ignored and the command item completes as a command', async () => {
    const { session, log } = await open('command_output_streaming');
    await session.sendTurn({ text: 'Run this exact shell command in the foreground and wait for it to finish.' });
    await log.waitForType('turn.terminal', 10_000);
    const command = log.of('item.completed').find((event) => event.kind === 'command');
    expect(command?.title).toContain('printf');
    expect(untilTerminal(log).filter((type) => type === 'turn.terminal')).toHaveLength(1);
    expect(log.events.some((event) => /stream line \d/.test(JSON.stringify(event)))).toBe(false); // the streamed output is not in events
  });

  it('plan_questions: a user-input request is answered with empty answers and recorded', async () => {
    const { replay, session, log } = await open('plan_questions');
    await session.sendTurn({ text: 'Use request_user_input to ask one multiple-choice clarifying question.' });
    const terminal = await log.waitForType('turn.terminal');
    expect(terminal.status).toBe('completed');
    const opened = log.of('request.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ requestId: '0', kind: 'question' });
    expect(log.of('request.closed')).toEqual([{ type: 'request.closed', requestId: '0', outcome: 'declined' }]);
    expect(replayAnswers(replay.replayLog)).toEqual([{ id: 0, result: { answers: {} } }]);
  });
});

function replayFrames(file: string, method: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { frame: Record<string, any> }).frame)
    .filter((frame) => frame.method === method);
}

function replayAnswers(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { frame: Record<string, any> }).frame)
    .filter((frame) => frame.method === undefined && frame.id !== undefined);
}

// ---------------------------------------------------------------------------------------------------------
// Opt-in: the installed codex binary. Starts the real app-server, reads models and the account, never opens
// a thread or a turn, so it spends no quota.
describe.skipIf(process.env.AGENT_CONSOLE_REAL_CODEX !== '1')('real codex app-server handshake', () => {
  it('initializes, lists models and reads the account through the plugin', async () => {
    const dir = makeTempDir('codex-real-');
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const context = makeContext(path.join(dir, 'structured', 'codex'));
    const instance = createCodexAppServerPlugin().create({ enabled: true, command: ['codex', 'app-server'], idleUnloadMinutes: 60 }, context) as CodexAppServerInstance;
    cleanups.push(() => instance.dispose('shutdown'));

    const probe = await instance.probe();
    expect(probe.installed).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(probe.auth).toBe('ok');
    expect(probe.models.length).toBeGreaterThan(0);
    expect(probe.models.every((model) => model.id.length > 0 && Array.isArray(model.efforts))).toBe(true);

    const alive = await instance.alive();
    expect(alive.connected).toBe(true);
    expect(alive.pid).toBeGreaterThan(0);
    const recorded = JSON.parse(context.metaStore.get('structured-instance:codex')!) as { pid: number; version: string };
    expect(recorded.pid).toBe(alive.pid);
    expect(recorded.version).toBe(probe.version);

    await instance.dispose('shutdown');
    expect((await instance.alive()).connected).toBe(false);
    expect(() => process.kill(alive.pid!, 0)).toThrow(); // the process is gone
  }, 60_000);

  it('accepts the exact request shapes the plugin sends (checked against a thread that does not exist)', async () => {
    const dir = makeTempDir('codex-real-');
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const client = await JsonRpcClient.spawn({ command: ['codex', 'app-server', '-c', 'check_for_update_on_startup=false'], cwd: dir, env: process.env });
    cleanups.push(() => client.close());
    await client.request('initialize', {
      clientInfo: { name: 'agent_console', title: 'Agent Console', version: '0.0.0-test' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['turn/diff/updated'] },
    });
    client.notify('initialized');
    const bogus = '00000000-0000-7000-8000-000000000000';
    const policy = { approvals: 'never', sandbox: 'full-access' } as const;
    const shapes: Array<[string, unknown]> = [
      ['turn/start', buildTurnStartParams(bogus, { text: 'never sent', model: 'gpt-x', effort: 'high' }, policy, dir, 'msg-1')],
      ['turn/steer', { threadId: bogus, input: [{ type: 'text', text: 'x' }], expectedTurnId: 'turn', clientUserMessageId: 'm' }],
      ['turn/interrupt', { threadId: bogus, turnId: 'turn' }],
      ['thread/resume', { threadId: bogus, excludeTurns: true, cwd: dir, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'low' } }],
      ['thread/unarchive', { threadId: bogus }],
      ['thread/unsubscribe', { threadId: bogus }],
      ['thread/read', { threadId: bogus, includeTurns: false }],
      ['thread/backgroundTerminals/list', { threadId: bogus }],
      ['thread/backgroundTerminals/terminate', { threadId: bogus, processId: '1' }],
    ];
    const outcomeOf = (method: string, params: unknown) =>
      client.request(method, params, { timeoutMs: 15_000 }).then(
        () => 'ok',
        (error: unknown) => (error instanceof JsonRpcRequestError ? error.message : String(error)),
      );
    // Control: a malformed request is rejected as invalid, so the checks below can tell the two apart.
    expect(await outcomeOf('turn/start', { ...(shapes[0]![1] as object), input: 'not a list' })).toMatch(/Invalid request/);
    for (const [method, params] of shapes) {
      // The server got past parameter parsing and failed on the missing thread (or accepted the call).
      expect(await outcomeOf(method, params), method).toMatch(/^(?:ok|thread not (?:found|loaded): .*|no (?:archived )?rollout found for thread id .*)$/);
    }
  }, 60_000);
});
