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
  let lastTreeObservationCompletedAt = 0;
  let treeObservationPromise: Promise<void> | undefined;

  async function maybeObserveSessionsForTree(): Promise<void> {
    if (treeObservationPromise) {
      await treeObservationPromise;
      return;
    }

    if (Date.now() - lastTreeObservationCompletedAt < TREE_OBSERVATION_INTERVAL_MS) {
      return;
    }

    let currentObservation: Promise<void>;
    currentObservation = (async () => {
      await sessions.observeSessions();
      lastTreeObservationCompletedAt = Date.now();
    })();
    treeObservationPromise = currentObservation;
    try {
      await currentObservation;
    } finally {
      if (treeObservationPromise === currentObservation) {
        treeObservationPromise = undefined;
      }
    }
  }

  app.get('/api/projects/tree', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    await maybeObserveSessionsForTree();
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
}
