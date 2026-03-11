import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';

function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

async function writeCodexFixture(codexHome: string, projectPath: string): Promise<void> {
  await writeJsonl(path.join(codexHome, 'sessions', '2026', '03', '11', 'rollout-e2e-legacy.jsonl'), [
    {
      type: 'session_meta',
      payload: {
        cwd: projectPath,
        id: 'e2e-legacy',
      },
    },
    {
      timestamp: '2026-03-11T08:00:00.000Z',
      role: 'user',
      text: 'Legacy migrated Codex conversation',
    },
    {
      timestamp: '2026-03-11T08:00:02.000Z',
      role: 'assistant',
      text: 'The migrated nested project still shows prior history.',
    },
  ]);
}

async function writeClaudeFixture(claudeHome: string, projectPath: string): Promise<void> {
  const transcriptPath = path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectPath(projectPath),
    'alpha-nested-history.jsonl',
  );
  await writeJsonl(transcriptPath, [
    {
      cwd: projectPath,
      timestamp: '2026-03-11T09:00:00.000Z',
      type: 'user',
      message: {
        role: 'user',
        content: 'Alpha nested Claude conversation',
      },
    },
    {
      cwd: projectPath,
      timestamp: '2026-03-11T09:00:05.000Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: 'Alpha is ready in the explicit project list.',
      },
    },
  ]);
  await writeJsonl(path.join(claudeHome, 'history.jsonl'), [
    {
      cwd: projectPath,
      transcript_path: transcriptPath,
    },
  ]);
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-e2e-'));
  const projectsRoot = path.join(tempDir, 'projects');
  const uberLegacyRoot = path.join(projectsRoot, 'UberCoder');
  const uberNestedProject = path.join(uberLegacyRoot, 'agent-console-mvp', 'agent-console');
  const alphaProject = path.join(projectsRoot, 'alpha', 'service');
  const codexHome = path.join(tempDir, 'codex');
  const claudeHome = path.join(tempDir, 'claude');
  const configPath = path.join(tempDir, 'config.json');

  await fs.mkdir(uberNestedProject, { recursive: true });
  await fs.mkdir(alphaProject, { recursive: true });
  await fs.writeFile(path.join(uberNestedProject, 'AGENTS.md'), '# UberCoder');
  await fs.writeFile(path.join(alphaProject, 'claude.md'), '# Alpha');
  await writeCodexFixture(codexHome, uberLegacyRoot);
  await writeClaudeFixture(claudeHome, alphaProject);

  await fs.writeFile(configPath, JSON.stringify({
    server: {
      host: '127.0.0.1',
      port: 4317,
      webDistPath: '../web/dist',
    },
    projectsRoot,
    runtimeDir: path.join(tempDir, 'runtime'),
    databasePath: path.join(tempDir, 'agent-console.sqlite'),
    security: {
      passwordHash: 'scrypt:e63f79449b39327540c914ce72df7fd8:8b59c3daf10c16c5ea0c645aea6e47c7ede25beb73c167852b1cbbdf5d4bdad218bc4f25193ebfe2f29779e5d7cc995b890a6b46ea9c4c5096973b301087e4bc',
      sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      cookieSecure: false,
      sessionTtlHours: 24,
      loginRateLimitMax: 10,
      loginRateLimitWindowMs: 900000,
      trustTailscaleHeaders: false,
    },
    providers: {
      codex: {
        enabled: true,
        discoveryRoot: codexHome,
        commands: {
          newCommand: ['codex'],
          resumeCommand: ['codex', 'resume', '{{conversationId}}'],
          continueCommand: ['codex', 'resume', '--last'],
          env: {},
        },
      },
      claude: {
        enabled: true,
        discoveryRoot: claudeHome,
        commands: {
          newCommand: ['claude'],
          resumeCommand: ['claude', '--resume', '{{conversationId}}'],
          continueCommand: ['claude', '--continue'],
          env: {},
        },
      },
    },
    projects: {
      UberCoder: {
        active: true,
        path: uberLegacyRoot,
        displayName: 'UberCoder',
        allowedLocalhostPorts: [],
        tags: [],
      },
    },
  }, null, 2));

  const { app, config } = await buildApp({ configPath });
  const address = await app.listen({
    host: config.server.host,
    port: config.server.port,
  });
  process.stdout.write(`Agent Console e2e backend listening at ${address}\n`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

await main();
