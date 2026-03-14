import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROVIDERS, type ConversationSummary, type ProviderId } from '@agent-console/shared';
import type { FastifyInstance } from 'fastify';
import { AppDatabase } from '../db/database.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { buildSyntheticConversationFromSession } from '../lib/conversation-summary.js';
import { uniqueBy } from '../lib/text.js';
import { ProjectService } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { filterUserVisibleMessages } from '../providers/transcripts/base.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { AuthService } from '../security/auth-service.js';
import { readLiveMessages } from '../sessions/live-output.js';
import { SessionManager } from '../sessions/session-manager.js';
import { nowIso } from '../lib/time.js';

const providerSchema = z.enum(PROVIDERS);
const renameConversationBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});

function parseProvider(raw: string): ProviderId {
  return providerSchema.parse(raw);
}

function resolveAdoptedConversationRef(summary: ConversationSummary | undefined): string | undefined {
  return typeof summary?.rawMetadata?.adoptedConversationRef === 'string'
    ? summary.rawMetadata.adoptedConversationRef
    : undefined;
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  authService: AuthService,
  db: AppDatabase,
  projectService: ProjectService,
  providerRegistry: ProviderRegistry,
  sessions: SessionManager,
  eventBus: RealtimeEventBus,
): Promise<void> {
  app.get('/api/conversations/:projectSlug/:provider/:conversationRef/messages', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const { projectSlug, provider: providerRaw, conversationRef } = request.params as { projectSlug: string; provider: string; conversationRef: string };
    const providerId = parseProvider(providerRaw);
    const project = await projectService.getProjectBySlug(projectSlug);
    if (!project) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }
    const providerSettings = projectService.getMergedProviderSettings(project, providerId);
    const provider = providerRegistry.get(providerId);

    const pendingSummary = db.getPendingConversation(conversationRef);
    const adoptedConversationRef = resolveAdoptedConversationRef(pendingSummary);
    const resolvedConversationRef = adoptedConversationRef ?? conversationRef;
    const cachedSummary = db.getConversationIndexEntry(projectSlug, providerId, resolvedConversationRef);
    let summary = adoptedConversationRef ? (cachedSummary ?? pendingSummary) : (pendingSummary ?? cachedSummary);
    let messages = [] as Awaited<ReturnType<typeof readLiveMessages>>;
    let visibleMessages = [] as Awaited<ReturnType<typeof readLiveMessages>>;
    let allMessages = [] as Awaited<ReturnType<typeof readLiveMessages>>;

    if (!pendingSummary || adoptedConversationRef) {
      const cachedConversation = summary ? await loadProviderConversationFromSummary(summary) : null;
      const conversation = cachedConversation
        ?? await provider.getConversation(project, resolvedConversationRef, providerSettings);
      if (conversation) {
        summary = {
          ...conversation.summary,
          title: cachedSummary?.title ?? pendingSummary?.title ?? conversation.summary.title,
          isBound: Boolean(cachedSummary?.isBound),
          boundSessionId: cachedSummary?.boundSessionId,
        };
        visibleMessages = conversation.messages;
        allMessages = conversation.allMessages ?? conversation.messages;
      }
    }

    const boundSession = db.getBoundSessionByConversation(projectSlug, providerId, resolvedConversationRef);
    const liveSessionState = boundSession ? await sessions.getSessionScreen(boundSession.id) : undefined;
    const liveScreen = liveSessionState?.screen;
    const resolvedBoundSession = liveSessionState?.session;
    const liveMessages = resolvedBoundSession ? await readLiveMessages(resolvedBoundSession) : [];
    const providerHasTranscript = allMessages.some((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
    const mergedAllMessages = uniqueBy(
      [
        ...allMessages,
        ...(providerHasTranscript
          ? liveMessages.filter((message) => message.role === 'status')
          : liveMessages),
      ],
      (message) => `${message.source}:${message.timestamp}:${message.role}:${message.text.trim()}`,
    )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const mergedMessages = uniqueBy(
      [
        ...visibleMessages,
        ...(providerHasTranscript
          ? liveMessages.filter((message) => message.role === 'user' || message.role === 'assistant')
          : filterUserVisibleMessages(liveMessages)),
      ],
      (message) => `${message.source}:${message.timestamp}:${message.role}:${message.text.trim()}`,
    ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (!summary) {
      if (resolvedBoundSession) {
        summary = buildSyntheticConversationFromSession(resolvedBoundSession);
      }
    }

    if (!summary) {
      reply.code(404).send({ error: 'Conversation not found.' });
      return;
    }

    return {
      conversation: {
        ...summary,
        isBound: Boolean(resolvedBoundSession),
        boundSessionId: resolvedBoundSession?.id,
      },
      messages: mergedMessages,
      allMessages: mergedAllMessages,
      boundSession: resolvedBoundSession,
      liveScreen,
    };
  });

  app.post('/api/conversations/:projectSlug/:provider/new/bind', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const { projectSlug, provider: providerRaw } = request.params as { projectSlug: string; provider: string };
    const providerId = parseProvider(providerRaw);
    const project = await projectService.getProjectBySlug(projectSlug);
    if (!project) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }
    const provider = providerRegistry.get(providerId);
    const providerSettings = projectService.getMergedProviderSettings(project, providerId);
    if (!providerSettings.enabled) {
      reply.code(404).send({ error: 'Provider is disabled for this project.' });
      return;
    }
    const existingPending = db.listPendingConversations()
      .find((conversation) => conversation.projectSlug === projectSlug && conversation.provider === providerId && conversation.isBound);
    if (existingPending?.boundSessionId) {
      const existingSession = sessions.getSessionById(existingPending.boundSessionId);
      if (existingSession && ['starting', 'bound', 'releasing'].includes(existingSession.status)) {
        return { session: existingSession, conversationRef: existingPending.ref };
      }
    }
    const pendingRef = `pending:${randomUUID()}`;
    const pendingConversation: ConversationSummary = {
      ref: pendingRef,
      kind: 'pending',
      projectSlug,
      provider: providerId,
      title: `New ${providerId === 'codex' ? 'Codex' : 'Claude'} conversation`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    };
    try {
      const session = await sessions.bindConversation({
        project,
        provider,
        providerSettings,
        conversationRef: pendingRef,
        title: pendingConversation.title,
        kind: 'pending',
      });
      db.putPendingConversation({ ...pendingConversation, boundSessionId: session.id, isBound: true });
      return { session, conversationRef: pendingRef };
    } catch (error) {
      db.deletePendingConversation(pendingRef);
      throw error;
    }
  });

  app.post('/api/conversations/:projectSlug/:provider/:conversationRef/bind', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const { projectSlug, provider: providerRaw, conversationRef } = request.params as { projectSlug: string; provider: string; conversationRef: string };
    const providerId = parseProvider(providerRaw);
    const project = await projectService.getProjectBySlug(projectSlug);
    if (!project) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }
    const provider = providerRegistry.get(providerId);
    const providerSettings = projectService.getMergedProviderSettings(project, providerId);
    if (!providerSettings.enabled) {
      reply.code(404).send({ error: 'Provider is disabled for this project.' });
      return;
    }
    const cached = db.getConversationIndexEntry(projectSlug, providerId, conversationRef);
    if (!cached) {
      reply.code(404).send({ error: 'Conversation not indexed.' });
      return;
    }
    const session = await sessions.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef,
      title: cached.title,
      kind: 'history',
    });
    return { session };
  });

  app.put('/api/conversations/:projectSlug/:provider/:conversationRef/title', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const { projectSlug, provider: providerRaw, conversationRef } = request.params as { projectSlug: string; provider: string; conversationRef: string };
    const providerId = parseProvider(providerRaw);
    const parsedBody = renameConversationBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid conversation title.', details: parsedBody.error.flatten() });
      return;
    }
    const project = await projectService.getProjectBySlug(projectSlug);
    if (!project) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }

    const pendingSummary = db.getPendingConversation(conversationRef);
    const adoptedConversationRef = resolveAdoptedConversationRef(pendingSummary);
    const resolvedConversationRef = adoptedConversationRef ?? conversationRef;
    const historySummary = db.getConversationIndexEntry(projectSlug, providerId, resolvedConversationRef);
    const summary = adoptedConversationRef ? (historySummary ?? pendingSummary) : (pendingSummary ?? historySummary);
    if (!summary) {
      reply.code(404).send({ error: 'Conversation not found.' });
      return;
    }

    const updatedAt = nowIso();
    const title = parsedBody.data.title.trim();
    db.setConversationTitleOverride(projectSlug, providerId, resolvedConversationRef, title, updatedAt);

    const boundSession = db.getBoundSessionByConversation(projectSlug, providerId, resolvedConversationRef);
    if (boundSession) {
      db.upsertBoundSession({
        ...boundSession,
        title,
        updatedAt,
      });
    }

    const updatedConversation = resolvedConversationRef.startsWith('pending:')
      ? db.getPendingConversation(resolvedConversationRef)
      : db.getConversationIndexEntry(projectSlug, providerId, resolvedConversationRef);

    if (!updatedConversation) {
      reply.code(500).send({ error: 'Updated conversation could not be loaded.' });
      return;
    }

    eventBus.emit({
      type: 'conversation.index-updated',
      projectSlug,
      provider: providerId,
      conversationRef: resolvedConversationRef,
      timestamp: updatedAt,
    });

    return { conversation: updatedConversation };
  });
}
