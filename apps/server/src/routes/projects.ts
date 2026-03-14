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
  const TREE_RECOVERY_INTERVAL_MS = 5_000;
  let lastTreeRecoveryCompletedAt = 0;
  let treeRecoveryPromise: Promise<void> | undefined;

  async function maybeRecoverSessionsForTree(): Promise<void> {
    if (treeRecoveryPromise) {
      await treeRecoveryPromise;
      return;
    }

    if (Date.now() - lastTreeRecoveryCompletedAt < TREE_RECOVERY_INTERVAL_MS) {
      return;
    }

    let currentRecovery: Promise<void>;
    currentRecovery = (async () => {
      await sessions.recoverSessions();
      lastTreeRecoveryCompletedAt = Date.now();
    })();
    treeRecoveryPromise = currentRecovery;
    try {
      await currentRecovery;
    } finally {
      if (treeRecoveryPromise === currentRecovery) {
        treeRecoveryPromise = undefined;
      }
    }
  }

  app.get('/api/projects/tree', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    await maybeRecoverSessionsForTree();
    return indexing.getTree();
  });

  app.post('/api/projects/refresh', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    await sessions.recoverSessions();
    await indexing.refreshAll();
    return indexing.getTree();
  });
}
