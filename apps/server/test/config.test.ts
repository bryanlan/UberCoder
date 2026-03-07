import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../src/config/service.js';

async function writeTempConfig(body: object): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-config-'));
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(body, null, 2));
  return configPath;
}

describe('ConfigService', () => {
  it('parses config and merges project provider overrides predictably', async () => {
    const configPath = await writeTempConfig({
      projectsRoot: '/tmp/projects',
      security: {
        passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      providers: {
        codex: {
          enabled: true,
          discoveryRoot: '~/.codex',
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: { CODEX_HOME: '~/.codex' },
          },
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
          commands: {
            newCommand: ['claude'],
            resumeCommand: ['claude', '--resume', '{{conversationId}}'],
            continueCommand: ['claude', '--continue'],
            env: {},
          },
        },
      },
      projects: {
        demo: {
          active: true,
          displayName: 'Demo Project',
          allowedLocalhostPorts: [3000, 5173],
          providers: {
            codex: {
              commands: {
                resumeCommand: ['codex', 'resume', '--last'],
                env: { CODEX_HOME: '/srv/codex-home' },
              },
            },
          },
        },
      },
    });

    const service = new ConfigService(configPath);
    const merged = service.getMergedProviderSettings('demo', 'codex');
    const globalMerged = service.getMergedProviderSettings('__global__', 'codex');

    expect(service.getConfig().projectsRoot).toBe('/tmp/projects');
    expect(merged.commands.resumeCommand).toEqual(['codex', 'resume', '--last']);
    expect(merged.commands.env).toEqual({ CODEX_HOME: '/srv/codex-home' });
    expect(globalMerged.commands.env).toEqual({ CODEX_HOME: path.join(os.homedir(), '.codex') });
    expect(service.getProjectConfig('demo')?.allowedLocalhostPorts).toEqual([3000, 5173]);
  });
});
