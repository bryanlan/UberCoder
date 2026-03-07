import fs from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { SessionManager } from '../sessions/session-manager.js';

const inputBodySchema = z.object({
  text: z.string().min(1),
});

export async function registerSessionRoutes(app: FastifyInstance, authService: AuthService, sessions: SessionManager): Promise<void> {
  app.post('/api/sessions/:sessionId/input', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsed = inputBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid input payload.', details: parsed.error.flatten() });
      return;
    }
    const sessionId = (request.params as { sessionId: string }).sessionId;
    return await sessions.sendInput(sessionId, parsed.data.text);
  });

  app.post('/api/sessions/:sessionId/release', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const sessionId = (request.params as { sessionId: string }).sessionId;
    await sessions.releaseSession(sessionId);
    reply.code(204).send();
  });

  app.get('/api/sessions/:sessionId/raw-output', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const session = sessions.getSessionById(sessionId);
    if (!session?.rawLogPath) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    try {
      return { text: await fs.readFile(session.rawLogPath, 'utf8') };
    } catch {
      return { text: '' };
    }
  });
}
