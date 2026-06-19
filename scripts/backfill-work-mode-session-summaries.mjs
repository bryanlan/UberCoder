#!/usr/bin/env node
import { ConfigService } from '../apps/server/dist/config/service.js';
import { AppDatabase } from '../apps/server/dist/db/database.js';
import { isTreeVisibleBoundSession } from '../apps/server/dist/lib/bound-session-state.js';
import { isConversationVisibleInDiscovery } from '../apps/server/dist/lib/conversation-visibility.js';
import { ProjectService } from '../apps/server/dist/projects/project-service.js';
import { ProviderRegistry } from '../apps/server/dist/providers/registry.js';
import { RealtimeEventBus } from '../apps/server/dist/realtime/event-bus.js';
import { SessionSummaryService } from '../apps/server/dist/summaries/session-summary-service.js';

function resolveSessionTitle(db, session) {
  const summary = session.conversationRef.startsWith('pending:')
    ? db.getPendingConversation(session.conversationRef)
    : db.getConversationIndexEntry(session.projectSlug, session.provider, session.conversationRef);
  return summary?.title ?? session.title ?? 'Live session';
}

async function listVisibleWorkModeSessions(db, projectService) {
  const activeProjects = await projectService.listActiveProjects();
  const activeProjectSlugs = new Set(activeProjects.map((project) => project.slug));
  return db.listBoundSessions()
    .filter((session) => isTreeVisibleBoundSession(session) && activeProjectSlugs.has(session.projectSlug))
    .filter((session) => isConversationVisibleInDiscovery({ title: resolveSessionTitle(db, session) }));
}

function formatSession(session) {
  return `${session.projectSlug}/${session.provider}/${session.conversationRef}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const configService = new ConfigService(process.env.AGENT_CONSOLE_CONFIG);
  const config = configService.getConfig();
  const db = new AppDatabase(config.databasePath);
  const projectService = new ProjectService(configService);
  const providerRegistry = new ProviderRegistry();
  const eventBus = new RealtimeEventBus();
  const service = new SessionSummaryService(
    db,
    projectService,
    providerRegistry,
    config.runtimeDir,
    eventBus,
  );

  try {
    const sessions = await listVisibleWorkModeSessions(db, projectService);
    const existing = db.listSessionInteractionSummariesBySessionIds(sessions.map((session) => session.id));
    const missingLastHour = sessions.filter((session) => {
      const summary = existing.get(session.id);
      return summary?.status !== 'ready' || !summary.recentChangesSummary || !summary.windowEndAt;
    });

    console.log(`Visible Work mode sessions: ${sessions.length}`);
    console.log(`Missing ready last-hour summaries before run: ${missingLastHour.length}`);
    if (dryRun) {
      console.log('Dry run only; no summaries generated.');
      return;
    }
    if (missingLastHour.length === 0) {
      console.log('No missing summaries; nothing to backfill.');
      return;
    }
    console.log('Starting forced Spark summary backfill...');

    await service.runOnce({
      bootstrap: true,
      force: true,
      sessionIds: missingLastHour.map((session) => session.id),
      onProgress: ({ index, total, session, status }) => {
        const title = resolveSessionTitle(db, session);
        if (status === 'summarizing') {
          console.log(`[${index}/${total}] summarizing ${formatSession(session)} :: ${title}`);
          return;
        }
        console.log(`[${index}/${total}] ${status} ${formatSession(session)}`);
      },
    });

    const after = db.listSessionInteractionSummariesBySessionIds(sessions.map((session) => session.id));
    const remaining = sessions.filter((session) => {
      const summary = after.get(session.id);
      return summary?.status !== 'ready' || !summary.recentChangesSummary || !summary.windowEndAt;
    });
    console.log(`Missing ready last-hour summaries after run: ${remaining.length}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
