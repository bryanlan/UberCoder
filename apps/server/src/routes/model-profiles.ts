import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ModelProfilesUnavailableError, type ModelProfileService } from '../model-profiles/service.js';

/**
 * `GET /api/model-profiles`: the High, Medium and Low models of each provider, read from the workflow_optimizer catalog.
 * When the catalog cannot be read the answer is 503 with the reason, so the web can say so instead of guessing.
 */
export async function registerModelProfileRoutes(app: FastifyInstance, authService: AuthService, modelProfiles: ModelProfileService): Promise<void> {
  app.get('/api/model-profiles', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    try {
      reply.header('Cache-Control', 'no-store');
      return await modelProfiles.profiles();
    } catch (error) {
      if (error instanceof ModelProfilesUnavailableError) {
        reply.code(503).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
