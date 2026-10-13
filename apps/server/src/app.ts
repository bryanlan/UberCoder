import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { ImageStore } from './images/store.js';
import { registerImageRoutes } from './images/routes.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { AuthService } from './security/auth-service.js';
import { SessionManager } from './sessions/session-manager.js';
import { ShellTmuxClient } from './sessions/tmux-client.js';
import { GrantService } from './grants/service.js';
import { GrantPushService } from './grants/push.js';
import { registerGrantRoutes } from './grants/transport.js';
import { AgentSessionLaunches } from './grants/session-launches.js';
import { LiveOutputReader } from './sessions/live-output/reader.js';
import { RestartService } from './runtime/restart-service.js';
import { ConversationSearchService } from './search/conversation-search.js';
import { CoordinationService } from './coordination/service.js';
import { registerCoordinationRoutes, startCoordinationSocket } from './coordination/transport.js';
import { WikiService } from './wiki/service.js';
import { registerWikiRoutes } from './wiki/routes.js';
import { recordCoordinationTelemetry, startCoordinationTelemetry } from './coordination/telemetry.js';
import { WorkerEvidenceSource } from './workers/evidence.js';
import { SharedSummaryRuntime } from './workers/runtime.js';
import { WorkerSummaryAudit } from './workers/audit.js';
import { WorkerPanelService } from './workers/service.js';
import { WorkerSnapshotStore } from './workers/snapshot-store.js';
import { WorkerUserActivity } from './workers/user-activity.js';
import { registerWorkerRoutes } from './workers/routes.js';

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
    // Browser event streams must not keep shutdown and socket release waiting.
    forceCloseConnections: true,
  });
  const eventBus = new RealtimeEventBus();
  const projectService = new ProjectService(configService);
  const providerRegistry = new ProviderRegistry(db.transcriptParseCache);
  const liveOutputReader = new LiveOutputReader();
  const indexing = new IndexingService(configService, projectService, providerRegistry, db, eventBus,
    config.coordination.enabled ? (measurement) => { recordCoordinationTelemetry(config.runtimeDir, measurement); } : undefined);
  const search = new ConversationSearchService(db, projectService, liveOutputReader);
  let grants: GrantService;
  const sessions = new SessionManager(db, new ShellTmuxClient(), config.runtimeDir, eventBus, {
    projectService,
    providerRegistry,
  }, app.log, {
    coordinationEnabled: config.coordination.enabled,
    eagerRestoreWindowMs: config.sessions.eagerRestoreHours * 60 * 60 * 1000,
    restoreGraceMs: config.sessions.restoreGraceHours * 60 * 60 * 1000,
    pressureSuspendAvailableBytes: config.sessions.pressureSuspendAvailableMiB * 1024 * 1024,
    pressureSuspendIdleMs: config.sessions.pressureSuspendIdleMinutes * 60 * 1000,
    hasActiveLaunchAuthority: session => {
      const assignment = db.sqlite.prepare('select id from coordination_assignments where provider=? and native_session_id=?')
        .get(session.provider, session.resumeConversationRef ?? session.conversationRef) as { id: string } | undefined;
      return !!assignment && grants.grantsFor(assignment.id).length > 0;
    },
    launchAuthorityContext: context => grants.authorityContext(context),
  });
  const authService = new AuthService(config, db);
  const images = new ImageStore(path.join(path.dirname(config.databasePath), 'images'));
  const wakeAssignments = () => { void sessions.wakePendingAssignments().catch((error: unknown) => app.log.warn({ err: error }, 'Assignment continuation failed.')); };
  const grantPush = new GrantPushService(db, config.server.publicBaseUrl ?? `http://127.0.0.1:${config.server.port}`);
  grants = new GrantService(db, eventBus, wakeAssignments, grant => grantPush.request(grant),
    (sessionId, provider, nativeSessionId) => { void sessions.adoptRegisteredSession(sessionId, provider, nativeSessionId).catch(error => app.log.warn({ err: error }, 'Registered session adoption deferred.')); },
    cwd => Object.entries(config.projects).filter(([, project]) => project.active)
      .map(([slug, project]) => ({ slug, directory: path.resolve(project.path ?? path.join(config.projectsRoot, slug)) }))
      .sort((a,b) => b.directory.length - a.directory.length).find(project => cwd === project.directory || cwd.startsWith(project.directory + path.sep))?.slug);
  const coordination = new CoordinationService(db, config.coordination, config.coordination.enabled ? wakeAssignments : undefined, grants);
  const agentLaunches = new AgentSessionLaunches(db, grants, sessions, projectService, providerRegistry, eventBus,
    config.sessions.pressureSuspendAvailableMiB * 1024 * 1024);
  const wiki = new WikiService(path.join(path.dirname(config.databasePath), 'wiki', 'agent-wiki.sqlite'));
  const workerDirectory = path.join(config.runtimeDir, 'workers');
  const workers = new WorkerPanelService(new WorkerEvidenceSource(db, projectService, liveOutputReader),
    new SharedSummaryRuntime(config.workerSummaries.runtimeCommand, path.join(workerDirectory, 'runs')),
    new WorkerSummaryAudit(workerDirectory), new WorkerSnapshotStore(workerDirectory), new WorkerUserActivity(db.meta, eventBus), db.meta, config.workerSummaries.enabled, Date.now,
    (enabled) => configService.setWorkerTracking(enabled));
  await wiki.backup().catch((error) => app.log.warn({ err: error }, 'Initial wiki backup failed.'));
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

  const instanceId = randomUUID();
  if (config.coordination.enabled) app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url === '/api/events') return; // Stream lifetime is not request latency.
    recordCoordinationTelemetry(config.runtimeDir, { kind: 'http', durationMs: reply.elapsedTime,
      outcome: reply.statusCode >= 400 ? 'error' : 'ok' });
  });
  app.get('/api/health', async (_request, reply) => {
    // Public readiness only: a settings change may move the server to a new
    // origin. No credentials or application data are exposed by this route.
    reply.header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'no-store');
    return { ok: true, instanceId };
  });

  await registerAuthRoutes(app, authService, { max: config.security.loginRateLimitMax, timeWindow: config.security.loginRateLimitWindowMs });
  await registerProjectRoutes(app, authService, indexing, sessions);
  await registerSearchRoutes(app, authService, search);
  await registerConversationRoutes(app, authService, db, projectService, providerRegistry, sessions, eventBus, liveOutputReader);
  await registerSessionRoutes(app, authService, db, projectService, providerRegistry, sessions, images);
  registerImageRoutes(app, authService, sessions, images);
  await registerEventRoutes(app, authService, eventBus);
  await registerSettingsRoutes(app, authService, configService, db, indexing, projectService, restartService);
  await registerCoordinationRoutes(app, authService, coordination);
  registerGrantRoutes(app, authService, grants, grantPush);
  registerWorkerRoutes(app, authService, workers);
  registerWikiRoutes(app, authService, wiki, projectService);
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
          || fileName === 'grant-push-sw.js'
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

  const coordinationSocket = config.coordination.enabled ? await startCoordinationSocket(coordination, config.runtimeDir, wiki, grants, agentLaunches) : undefined;
  if (config.coordination.enabled) agentLaunches.start();
  const stopTelemetry = config.coordination.enabled ? startCoordinationTelemetry(config.runtimeDir) : undefined;
  const coordinationTimer = config.coordination.enabled ? setInterval(() => { coordination.reconcileProcesses(); wakeAssignments(); }, 15_000) : undefined;
  coordinationTimer?.unref();
  const wikiBackupTimer = setInterval(() => { wiki.backup().catch((error) => app.log.warn({ err: error }, 'Wiki backup failed.')); }, 60 * 60 * 1000);
  wikiBackupTimer.unref();
  await indexing.loadProjectMetadata();
  await indexing.start();
  sessions.startSessionReconciliation();
  const runtimeCleanup = sessions.cleanupEndedSessionRuntimeDirs().catch((error) => {
    app.log.warn({ err: error }, 'Startup session-runtime cleanup failed.');
  });
  // Rebuild empty or outdated search indexes from cached conversations. Parser
  // upgrades invalidate search content even when transcript files are unchanged.
  // This runs off the startup path and yields between conversation writes.
  const searchBackfill = indexing.loadProjectMetadata({ backfillSearchIndex: true }).catch(() => {
    app.log.warn('Startup search-index backfill failed; use project refresh to rebuild.');
  });

  app.addHook('onClose', async () => {
    await agentLaunches.stop();
    await workers.stop();
    stopTelemetry?.();
    if (coordinationTimer) clearInterval(coordinationTimer);
    clearInterval(wikiBackupTimer);
    await coordinationSocket?.close();
    await indexing.stop();
    await Promise.all([runtimeCleanup, searchBackfill]);
    await sessions.stop();
    liveOutputReader.clear();
    await wiki.backup().catch((error) => app.log.warn({ err: error }, 'Final wiki backup failed.'));
    wiki.close();
    await db.searchIndex.close();
    db.close();
  });

  return { app, config };
}
