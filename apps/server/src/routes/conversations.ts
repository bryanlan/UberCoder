import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROVIDERS, type BoundSession, type ConversationSummary, type NormalizedMessage, type ProviderId, type SessionScreen } from '@agent-console/shared';
import type { FastifyInstance } from 'fastify';
import { AppDatabase } from '../db/database.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { buildSyntheticConversationFromSession } from '../lib/conversation-summary.js';
import { ProjectService } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { AuthService } from '../security/auth-service.js';
import { readLiveMessages } from '../sessions/live-output.js';
import { SessionManager } from '../sessions/session-manager.js';
import { nowIso } from '../lib/time.js';
import { mergeTimelineMessages, messagesShareTimelinePageRun } from '../sessions/timeline-merge.js';

const providerSchema = z.enum(PROVIDERS);
const bindConversationBodySchema = z.object({
  force: z.boolean().optional(),
  initialPrompt: z.string().trim().min(1).optional(),
});
const renameConversationBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});
const timelineQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(0).max(200).optional(),
});
const LIVE_EVENT_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LIVE_TIMELINE_METADATA_RESPONSE_CACHE_MS = 1_000;
const LIVE_TIMELINE_RESPONSE_CACHE_MAX_ENTRIES = 200;

interface MessagePaginationOptions<T> {
  before?: number;
  limit?: number;
  samePageRun?: (previous: T, next: T) => boolean;
}

function parseProvider(raw: string): ProviderId {
  return providerSchema.parse(raw);
}

function resolveAdoptedConversationRef(summary: ConversationSummary | undefined): string | undefined {
  return typeof summary?.rawMetadata?.adoptedConversationRef === 'string'
    ? summary.rawMetadata.adoptedConversationRef
    : undefined;
}

function paginateMessages<T>(
  messages: T[],
  options: MessagePaginationOptions<T>,
): {
  pageMessages: T[];
  pageInfo?: {
    hasOlder: boolean;
    olderCursor?: number;
    total: number;
  };
} {
  const { before, limit } = options;
  if (limit === undefined) {
    return { pageMessages: messages };
  }

  const cappedEnd = before !== undefined ? Math.min(messages.length, Math.max(0, before)) : messages.length;
  let start = Math.max(0, cappedEnd - limit);
  if (limit > 0 && options.samePageRun) {
    while (start > 0) {
      const previous = messages[start - 1];
      const next = messages[start];
      if (previous === undefined || next === undefined || !options.samePageRun(previous, next)) {
        break;
      }
      start -= 1;
    }
  }
  return {
    pageMessages: messages.slice(start, cappedEnd),
    pageInfo: {
      hasOlder: start > 0,
      olderCursor: start > 0 ? start : undefined,
      total: messages.length,
    },
  };
}

type MessagePageInfo = ReturnType<typeof paginateMessages<NormalizedMessage>>['pageInfo'];

interface TimelineResponse {
  conversation: ConversationSummary;
  messages: NormalizedMessage[];
  allMessages: NormalizedMessage[];
  boundSession: BoundSession | undefined;
  liveScreen: SessionScreen | undefined;
  messagePage: MessagePageInfo;
}

const liveTimelineResponseCache = new Map<string, { expiresAt: number; response: TimelineResponse }>();

function getLiveTimelineResponseCacheKey(input: {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  before?: number;
  limit?: number;
}): string {
  return [
    input.projectSlug,
    input.provider,
    input.conversationRef,
    input.before ?? '',
    input.limit ?? '',
  ].join('\u0000');
}

function getCachedLiveTimelineResponse(cacheKey: string | undefined): TimelineResponse | undefined {
  if (!cacheKey) {
    return undefined;
  }

  const cached = liveTimelineResponseCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    liveTimelineResponseCache.delete(cacheKey);
    return undefined;
  }

  return cached.response;
}

function rememberLiveTimelineResponse(cacheKey: string | undefined, response: TimelineResponse, ttlMs: number): TimelineResponse {
  if (!cacheKey) {
    return response;
  }

  if (liveTimelineResponseCache.size >= LIVE_TIMELINE_RESPONSE_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, cached] of liveTimelineResponseCache) {
      if (cached.expiresAt <= now || liveTimelineResponseCache.size >= LIVE_TIMELINE_RESPONSE_CACHE_MAX_ENTRIES) {
        liveTimelineResponseCache.delete(key);
      }
    }
  }

  liveTimelineResponseCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    response,
  });
  return response;
}

function hideReadableScreenContent(screen: SessionScreen | undefined): SessionScreen | undefined {
  if (!screen) {
    return undefined;
  }
  return {
    ...screen,
    content: '',
    contentAnsi: '',
  };
}

function clearUnrestorablePendingBinding(db: AppDatabase, pending: ConversationSummary, session: BoundSession): void {
  const updatedAt = nowIso();
  db.putPendingConversation({
    ...pending,
    isBound: false,
    boundSessionId: undefined,
    updatedAt,
  });
  db.upsertBoundSession({
    ...session,
    status: 'ended',
    shouldRestore: false,
    updatedAt,
    isWorking: false,
    pid: undefined,
  });
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
  app.get('/api/conversations/:projectSlug/:provider/:conversationRef/messages', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const { projectSlug, provider: providerRaw, conversationRef } = request.params as { projectSlug: string; provider: string; conversationRef: string };
    const parsedQuery = timelineQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      reply.code(400).send({ error: 'Invalid timeline query.', details: parsedQuery.error.flatten() });
      return;
    }
    const providerId = parseProvider(providerRaw);
    const metadataOnly = parsedQuery.data.limit === 0;
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
    const boundSession = db.getBoundSessionByConversation(projectSlug, providerId, resolvedConversationRef);
    const liveTimelineResponseCacheKey = boundSession && metadataOnly
      ? getLiveTimelineResponseCacheKey({
        projectSlug,
        provider: providerId,
        conversationRef: resolvedConversationRef,
        before: parsedQuery.data.before,
        limit: parsedQuery.data.limit,
      })
      : undefined;
    const cachedLiveTimelineResponse = getCachedLiveTimelineResponse(liveTimelineResponseCacheKey);
    if (cachedLiveTimelineResponse) {
      return cachedLiveTimelineResponse;
    }

    const liveSessionState = boundSession ? await sessions.getSessionScreen(boundSession.id) : undefined;
    const rawLiveScreen = liveSessionState?.screen;
    const resolvedBoundSession = liveSessionState?.session;

    if (!summary && resolvedBoundSession) {
      summary = buildSyntheticConversationFromSession(resolvedBoundSession);
    }

    if (metadataOnly && summary) {
      const emptyPage = paginateMessages([], parsedQuery.data);
      const liveScreen = hideReadableScreenContent(rawLiveScreen);
      return rememberLiveTimelineResponse(liveTimelineResponseCacheKey, {
        conversation: {
          ...summary,
          isBound: Boolean(resolvedBoundSession),
          boundSessionId: resolvedBoundSession?.id,
        },
        messages: emptyPage.pageMessages,
        allMessages: [],
        boundSession: resolvedBoundSession,
        liveScreen,
        messagePage: emptyPage.pageInfo,
      }, LIVE_TIMELINE_METADATA_RESPONSE_CACHE_MS);
    }

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

    const liveMessages = resolvedBoundSession
      ? await readLiveMessages(
        resolvedBoundSession,
        { maxBytesFromEnd: LIVE_EVENT_LOG_TAIL_BYTES },
      )
      : [];
    const { mergedMessages } = mergeTimelineMessages({
      allMessages,
      visibleMessages,
      liveMessages,
    });
    const pagedMessages = metadataOnly
      ? paginateMessages([], parsedQuery.data)
      : paginateMessages(mergedMessages, {
        ...parsedQuery.data,
        samePageRun: messagesShareTimelinePageRun,
      });
    const liveScreen = hideReadableScreenContent(rawLiveScreen);

    if (!summary) {
      reply.code(404).send({ error: 'Conversation not found.' });
      return;
    }

    return rememberLiveTimelineResponse(liveTimelineResponseCacheKey, {
      conversation: {
        ...summary,
        isBound: Boolean(resolvedBoundSession),
        boundSessionId: resolvedBoundSession?.id,
      },
      messages: pagedMessages.pageMessages,
      allMessages: [],
      boundSession: resolvedBoundSession,
      liveScreen,
      messagePage: pagedMessages.pageInfo,
    }, LIVE_TIMELINE_METADATA_RESPONSE_CACHE_MS);
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
      if (existingSession?.shouldRestore) {
        const liveSession = await sessions.ensureSession(existingSession.id);
        if (liveSession) {
          return { session: liveSession, conversationRef: existingPending.ref };
        }
        const refreshedSession = sessions.getSessionById(existingSession.id);
        if (refreshedSession?.shouldRestore) {
          if (refreshedSession.conversationRef === existingPending.ref && refreshedSession.conversationRef.startsWith('pending:')) {
            clearUnrestorablePendingBinding(db, existingPending, refreshedSession);
          } else {
            reply.code(409).send({ error: 'Existing pending conversation is still bound but could not be restored.' });
            return;
          }
        }
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
    const parsedBody = bindConversationBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid bind payload.', details: parsedBody.error.flatten() });
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
    const pendingSummary = db.getPendingConversation(conversationRef);
    const adoptedConversationRef = resolveAdoptedConversationRef(pendingSummary);
    const resolvedConversationRef = adoptedConversationRef ?? conversationRef;
    const cached = db.getConversationIndexEntry(projectSlug, providerId, resolvedConversationRef);
    if (!cached) {
      if (pendingSummary && !parsedBody.data.force) {
        const existingSession = pendingSummary.boundSessionId
          ? sessions.getSessionById(pendingSummary.boundSessionId)
          : sessions.getSessionByConversation(projectSlug, providerId, conversationRef);
        if (existingSession?.shouldRestore) {
          const liveSession = await sessions.ensureSession(existingSession.id);
          if (liveSession) {
            return { session: liveSession };
          }
          const refreshedSession = sessions.getSessionById(existingSession.id);
          if (refreshedSession?.shouldRestore) {
            reply.code(409).send({ error: 'Pending conversation is already bound but could not be restored.' });
            return;
          }
        }
      }
      reply.code(404).send({ error: 'Conversation not indexed.' });
      return;
    }
    if (!parsedBody.data.force) {
      const existingSession = sessions.getSessionByConversation(projectSlug, providerId, resolvedConversationRef);
      if (existingSession?.shouldRestore) {
        const liveSession = await sessions.ensureSession(existingSession.id);
        if (liveSession) {
          return { session: liveSession };
        }
        const refreshedSession = sessions.getSessionById(existingSession.id);
        if (refreshedSession?.shouldRestore) {
          reply.code(409).send({ error: 'Conversation is already bound but could not be restored.' });
          return;
        }
      }
    }
    if (parsedBody.data.force) {
      const existingSession = sessions.getSessionByConversation(projectSlug, providerId, resolvedConversationRef);
      if (existingSession) {
        await sessions.releaseSession(existingSession.id);
      }
    }
    const session = await sessions.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: resolvedConversationRef,
      title: cached.title,
      kind: 'history',
      initialPrompt: parsedBody.data.initialPrompt,
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
    db.updateConversationSearchTitle(projectSlug, providerId, resolvedConversationRef, title);

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
