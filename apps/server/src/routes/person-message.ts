import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionManager } from '../sessions/session-manager.js';
import { SessionInputRejectedError } from '../sessions/session-manager.js';
import type { ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LiveOutputReader } from '../sessions/live-output/reader.js';
import type { AppDatabase } from '../db/database.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { mergeTimelineMessages } from '../sessions/timeline-merge.js';

/** Local unattended caller only. Never registered with the agent tool surfaces. */
export function registerPersonMessageRoutes(app: FastifyInstance, runtimeDir: string, sessions: SessionManager,
  projects: ProjectService, providers: ProviderRegistry, live: LiveOutputReader, db: AppDatabase) {
  const authorize = (request: FastifyRequest): boolean => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return false;
    try {
      const file = path.join(runtimeDir, 'person-message.key');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return false;
      const expected = fs.readFileSync(file, 'utf8').trim();
      const actual = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      return expected.length >= 32 && Buffer.byteLength(actual) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
    } catch { return false; }
  };
  const params = z.object({ sessionId: z.string().uuid() });
  const getSession = (request: FastifyRequest) => {
    const parsed = params.safeParse(request.params);
    return parsed.success ? sessions.getSessionById(parsed.data.sessionId) : undefined;
  };
  app.post('/api/local/person-message/:sessionId/input', { logLevel: 'silent', bodyLimit: 16384 }, async (request, reply) => {
    if (!authorize(request)) return reply.code(401).send({ error: 'Local credential required.' });
    const session = getSession(request);
    if (!session || session.status !== 'bound') return reply.code(404).send({ error: 'Bound session not found.' });
    const body = z.object({ text: z.string().min(8).max(12000).startsWith('Bryan: ') }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Expected a prefixed message.' });
    try { await sessions.sendInput(session.id, body.data.text); return { ok: true }; }
    catch (error) {
      if (error instanceof SessionInputRejectedError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.get('/api/local/person-message/:sessionId/messages', { logLevel: 'silent' }, async (request, reply) => {
    if (!authorize(request)) return reply.code(401).send({ error: 'Local credential required.' });
    const session = getSession(request);
    if (!session || session.status !== 'bound') return reply.code(404).send({ error: 'Bound session not found.' });
    const project = await projects.getProjectBySlug(session.projectSlug);
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    const reference = session.resumeConversationRef ?? session.conversationRef;
    const summary = db.conversationIndex.get(session.projectSlug, session.provider, reference);
    const cached = summary ? await loadProviderConversationFromSummary(summary) : null;
    const conversation = cached ?? await providers.get(session.provider).getConversation(project,
      reference, projects.getMergedProviderSettings(project, session.provider));
    const { mergedMessages } = mergeTimelineMessages({
      allMessages: conversation?.allMessages ?? conversation?.messages ?? [],
      visibleMessages: conversation?.messages ?? [],
      liveMessages: await live.readLiveMessages(session, { maxBytesFromEnd: 1024 * 1024 }),
    });
    return { sessionId: session.id, messages: mergedMessages.filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-100).map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp })) };
  });
}
