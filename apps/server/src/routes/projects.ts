import type { FastifyInstance } from 'fastify';
import type { ConversationSummary, TreeResponse } from '@agent-console/shared';
import { z } from 'zod';
import { nowIso } from '../lib/time.js';
import { AuthService } from '../security/auth-service.js';
import { IndexingService } from '../indexing/indexing-service.js';
import { SessionManager } from '../sessions/session-manager.js';

export const RECENT_AUTO_TRACK_WINDOW_MS = 8 * 60 * 60 * 1000;

const refreshProjectsBodySchema = z.object({
  autoTrackRecent: z.boolean().optional(),
});

export function findRecentUnboundConversations(
  tree: TreeResponse,
  nowMs = Date.now(),
): ConversationSummary[] {
  const cutoffMs = nowMs - RECENT_AUTO_TRACK_WINDOW_MS;
  return tree.projects.flatMap((project) => (
    (['codex', 'claude'] as const).flatMap((provider) => (
      project.providers[provider].conversations.filter((conversation) => {
        if (conversation.kind !== 'history' || conversation.isBound || conversation.degraded) {
          return false;
        }
        const activityMs = Date.parse(conversation.updatedAt);
        return Number.isFinite(activityMs) && activityMs >= cutoffMs && activityMs <= nowMs;
      })
    ))
  ));
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  authService: AuthService,
  indexing: IndexingService,
  sessions: SessionManager,
): Promise<void> {
  const TREE_OBSERVATION_INTERVAL_MS = 5_000;
  const TREE_OBSERVATION_DEFER_MS = 60_000;
  let lastTreeObservationCompletedAt = 0;
  let treeObservationPromise: Promise<void> | undefined;
  let treeObservationTimer: NodeJS.Timeout | undefined;

  function maybeObserveSessionsForTree(): void {
    if (treeObservationPromise || treeObservationTimer) {
      return;
    }

    if (Date.now() - lastTreeObservationCompletedAt < TREE_OBSERVATION_INTERVAL_MS) {
      return;
    }

    treeObservationTimer = setTimeout(() => {
      treeObservationTimer = undefined;
      const currentObservation = sessions.observeSessions()
        .then(() => {
          lastTreeObservationCompletedAt = Date.now();
        })
        .catch((error) => {
          app.log.warn({ err: error }, 'Failed to observe live sessions for project tree refresh.');
        })
        .finally(() => {
          if (treeObservationPromise === currentObservation) {
            treeObservationPromise = undefined;
          }
        });
      treeObservationPromise = currentObservation;
    }, TREE_OBSERVATION_DEFER_MS);
  }

  app.get('/api/projects/tree', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    maybeObserveSessionsForTree();
    return indexing.getTree();
  });

  app.post('/api/projects/refresh', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsedBody = refreshProjectsBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid project refresh payload.', details: parsedBody.error.flatten() });
      return;
    }
    await indexing.refreshAll();
    if (parsedBody.data.autoTrackRecent === true) {
      const autoTrackedAt = nowIso();
      const autoTrackResult = await sessions.autoTrackConversations(
        findRecentUnboundConversations(indexing.getTree(), Date.parse(autoTrackedAt)),
        autoTrackedAt,
      );
      if (autoTrackResult.failed.length > 0) {
        app.log.warn({
          attempted: autoTrackResult.attempted,
          tracked: autoTrackResult.tracked.length,
          failures: autoTrackResult.failed,
        }, 'Project refresh completed with recent-conversation auto-track failures.');
      }
    }
    return indexing.getTree();
  });

  app.addHook('onClose', async () => {
    clearTimeout(treeObservationTimer);
  });
}
