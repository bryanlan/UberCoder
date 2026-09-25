import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { WikiService } from '../src/wiki/service.js';

it('serves a project wiki with authentication, CSRF protection and conflict responses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-routes-'));
  const project = path.join(root, 'demo');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), '# Demo');
  execFileSync('git', ['init', '-q', project]);
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    projectsRoot: root,
    runtimeDir: path.join(root, 'runtime'),
    databasePath: path.join(root, 'console.sqlite'),
    security: {
      passwordHash: 'scrypt:e63f79449b39327540c914ce72df7fd8:8b59c3daf10c16c5ea0c645aea6e47c7ede25beb73c167852b1cbbdf5d4bdad218bc4f25193ebfe2f29779e5d7cc995b890a6b46ea9c4c5096973b301087e4bc',
      sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    providers: {
      codex: { discoveryRoot: path.join(root, 'codex'), commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume'], continueCommand: ['codex'], env: {} } },
      claude: { discoveryRoot: path.join(root, 'claude'), commands: { newCommand: ['claude'], resumeCommand: ['claude', 'resume'], continueCommand: ['claude'], env: {} } },
    },
    projects: { demo: { active: true, path: project } },
  }));
  const { app } = await buildApp({ configPath });
  await app.ready();
  try {
    const url = '/api/wiki/demo/page';
    expect((await app.inject(`${url}?title=Home`)).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'agent-console-demo' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    const csrf = login.json().csrfToken;
    const writeBody = { title: 'Home', body: '# Home\nLink to [[Design]].', baseRevision: null, summary: 'Start wiki' };
    expect((await app.inject({ method: 'PUT', url, headers: { cookie }, payload: writeBody })).statusCode).toBe(403);
    const created = await app.inject({ method: 'PUT', url, headers: { cookie, 'x-csrf-token': csrf }, payload: writeBody });
    expect(created.statusCode).toBe(200);
    expect(created.json().page).toMatchObject({ title: 'Home', body: writeBody.body, links: ['Design'] });
    const revision = created.json().page.revision;
    const read = await app.inject({ url: `${url}?title=Home`, headers: { cookie } });
    expect(read.json().page.revision).toBe(revision);
    expect((await app.inject({ url: '/api/wiki/demo/pages', headers: { cookie } })).json().total).toBe(1);
    expect((await app.inject({ url: '/api/wiki/demo/search?query=Design', headers: { cookie } })).json().results[0].title).toBe('Home');
    const changed = await app.inject({ method: 'PUT', url, headers: { cookie, 'x-csrf-token': csrf }, payload: { ...writeBody, body: 'Updated', baseRevision: revision } });
    expect(changed.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PUT', url, headers: { cookie, 'x-csrf-token': csrf }, payload: { ...writeBody, body: 'Overwrite', baseRevision: revision } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().currentRevision).toBe(changed.json().page.revision);
    expect((await app.inject({ url: '/api/wiki/demo/history?title=Home', headers: { cookie } })).json().revisions).toHaveLength(2);
  } finally {
    await app.close();
  }
  const reopened = new WikiService(path.join(root, 'wiki', 'agent-wiki.sqlite'));
  try { expect(reopened.read(project, 'Home', { kind: 'user', id: 'test' })?.body).toBe('Updated'); }
  finally { reopened.close(); await fs.rm(root, { recursive: true, force: true }); }
});
