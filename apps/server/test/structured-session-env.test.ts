import { afterEach, describe, expect, it } from 'vitest';
import { buildAppServerEnv } from '../src/providers/transport/codex/app-server-instance.js';
import { structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** The configuration the plugin receives when the host creates the provider instance for the first bind. */
async function pluginConfig(manager: NonNullable<Parameters<typeof structuredSessionFixture>[0]>['manager']) {
  const f = structuredSessionFixture({ manager });
  open.push(f);
  await f.bindNew();
  return f.plugin.instance!.config as { enabled: boolean; command: string[]; env?: Record<string, string> };
}

const codex = (env?: Record<string, string>) => ({ codex: { enabled: true, command: ['fake-codex', 'app-server'], idleUnloadMinutes: 60, env: env ?? {} } });

describe('Structured provider process environment', () => {
  it('gives the plugin the Console coordination variables when coordination is on', async () => {
    const config = await pluginConfig({ structuredSessions: codex(), structuredEnv: { AGENT_COORD_RUNTIME: '/runtime', AGENT_CONSOLE_CONFIG: '/config.json' } });
    expect(config.env).toEqual({ AGENT_COORD_RUNTIME: '/runtime', AGENT_CONSOLE_CONFIG: '/config.json' });
    expect(config.command).toEqual(['fake-codex', 'app-server']);
  });

  it('merges the configured env over the coordination variables, keeping both sets', async () => {
    const config = await pluginConfig({
      structuredSessions: codex({ AGENT_COORD_RUNTIME: '/override', CODEX_HOME: '~/alt', EXTRA: '1' }),
      structuredEnv: { AGENT_COORD_RUNTIME: '/runtime', AGENT_CONSOLE_CONFIG: '/config.json' },
    });
    expect(config.env).toEqual({ AGENT_COORD_RUNTIME: '/override', AGENT_CONSOLE_CONFIG: '/config.json', CODEX_HOME: '~/alt', EXTRA: '1' });
  });

  it('adds no Console variables when coordination is off, and still passes the configured env', async () => {
    expect((await pluginConfig({ structuredSessions: codex() })).env).toEqual({});
    expect((await pluginConfig({ structuredSessions: codex({ EXTRA: '1' }) })).env).toEqual({ EXTRA: '1' });
  });

  it('applies the merged env to the child process: configured values win over the inherited environment', () => {
    const env = buildAppServerEnv(
      { PATH: '/bin', AGENT_COORD_RUNTIME: '/live-runtime', AGENT_CONSOLE_SESSION_ID: 'stale', CODEX_THREAD_ID: 'stale' },
      '/home/tester',
      { AGENT_COORD_RUNTIME: '/proof-runtime', AGENT_CONSOLE_CONFIG: '/proof/config.json', CODEX_HOME: '~/alt-codex', AGENT_CONSOLE_SESSION_ID: 'pinned' },
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      AGENT_COORD_RUNTIME: '/proof-runtime',
      AGENT_CONSOLE_CONFIG: '/proof/config.json',
      CODEX_HOME: '/home/tester/alt-codex',
    });
    // The shared process never carries one session's identity, even when the config names it.
    expect(env).not.toHaveProperty('AGENT_CONSOLE_SESSION_ID');
    expect(env).not.toHaveProperty('CODEX_THREAD_ID');
  });
});
