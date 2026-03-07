import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { nowIso } from '../lib/time.js';

export async function registerEventRoutes(app: FastifyInstance, authService: AuthService, eventBus: RealtimeEventBus): Promise<void> {
  app.get('/api/events', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const write = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    write({ type: 'heartbeat', timestamp: nowIso() });
    const unsubscribe = eventBus.subscribe((event) => write(event));
    const heartbeat = setInterval(() => write({ type: 'heartbeat', timestamp: nowIso() }), 20_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
