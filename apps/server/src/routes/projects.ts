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
  app.get('/api/projects/tree', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    await sessions.recoverSessions();
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
