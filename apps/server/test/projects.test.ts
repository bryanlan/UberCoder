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
  await fs.mkdir(path.join(root, 'demo', 'workspace'), { recursive: true });
  await fs.mkdir(path.join(root, 'hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'demo', 'workspace', 'AGENTS.md'), '# Demo');
  await fs.writeFile(path.join(root, 'hidden', 'claude.md'), '# Hidden');
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
      demo: { active: true, path: path.join(root, 'demo', 'workspace'), displayName: 'Demo', allowedLocalhostPorts: [3000] },
      hidden: { active: false, path: path.join(root, 'hidden') },
    },
  }, null, 2));
  return { configPath, root };
}

describe('ProjectService', () => {
  it('lists only configured active projects using their explicit saved paths', async () => {
    const { configPath, root } = await setup();
    const service = new ProjectService(new ConfigService(configPath));
    const projects = await service.listActiveProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.slug).toBe('demo');
    expect(projects[0]?.allowedLocalhostPorts).toEqual([3000]);
    expect(projects[0]?.rootPath).toBe(path.join(root, 'demo'));
    expect(projects[0]?.matchPaths).toEqual([path.join(root, 'demo', 'workspace'), path.join(root, 'demo')]);
    expect(projects[0]?.path).toBe(path.join(root, 'demo', 'workspace'));
  });

  it('lists editable settings for configured projects only', async () => {
    const { configPath, root } = await setup();
    const service = new ProjectService(new ConfigService(configPath));
    const projects = await service.listProjectSettings();

    expect(projects.map((project) => project.directoryName)).toEqual(['demo', 'hidden']);
    expect(projects.find((project) => project.directoryName === 'demo')).toMatchObject({
      active: true,
      displayName: 'Demo',
      exists: true,
      allowedLocalhostPorts: [3000],
      path: path.join(root, 'demo', 'workspace'),
    });
    expect(projects.find((project) => project.directoryName === 'hidden')).toMatchObject({
      active: false,
      exists: true,
      path: path.join(root, 'hidden'),
    });
  });

  it('does not broaden match paths for explicit nested projects', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-projects-'));
    const root = path.join(tempDir, 'projects');
    const parentPath = path.join(root, 'waltium');
    const childPath = path.join(parentPath, 'agent', 'cio');
    await fs.mkdir(childPath, { recursive: true });
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
        cio: { active: true, explicit: true, path: childPath },
      },
    }, null, 2));

    const service = new ProjectService(new ConfigService(configPath));
    const projects = await service.listActiveProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(parentPath);
    expect(projects[0]?.matchPaths).toEqual([childPath]);
  });
});
