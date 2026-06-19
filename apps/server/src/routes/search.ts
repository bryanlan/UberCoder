import { z } from 'zod';
import type { ConversationSearchResponse } from '@agent-console/shared';
import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ConversationSearchService } from '../search/conversation-search.js';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function registerSearchRoutes(
  app: FastifyInstance,
  authService: AuthService,
  search: ConversationSearchService,
): Promise<void> {
  app.get('/api/search/conversations', async (request, reply): Promise<ConversationSearchResponse | undefined> => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return undefined;
    }
    const parsed = searchQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid search query.', details: parsed.error.flatten() });
      return undefined;
    }
    const query = parsed.data.q;
    return {
      query,
      results: await search.search(query, parsed.data.limit ?? 20),
    };
  });
}
