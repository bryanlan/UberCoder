import type { FastifyInstance } from 'fastify';
import { MAX_IMAGE_BYTES } from '@agent-console/shared';
import type { AuthService } from '../security/auth-service.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { ImageStore, ImageUploadError } from './store.js';

export function registerImageRoutes(app: FastifyInstance, auth: AuthService, sessions: SessionManager, images: ImageStore): void {
  app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/images', { bodyLimit: MAX_IMAGE_BYTES }, async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply); } catch { return; }
    const session = sessions.getSessionById(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: 'Paste a PNG, JPEG or WebP image.' });
    try {
      const image = await images.save(request.body, (request.headers['content-type'] ?? '').split(';')[0]!, session);
      return reply.code(201).send({ image });
    } catch (error) {
      if (error instanceof ImageUploadError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { imageId: string } }>('/api/images/:imageId', async (request, reply) => {
    try { await auth.ensureAuthenticated(request, reply); } catch { return; }
    try {
      const { attachment, bytes } = await images.read(request.params.imageId);
      return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(attachment.mediaType).send(bytes);
    } catch (error) {
      if (error instanceof ImageUploadError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
