import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { IndexingService } from '../indexing/indexing-service.js';
import { SessionManager } from '../sessions/session-manager.js';

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
    await sessions.observeSessions();
    await indexing.refreshAll();
    return indexing.getTree();
  });

  app.addHook('onClose', async () => {
    clearTimeout(treeObservationTimer);
  });
}
