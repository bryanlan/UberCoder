import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppDatabase } from '../db/database.js';
import { nowIso } from '../lib/time.js';
import { truncate, normalizeComparableText, stableTextHash } from '../lib/text.js';
import { ProjectService } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { AuthService } from '../security/auth-service.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../sessions/session-manager.js';

const inputBodySchema = z.object({
  text: z.string().min(1),
});
const screenQuerySchema = z.object({
  lines: z.coerce.number().int().min(50).max(20000).optional(),
});
const keystrokeKeySchema = z.enum(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'BSpace', 'Tab', 'C-c']);
const keystrokeBodySchema = z.object({
  text: z.string().min(1).optional(),
  keys: z.array(keystrokeKeySchema).min(1).optional(),
}).refine((value) => Boolean(value.text || value.keys?.length), {
  message: 'Expected literal text or at least one key token.',
});

export async function registerSessionRoutes(
  app: FastifyInstance,
  authService: AuthService,
  db: AppDatabase,
  projectService: ProjectService,
  providerRegistry: ProviderRegistry,
  sessions: SessionManager,
): Promise<void> {
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
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    const pendingConversation = session.conversationRef.startsWith('pending:')
      ? db.getPendingConversation(session.conversationRef)
      : undefined;
    const isFirstPendingCodexTurn =
      session.provider === 'codex'
      && Boolean(pendingConversation)
      && typeof pendingConversation?.rawMetadata?.lastUserInputHash !== 'string';
    if (isFirstPendingCodexTurn) {
      const project = await projectService.getProjectBySlug(session.projectSlug);
      if (!project) {
        reply.code(404).send({ error: 'Project not found.' });
        return;
      }
      const provider = providerRegistry.get(session.provider);
      const providerSettings = projectService.getMergedProviderSettings(project, session.provider);
      const restarted = await sessions.restartPendingSessionWithInitialPrompt({
        sessionId,
        project,
        provider,
        providerSettings,
        initialPrompt: parsed.data.text,
      });
      const rawMetadata = { ...(pendingConversation?.rawMetadata ?? {}) } as Record<string, unknown>;
      rawMetadata.lastUserInputHash = stableTextHash(normalizeComparableText(parsed.data.text));
      rawMetadata.lastUserInputPreview = truncate(parsed.data.text, 120);
      db.putPendingConversation({
        ...pendingConversation!,
        updatedAt: nowIso(),
        isBound: true,
        boundSessionId: restarted.id,
        rawMetadata,
      });
      return restarted;
    }
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

  app.get('/api/sessions/:sessionId/screen', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const parsedQuery = screenQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      reply.code(400).send({ error: 'Invalid screen query.', details: parsedQuery.error.flatten() });
      return;
    }
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    const screenState = await sessions.getSessionScreen(sessionId, {
      startLine: parsedQuery.data.lines ? -parsedQuery.data.lines : undefined,
    });
    if (!screenState) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    return screenState;
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
      const rawText = await fs.readFile(session.rawLogPath, 'utf8');
      const debugLogPath = path.join(path.dirname(session.rawLogPath), 'debug.log');
      let debugText = '';
      try {
        debugText = await fs.readFile(debugLogPath, 'utf8');
      } catch {
        debugText = '';
      }
      return {
        text: debugText.trim()
          ? `${rawText}\n\n===== session-debug =====\n${debugText}`
          : rawText,
      };
    } catch {
      return { text: '' };
    }
  });

  app.post('/api/sessions/:sessionId/keys', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsed = keystrokeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid keystroke payload.', details: parsed.error.flatten() });
      return;
    }
    const sessionId = (request.params as { sessionId: string }).sessionId;
    try {
      return await sessions.sendKeystrokes(sessionId, parsed.data);
    } catch (error) {
      if (error instanceof SessionKeystrokeRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
