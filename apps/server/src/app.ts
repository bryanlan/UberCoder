import fs from 'node:fs';
import path from 'node:path';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ConfigService } from './config/service.js';
import { AppDatabase } from './db/database.js';
import { IndexingService } from './indexing/indexing-service.js';
import { ProjectService } from './projects/project-service.js';
import { ProviderRegistry } from './providers/registry.js';
import { LocalhostProxyService } from './proxy/localhost-proxy.js';
import { RealtimeEventBus } from './realtime/event-bus.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerEventRoutes } from './routes/events.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { AuthService } from './security/auth-service.js';
import { SessionManager } from './sessions/session-manager.js';
import { ShellTmuxClient } from './sessions/tmux-client.js';
import { RestartService } from './runtime/restart-service.js';

export interface AppOptions {
  configPath?: string;
}

export async function buildApp(options: AppOptions = {}) {
  const configService = new ConfigService(options.configPath);
  const config = configService.getConfig();
  const db = new AppDatabase(config.databasePath);
  const eventBus = new RealtimeEventBus();
  const projectService = new ProjectService(configService);
  const providerRegistry = new ProviderRegistry();
  const indexing = new IndexingService(configService, projectService, providerRegistry, db, eventBus);
  const sessions = new SessionManager(db, new ShellTmuxClient(), config.runtimeDir, eventBus);
  const authService = new AuthService(config, db);

  const app = fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const restartService = new RestartService(() => app.close());

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
    hook: 'preHandler',
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const contentType = reply.getHeader('content-type');
    const baseName = path.basename(request.url.split('?')[0] || '');
    const isServiceWorkerAsset = baseName === 'manifest.webmanifest'
      || baseName === 'sw.js'
      || baseName === 'registerSW.js'
      || /^workbox-[^.]+\.js$/.test(baseName);
    const isHtmlDocument = typeof contentType === 'string' && contentType.includes('text/html');

    if (isHtmlDocument || isServiceWorkerAsset) {
      reply.header('Cache-Control', 'no-store');
    }

    return payload;
  });

  app.get('/api/health', async () => ({ ok: true }));

  await registerAuthRoutes(app, authService, { max: config.security.loginRateLimitMax, timeWindow: config.security.loginRateLimitWindowMs });
  await registerProjectRoutes(app, authService, indexing, sessions);
  await registerConversationRoutes(app, authService, db, projectService, providerRegistry, sessions);
  await registerSessionRoutes(app, authService, db, projectService, providerRegistry, sessions);
  await registerEventRoutes(app, authService, eventBus);
  await registerSettingsRoutes(app, authService, configService, projectService, restartService);
  new LocalhostProxyService(projectService, authService).register(app);

  if (fs.existsSync(config.server.webDistPath)) {
    await app.register(fastifyStatic, {
      root: config.server.webDistPath,
      prefix: '/',
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/proxy')) {
        reply.code(404).send({ error: 'Not found.' });
        return;
      }
      return reply.sendFile('index.html');
    });
  }

  await indexing.start();
  await sessions.recoverSessions();

  app.addHook('onClose', async () => {
    await indexing.stop();
    db.close();
  });

  return { app, config };
}
