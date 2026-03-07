import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';

const loginBodySchema = z.object({
  password: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, authService: AuthService, rateLimit: { max: number; timeWindow: number }): Promise<void> {
  app.get('/api/auth/me', async (request, reply) => {
    const state = await authService.getAuthState(request, reply);
    return state;
  });

  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindow,
      },
    },
  }, async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid login request.', details: parsed.error.flatten() });
      return;
    }
    if (!authService.verifyPassword(parsed.data.password)) {
      reply.code(401).send({ error: 'Invalid password.' });
      return;
    }
    return await authService.loginWithPassword(reply);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    await authService.logout(request, reply);
    reply.code(204).send();
  });
}
