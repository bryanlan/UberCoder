import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../src/config/service.js';
import { ProjectService } from '../src/projects/project-service.js';

async function setup(): Promise<{ configPath: string; root: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-projects-'));
  const root = path.join(tempDir, 'projects');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'demo'));
  await fs.mkdir(path.join(root, 'hidden'));
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    projectsRoot: root,
    security: {
      passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    providers: {
      codex: { commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} } },
      claude: { commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} } },
    },
    projects: {
      demo: { active: true, displayName: 'Demo', allowedLocalhostPorts: [3000] },
      hidden: { active: false },
    },
  }, null, 2));
  return { configPath, root };
}

describe('ProjectService', () => {
  it('discovers only immediate child directories marked active', async () => {
    const { configPath } = await setup();
    const service = new ProjectService(new ConfigService(configPath));
    const projects = await service.listActiveProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.slug).toBe('demo');
    expect(projects[0]?.allowedLocalhostPorts).toEqual([3000]);
  });
});
