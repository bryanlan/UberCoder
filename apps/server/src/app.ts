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
import { registerSearchRoutes } from './routes/search.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { AuthService } from './security/auth-service.js';
import { SessionManager } from './sessions/session-manager.js';
import { ShellTmuxClient } from './sessions/tmux-client.js';
import { LiveOutputReader } from './sessions/live-output/reader.js';
import { RestartService } from './runtime/restart-service.js';
import { SessionSummaryService } from './summaries/session-summary-service.js';
import { ConversationSearchService } from './search/conversation-search.js';

export interface AppOptions {
  configPath?: string;
}

export async function buildApp(options: AppOptions = {}) {
  const configService = new ConfigService(options.configPath);
  const config = configService.getConfig();
  const db = new AppDatabase(config.databasePath);
  const app = fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const eventBus = new RealtimeEventBus();
  const projectService = new ProjectService(configService);
  const providerRegistry = new ProviderRegistry();
  const liveOutputReader = new LiveOutputReader();
  const indexing = new IndexingService(configService, projectService, providerRegistry, db, eventBus);
  const search = new ConversationSearchService(db, projectService, liveOutputReader);
  const sessions = new SessionManager(db, new ShellTmuxClient(), config.runtimeDir, eventBus, {
    projectService,
    providerRegistry,
  }, app.log);
  const authService = new AuthService(config, db);
  const sessionSummaries = new SessionSummaryService(
    db,
    projectService,
    providerRegistry,
    config.runtimeDir,
    eventBus,
    undefined,
    liveOutputReader,
  );
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
  await registerSearchRoutes(app, authService, search);
  await registerConversationRoutes(app, authService, db, projectService, providerRegistry, sessions, eventBus, liveOutputReader);
  await registerSessionRoutes(app, authService, db, projectService, providerRegistry, sessions);
  await registerEventRoutes(app, authService, eventBus);
  await registerSettingsRoutes(app, authService, configService, db, indexing, projectService, restartService);
  new LocalhostProxyService(projectService, authService).register(app);

  if (fs.existsSync(config.server.webDistPath)) {
    await app.register(fastifyStatic, {
      root: config.server.webDistPath,
      prefix: '/',
      setHeaders: (response, filePath) => {
        const fileName = path.basename(filePath);
        if (
          fileName === 'index.html'
          || fileName === 'sw.js'
          || fileName === 'manifest.webmanifest'
          || fileName.startsWith('workbox-')
        ) {
          response.setHeader('Cache-Control', 'no-store');
        }
      },
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/proxy')) {
        reply.code(404).send({ error: 'Not found.' });
        return;
      }
      return reply.sendFile('index.html');
    });
  }

  await indexing.loadProjectMetadata();
  await indexing.start();
  sessions.startSessionReconciliation();
  sessionSummaries.start();

  app.addHook('onClose', async () => {
    await sessionSummaries.stop();
    await indexing.stop();
    await sessions.stop();
    liveOutputReader.clear();
    db.close();
  });

  return { app, config };
}
