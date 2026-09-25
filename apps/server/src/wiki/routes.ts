import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProjectService } from '../projects/project-service.js';
import type { AuthService } from '../security/auth-service.js';
import { WikiConflictError, WikiService, type WikiActor } from './service.js';

const paramsSchema = z.object({ projectSlug: z.string().min(1) });
const pageQuerySchema = z.object({
  title: z.string().min(1).max(160), revision: z.coerce.number().int().positive().optional(),
});
const historyQuerySchema = z.object({ title: z.string().min(1).max(160), offset: z.coerce.number().int().nonnegative().default(0) });
const listQuerySchema = z.object({ offset: z.coerce.number().int().nonnegative().default(0) });
const searchQuerySchema = z.object({ query: z.string().trim().min(1).max(160) });
const writeSchema = z.object({
  title: z.string().min(1).max(160), body: z.string().max(65_536),
  baseRevision: z.number().int().positive().nullable(), summary: z.string().max(200).optional(),
}).strict();

export function registerWikiRoutes(app: FastifyInstance, auth: AuthService, wiki: WikiService, projects: ProjectService): void {
  async function context(request: FastifyRequest, reply: FastifyReply) {
    let session;
    try { session = await auth.ensureAuthenticated(request, reply); } catch { return null; }
    const { projectSlug } = paramsSchema.parse(request.params);
    const project = await projects.getProjectBySlug(projectSlug);
    if (!project) { reply.code(404).send({ error: 'Project not found.' }); return null; }
    const actor: WikiActor = { kind: 'user', id: session.userLogin ?? session.id };
    return { checkout: project.path, actor };
  }

  function failure(reply: FastifyReply, error: unknown) {
    if (error instanceof WikiConflictError) return reply.code(409).send({ error: error.message, currentRevision: error.currentRevision });
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Wiki request failed.' });
  }

  app.get('/api/wiki/:projectSlug/pages', async (request, reply) => {
    try {
      const scope = await context(request, reply); if (!scope) return;
      return wiki.list(scope.checkout, scope.actor, listQuerySchema.parse(request.query).offset);
    } catch (error) { return failure(reply, error); }
  });

  app.get('/api/wiki/:projectSlug/page', async (request, reply) => {
    try {
      const scope = await context(request, reply); if (!scope) return;
      const { title, revision } = pageQuerySchema.parse(request.query);
      return { page: wiki.read(scope.checkout, title, scope.actor, revision) };
    } catch (error) { return failure(reply, error); }
  });

  app.get('/api/wiki/:projectSlug/history', async (request, reply) => {
    try {
      const scope = await context(request, reply); if (!scope) return;
      const { title, offset } = historyQuerySchema.parse(request.query);
      return wiki.history(scope.checkout, title, scope.actor, offset);
    } catch (error) { return failure(reply, error); }
  });

  app.get('/api/wiki/:projectSlug/search', async (request, reply) => {
    try {
      const scope = await context(request, reply); if (!scope) return;
      return wiki.search(scope.checkout, searchQuerySchema.parse(request.query).query, scope.actor);
    } catch (error) { return failure(reply, error); }
  });

  app.put('/api/wiki/:projectSlug/page', { bodyLimit: 96 * 1024 }, async (request, reply) => {
    try {
      const scope = await context(request, reply); if (!scope) return;
      return { page: wiki.write(scope.checkout, writeSchema.parse(request.body), scope.actor) };
    } catch (error) { return failure(reply, error); }
  });
}
