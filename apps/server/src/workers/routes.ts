import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../security/auth-service.js';
import type { WorkerPanelService } from './service.js';

export function registerWorkerRoutes(app: FastifyInstance, auth: AuthService, service: WorkerPanelService) {
  app.get('/api/workers/:workerId/opening-message', async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply, false); } catch { return; }
    const parsed = z.object({ workerId: z.string().min(1).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid worker.' });
    reply.header('Cache-Control', 'no-store');
    const opening = await service.openingMessage(parsed.data.workerId);
    return opening ?? reply.code(404).send({ error: 'Worker information is unavailable.' });
  });
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
  app.post('/api/workers/tracking', async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply); } catch { return; }
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose On or Off for worker tracking.' });
    reply.header('Cache-Control', 'no-store');
    return service.setTracking(parsed.data.enabled);
  });
}
