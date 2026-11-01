import Fastify from 'fastify';
import cookiePlugin from '@fastify/cookie';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { AuthService } from '../src/security/auth-service.js';
import { appConfigSchema } from '../src/config/schema.js';
import { ModelProfileService, type WoRunner } from '../src/model-profiles/service.js';
import { registerModelProfileRoutes } from '../src/routes/model-profiles.js';

const level = (model: string, label: string, effort: string) => ({ model, label, effort, launch_name: model });
const PROFILES = JSON.stringify({ profiles: {
  codex: { provider: 'openai', levels: {
    high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'), medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'), low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
  } },
  claude: { provider: 'anthropic', levels: {
    high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'), medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'), low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
  } },
} });

it('serves the model list to a signed-in browser and says why when the catalog cannot be read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-profile-routes-'));
  const db = new AppDatabase(path.join(root, 'console.sqlite'));
  const config = appConfigSchema.parse({ projectsRoot: root, providers: {}, security: { passwordHash: 'fixture', sessionSecret: 'x'.repeat(64),
    trustTailscaleHeaders: true, tailscaleAllowedUserLogin: 'fixture@example.invalid' } });
  const auth = new AuthService(config, db);
  const app = Fastify();
  await app.register(cookiePlugin);
  app.get('/auth', (request, reply) => auth.getAuthState(request, reply));
  const answer = PROFILES as string | Error;
  const run: WoRunner = async () => { if (answer instanceof Error) throw answer; return { stdout: answer, stderr: '' }; };
  await registerModelProfileRoutes(app, auth, new ModelProfileService({ profilesCacheMs: 0 }, run));
  try {
    expect((await app.inject('/api/model-profiles')).statusCode).toBe(401);
    const login = await app.inject({ url: '/auth', headers: { 'tailscale-user-login': 'fixture@example.invalid' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]! };

    const ok = await app.inject({ url: '/api/model-profiles', headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toMatchObject({
      loadedAt: expect.any(String),
      providers: {
        codex: { routerProvider: 'openai', levels: {
          high: { model: 'gpt-6-astra', label: 'GPT-6 Astra', effort: 'xhigh', launchName: 'gpt-6-astra' },
          medium: { launchName: 'gpt-6.1-sol' }, low: { launchName: 'gpt-6-luna' },
        } },
        claude: { routerProvider: 'anthropic', levels: {
          high: { launchName: 'claude-fable-5-1' }, medium: { launchName: 'claude-opus-5-5' },
          low: { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'high', launchName: 'claude-sonnet-5-5' },
        } },
      },
    });

    // No built-in table: with nothing ever loaded the route reports the failure instead of an answer.
    const broken = new ModelProfileService({ profilesCacheMs: 0 }, async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
    const failing = Fastify();
    await failing.register(cookiePlugin);
    failing.get('/auth', (request, reply) => auth.getAuthState(request, reply));
    await registerModelProfileRoutes(failing, auth, broken);
    const down = await failing.inject({ url: '/api/model-profiles', headers });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: expect.stringMatching(/^Model profiles unavailable: wo was not found at /) });
    await failing.close();
  } finally { await app.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
