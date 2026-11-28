import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_RATE_LIMIT_NOTICE,
  buildAntigravityEnv,
  createAntigravityPlugin,
  type AntigravityStructuredConfig,
} from '../src/providers/transport/antigravity/index.js';
import { SendRejectedError, type PluginContext, type TransportEvent, type TransportSession } from '../src/providers/transport/types.js';

const FAKE_AGY = fileURLToPath(new URL('./helpers/fake-antigravity.mjs', import.meta.url));
const roots: string[] = [];
const activeInstances: Array<{ dispose(reason: 'shutdown' | 'restart'): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(activeInstances.splice(0).map(instance => instance.dispose('shutdown')));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-plugin-'));
  roots.push(root);
  const cwd = path.join(root, 'repo');
  const dataDir = path.join(root, 'agy-data');
  const runtimeDir = path.join(root, 'runtime');
  const logFile = path.join(root, 'agy.jsonl');
  const quotaLog = path.join(root, 'quota.txt');
  const fakeQuota = path.join(root, 'fake-wo.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(fakeQuota, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(quotaLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });

  const meta = new Map<string, string>();
  const context: PluginContext = {
    runtimeDir,
    log: { info: () => {}, warn: () => {} },
    meta: { get: (k) => meta.get(k), set: (k, v) => { meta.set(k, v); }, delete: (k) => { meta.delete(k); } },
  };
  const config: AntigravityStructuredConfig = {
    enabled: true,
    command: [process.execPath, FAKE_AGY],
    idleUnloadMinutes: 60,
    env: { ANTIGRAVITY_DATA_DIR: dataDir, FAKE_AGY_LOG: logFile },
  };
  const plugin = createAntigravityPlugin({
    homeDir: root,
    quotaCommand: [process.execPath, fakeQuota, 'quota', 'limited', '--subscription', 'google_ai_pro'],
  });
  const instance = plugin.create(config, context);
  activeInstances.push(instance);
  return { root, cwd, dataDir, logFile, quotaLog, instance, meta };
}

function collect(session: TransportSession): TransportEvent[] {
  const events: TransportEvent[] = [];
  void (async () => { for await (const event of session.events) events.push(event); })();
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('timed out waiting for condition');
}

const POLICY = { approvals: 'never', sandbox: 'workspace-write' } as const;

describe('Antigravity ACP transport plugin', () => {
  it('strips Gemini/Google API keys from child env so billing stays on Google AI Pro OAuth', () => {
    const env = buildAntigravityEnv({
      base: { PATH: '/usr/bin', GEMINI_API_KEY: 'secret-1', GOOGLE_API_KEY: 'secret-2', KEEP_ME: 'yes' },
      configEnv: { GEMINI_API_KEY: 'secret-3', EXTRA: 'ok' },
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
    expect(env.EXTRA).toBe('ok');
  });

  it('probes, starts a session, switches model/thought_level, runs a turn with usage + tools, and resumes cleanly', async () => {
    const { cwd, instance, logFile } = await harness();
    const probed = await instance.probe();
    expect(probed).toMatchObject({ installed: true, version: '1.5.19-fake' });

    const session = await instance.start({ conversationId: 'conv-1', cwd, policy: POLICY });
    const events = collect(session);
    await waitFor(() => events.some(e => e.type === 'session.state' && e.state === 'ready'));

    const { turnId } = await session.sendTurn({ text: 'tool check', model: 'gemini-4-hydrogen', effort: 'medium' });
    await waitFor(() => events.some(e => e.type === 'turn.terminal' && e.turnId === turnId && e.status === 'completed'));
    expect(events.some(e => e.type === 'usage.updated' && e.contextUsedTokens === 1024 && e.contextMaxTokens === 1048576)).toBe(true);
    expect(events.some(e => e.type === 'item.completed' && e.kind === 'command')).toBe(true);

    // Switching to Flash rejects unsupported xhigh thought_level before sending a prompt.
    await expect(session.sendTurn({ text: 'too deep', model: 'gemini-3.8-flash', effort: 'xhigh' })).rejects.toThrow(SendRejectedError);

    const nativeId = session.nativeSessionId;
    await session.close('release');

    const resumed = await instance.resume(nativeId, { conversationId: 'conv-1', cwd, policy: POLICY });
    const resumedEvents = collect(resumed);
    await waitFor(() => resumedEvents.some(e => e.type === 'session.state' && e.state === 'ready'));
    // Replayed chunks during session/load must not open a turn.
    expect(resumedEvents.some(e => e.type === 'turn.started')).toBe(false);

    const rpcCalls = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    expect(rpcCalls.some(c => c.method === 'session/set_config_option' && c.params?.configId === 'model' && c.params?.value === 'gemini-4-hydrogen')).toBe(true);
    expect(rpcCalls.some(c => c.method === 'session/set_config_option' && c.params?.configId === 'thought_level' && c.params?.value === 'medium')).toBe(true);
  });

  it('records a google_ai_pro rate limit and emits a notice when ACP returns 429 / RESOURCE_EXHAUSTED', async () => {
    const { cwd, instance, quotaLog } = await harness();
    const session = await instance.start({ conversationId: 'conv-rl', cwd, policy: POLICY });
    const events = collect(session);
    await waitFor(() => events.some(e => e.type === 'session.state' && e.state === 'ready'));

    const { turnId } = await session.sendTurn({ text: 'rate-limit' });
    await waitFor(() => events.some(e => e.type === 'turn.terminal' && e.turnId === turnId && e.status === 'failed'));
    expect(events.some(e => e.type === 'notice' && e.text === ANTIGRAVITY_RATE_LIMIT_NOTICE)).toBe(true);
    let recorded = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { recorded = await fs.readFile(quotaLog, 'utf8'); if (recorded.trim()) break; } catch { /* wait */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(JSON.parse(recorded.trim())).toEqual(['quota', 'limited', '--subscription', 'google_ai_pro']);
  });

  it('cancels a running turn on interrupt', async () => {
    const { cwd, instance } = await harness();
    const session = await instance.start({ conversationId: 'conv-int', cwd, policy: POLICY });
    const events = collect(session);
    await waitFor(() => events.some(e => e.type === 'session.state' && e.state === 'ready'));

    const { turnId } = await session.sendTurn({ text: 'slow' });
    await waitFor(() => events.some(e => e.type === 'turn.started' && e.turnId === turnId));
    await session.interrupt(turnId);
    await waitFor(() => events.some(e => e.type === 'turn.terminal' && e.turnId === turnId && e.status === 'interrupted'));
  });
});
