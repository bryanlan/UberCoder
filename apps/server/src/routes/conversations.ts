import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROVIDERS, type BoundSession, type ConversationSummary, type NormalizedMessage, type ProviderId, type SessionScreen } from '@agent-console/shared';
import type { FastifyInstance } from 'fastify';
import { AppDatabase } from '../db/database.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { buildSyntheticConversationFromSession } from '../lib/conversation-summary.js';
import { normalizeComparableText, uniqueBy } from '../lib/text.js';
import { ProjectService } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { filterUserVisibleMessages } from '../providers/transcripts/base.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { AuthService } from '../security/auth-service.js';
import { readLiveMessages } from '../sessions/live-output.js';
import { SessionManager } from '../sessions/session-manager.js';
import { nowIso } from '../lib/time.js';

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
const LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const SHORT_EXACT_DUPLICATE_WINDOW_MS = 30 * 1000;
const CONTAINMENT_DUPLICATE_MIN_LENGTH = 80;
const TRANSCRIPT_BACKED_LIVE_EVENT_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LIVE_SCREEN_DUPLICATE_MIN_LENGTH = 30;
const LIVE_SCREEN_DURABLE_OVERLAP_MARGIN_CHARS = 2_000;

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

function messagesShareTimelinePageRun(previous: NormalizedMessage, next: NormalizedMessage): boolean {
  return previous.role === next.role
    && (previous.role === 'assistant' || previous.role === 'user');
}

interface ComparableMessage {
  role: NormalizedMessage['role'];
  timestampMs?: number;
  comparable: string;
  compact: string;
}

interface TranscriptMessageIndex {
  bucketedByRole: Map<NormalizedMessage['role'], Map<number, ComparableMessage[]>>;
  untimedByRole: Map<NormalizedMessage['role'], ComparableMessage[]>;
}

function toComparableMessage(message: NormalizedMessage): ComparableMessage | undefined {
  const comparable = normalizeComparableText(message.text);
  if (!comparable) {
    return undefined;
  }

  const timestampMs = Date.parse(message.timestamp);
  return {
    role: message.role,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
    comparable,
    compact: comparable.replace(/[^a-z0-9]+/g, ''),
  };
}

function timestampBucket(timestampMs: number): number {
  return Math.floor(timestampMs / LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS);
}

function appendComparableMessage(
  map: Map<NormalizedMessage['role'], ComparableMessage[]>,
  message: ComparableMessage,
): void {
  const existing = map.get(message.role);
  if (existing) {
    existing.push(message);
    return;
  }
  map.set(message.role, [message]);
}

function buildTranscriptMessageIndex(messages: NormalizedMessage[]): TranscriptMessageIndex {
  const bucketedByRole = new Map<NormalizedMessage['role'], Map<number, ComparableMessage[]>>();
  const untimedByRole = new Map<NormalizedMessage['role'], ComparableMessage[]>();

  for (const message of messages) {
    const comparable = toComparableMessage(message);
    if (!comparable) {
      continue;
    }

    if (comparable.timestampMs === undefined) {
      appendComparableMessage(untimedByRole, comparable);
      continue;
    }

    const bucket = timestampBucket(comparable.timestampMs);
    let roleBuckets = bucketedByRole.get(comparable.role);
    if (!roleBuckets) {
      roleBuckets = new Map<number, ComparableMessage[]>();
      bucketedByRole.set(comparable.role, roleBuckets);
    }
    const bucketMessages = roleBuckets.get(bucket);
    if (bucketMessages) {
      bucketMessages.push(comparable);
    } else {
      roleBuckets.set(bucket, [comparable]);
    }
  }

  return { bucketedByRole, untimedByRole };
}

function comparableTextsMatch(a: ComparableMessage, b: ComparableMessage): boolean {
  const minLength = Math.min(a.comparable.length, b.comparable.length);
  if (a.comparable === b.comparable) {
    if (minLength >= CONTAINMENT_DUPLICATE_MIN_LENGTH) {
      return true;
    }
    return a.timestampMs !== undefined
      && b.timestampMs !== undefined
      && Math.abs(a.timestampMs - b.timestampMs) <= SHORT_EXACT_DUPLICATE_WINDOW_MS;
  }

  if (minLength < CONTAINMENT_DUPLICATE_MIN_LENGTH) {
    return false;
  }

  return a.compact.includes(b.compact) || b.compact.includes(a.compact);
}

function comparableTimestampsAreNear(a: ComparableMessage, b: ComparableMessage): boolean {
  if (a.timestampMs === undefined || b.timestampMs === undefined) {
    return true;
  }

  return Math.abs(a.timestampMs - b.timestampMs) <= LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS;
}

function getTranscriptCandidates(
  index: TranscriptMessageIndex,
  liveMessage: ComparableMessage,
): ComparableMessage[] {
  const untimed = index.untimedByRole.get(liveMessage.role) ?? [];
  if (liveMessage.timestampMs === undefined) {
    return untimed;
  }

  const roleBuckets = index.bucketedByRole.get(liveMessage.role);
  if (!roleBuckets) {
    return untimed;
  }

  const bucket = timestampBucket(liveMessage.timestampMs);
  return [
    ...(roleBuckets.get(bucket - 1) ?? []),
    ...(roleBuckets.get(bucket) ?? []),
    ...(roleBuckets.get(bucket + 1) ?? []),
    ...untimed,
  ];
}

function liveMessageIsInTranscript(
  liveMessage: NormalizedMessage,
  index: TranscriptMessageIndex,
): boolean {
  const comparableLiveMessage = toComparableMessage(liveMessage);
  if (!comparableLiveMessage) {
    return false;
  }

  return getTranscriptCandidates(index, comparableLiveMessage)
    .some((transcriptMessage) => (
      comparableTimestampsAreNear(comparableLiveMessage, transcriptMessage)
      && comparableTextsMatch(comparableLiveMessage, transcriptMessage)
    ));
}

function filterTranscriptBackedLiveMessages(
  liveMessages: NormalizedMessage[],
  transcriptMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const transcriptIndex = buildTranscriptMessageIndex(transcriptMessages);
  return liveMessages.filter((liveMessage) => !liveMessageIsInTranscript(liveMessage, transcriptIndex));
}

function normalizeLiveTailText(text: string): string {
  return normalizeComparableText(text).replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitLines(text: string | undefined): string[] {
  return (text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function isDurableLiveTailMessage(message: NormalizedMessage): boolean {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

function buildDurableLiveTailText(
  durableMessages: NormalizedMessage[],
  screenComparableLength: number,
): string {
  const minComparableLength = screenComparableLength + LIVE_SCREEN_DURABLE_OVERLAP_MARGIN_CHARS;
  const selectedTexts: string[] = [];
  let selectedComparableLength = 0;

  for (let index = durableMessages.length - 1; index >= 0; index -= 1) {
    const message = durableMessages[index];
    if (!message || !isDurableLiveTailMessage(message)) {
      continue;
    }

    selectedTexts.unshift(message.text);
    selectedComparableLength += normalizeLiveTailText(message.text).length + 1;
    if (selectedComparableLength >= minComparableLength) {
      break;
    }
  }

  return normalizeLiveTailText(selectedTexts.join('\n'));
}

function trimDurableMessagesToScreenContent(
  durableMessages: NormalizedMessage[],
  screenContent: string,
): NormalizedMessage[] {
  const comparableScreenContent = normalizeLiveTailText(screenContent);
  let end = durableMessages.length;

  while (end > 0) {
    const message = durableMessages[end - 1];
    if (!message || message.role !== 'user' || message.source !== 'user-input') {
      break;
    }

    const comparableMessageText = normalizeLiveTailText(message.text);
    if (
      comparableMessageText.length >= LIVE_SCREEN_DUPLICATE_MIN_LENGTH
      && comparableScreenContent.includes(comparableMessageText)
    ) {
      break;
    }

    end -= 1;
  }

  return end === durableMessages.length ? durableMessages : durableMessages.slice(0, end);
}

function trimLiveScreenToActiveTail(
  screen: SessionScreen | undefined,
  durableMessages: NormalizedMessage[],
): SessionScreen | undefined {
  if (!screen) {
    return undefined;
  }

  const contentLines = splitLines(screen.content);
  const ansiLines = splitLines(screen.contentAnsi ?? screen.content);
  const screenContent = contentLines.join('\n');
  const screenComparableLength = normalizeLiveTailText(screenContent).length;
  const durableText = buildDurableLiveTailText(
    trimDurableMessagesToScreenContent(durableMessages, screenContent),
    screenComparableLength,
  );
  if (!durableText) {
    return screen;
  }

  let cutLineCount = 0;
  for (let lineCount = 1; lineCount <= contentLines.length; lineCount += 1) {
    const candidate = normalizeLiveTailText(contentLines.slice(0, lineCount).join('\n'));
    if (candidate.length < LIVE_SCREEN_DUPLICATE_MIN_LENGTH) {
      continue;
    }
    if (durableText.endsWith(candidate)) {
      cutLineCount = lineCount;
    }
  }

  if (cutLineCount === 0) {
    return screen;
  }

  const content = contentLines.slice(cutLineCount).join('\n').trim();
  const contentAnsi = ansiLines.slice(cutLineCount).join('\n').trim();
  return {
    ...screen,
    content,
    contentAnsi: contentAnsi || content,
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
  app.get('/api/conversations/:projectSlug/:provider/:conversationRef/messages', async (request, reply) => {
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
    const liveSessionState = boundSession ? await sessions.getSessionScreen(boundSession.id) : undefined;
    const rawLiveScreen = liveSessionState?.screen;
    const resolvedBoundSession = liveSessionState?.session;

    if (!summary && resolvedBoundSession) {
      summary = buildSyntheticConversationFromSession(resolvedBoundSession);
    }

    if (metadataOnly && summary && !resolvedBoundSession) {
      const emptyPage = paginateMessages([], parsedQuery.data);
      return {
        conversation: {
          ...summary,
          isBound: false,
          boundSessionId: undefined,
        },
        messages: emptyPage.pageMessages,
        allMessages: [],
        boundSession: resolvedBoundSession,
        liveScreen: undefined,
        messagePage: emptyPage.pageInfo,
      };
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

    const providerHasTranscript = allMessages.some((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
    const liveMessages = resolvedBoundSession
      ? await readLiveMessages(
        resolvedBoundSession,
        providerHasTranscript ? { maxBytesFromEnd: TRANSCRIPT_BACKED_LIVE_EVENT_LOG_TAIL_BYTES } : {},
      )
      : [];
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
    const liveMessagesNotInTranscript = filterTranscriptBackedLiveMessages(liveMessages, visibleMessages);
    const mergedMessages = uniqueBy(
      [
        ...visibleMessages,
        ...(providerHasTranscript
          ? liveMessagesNotInTranscript.filter((message) => message.role === 'user')
          : filterUserVisibleMessages(liveMessages)),
      ],
      (message) => `${message.source}:${message.timestamp}:${message.role}:${message.text.trim()}`,
    ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const pagedMessages = paginateMessages(mergedMessages, {
      ...parsedQuery.data,
      samePageRun: messagesShareTimelinePageRun,
    });
    const liveScreen = trimLiveScreenToActiveTail(rawLiveScreen, mergedMessages);

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
      messages: pagedMessages.pageMessages,
      allMessages: metadataOnly ? [] : mergedAllMessages,
      boundSession: resolvedBoundSession,
      liveScreen,
      messagePage: pagedMessages.pageInfo,
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
