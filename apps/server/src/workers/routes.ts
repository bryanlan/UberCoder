import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../security/auth-service.js';
import type { WorkerPanelService } from './service.js';

export function registerWorkerRoutes(app: FastifyInstance, auth: AuthService, service: WorkerPanelService) {
  app.get('/api/workers', async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply, false); } catch { return; }
    reply.header('Cache-Control', 'no-store');
    return service.snapshot();
  });
  app.post('/api/workers/refresh', async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply); } catch { return; }
    const parsed = z.object({ intervalMinutes: z.number().int().min(1).max(5) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose a refresh interval from one to five minutes.' });
    reply.header('Cache-Control', 'no-store');
    return service.refresh(parsed.data.intervalMinutes);
  });
}
