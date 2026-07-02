import type { InfiniteData } from '@tanstack/react-query';
import type {
  BoundSession,
  ConversationTimeline,
  NormalizedMessage,
  ProjectSummary,
  ProviderId,
  TreeResponse,
} from '@agent-console/shared';

const OPTIMISTIC_MESSAGE_DUPLICATE_WINDOW_MS = 15_000;

function isActiveSessionStatus(status: BoundSession['status']): boolean {
  return status === 'starting' || status === 'bound' || status === 'releasing';
}

function getConversationUpdatedAtFromSession(session: BoundSession): string {
  return session.lastCompletedAt ?? session.startedAt;
}

function buildSyntheticConversationFromSession(session: BoundSession): ProjectSummary['providers'][ProviderId]['conversations'][number] {
  return {
    ref: session.conversationRef,
    kind: session.conversationRef.startsWith('pending:') ? 'pending' : 'history',
    projectSlug: session.projectSlug,
    provider: session.provider,
    title: session.title ?? 'Live session',
    createdAt: session.startedAt,
    updatedAt: getConversationUpdatedAtFromSession(session),
    isBound: true,
    boundSessionId: session.id,
    degraded: false,
    rawMetadata: {
      syntheticSessionPlaceholder: true,
    },
  };
}

function isSyntheticSessionPlaceholder(
  conversation: ProjectSummary['providers'][ProviderId]['conversations'][number],
): boolean {
  return conversation.rawMetadata?.syntheticSessionPlaceholder === true;
}

export function applySessionUpdateToTree(current: TreeResponse | undefined, session: BoundSession): TreeResponse | undefined {
  if (!current) {
    return current;
  }

  const active = isActiveSessionStatus(session.status);
  const nextBoundSessions = current.boundSessions.filter((item) => item.id !== session.id);
  if (active) {
    nextBoundSessions.unshift(session);
    nextBoundSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  return {
    ...current,
    boundSessions: nextBoundSessions,
    projects: current.projects.map((project) => {
      if (project.slug !== session.projectSlug) {
        return project;
      }

      return {
        ...project,
        providers: {
          ...project.providers,
          [session.provider]: {
            ...project.providers[session.provider],
            conversations: (() => {
              let foundTarget = false;
              const nextConversations = project.providers[session.provider].conversations.flatMap((conversation) => {
                if (conversation.ref === session.conversationRef) {
                  foundTarget = true;
                  if (!active && isSyntheticSessionPlaceholder(conversation)) {
                    return [];
                  }
                  return [{
                    ...conversation,
                    title: session.title ?? conversation.title,
                    updatedAt: session.lastCompletedAt ?? conversation.updatedAt,
                    isBound: active,
                    boundSessionId: active ? session.id : undefined,
                  }];
                }
                if (conversation.boundSessionId === session.id) {
                  if (isSyntheticSessionPlaceholder(conversation)) {
                    return [];
                  }
                  return [{
                    ...conversation,
                    isBound: false,
                    boundSessionId: undefined,
                  }];
                }
                return [conversation];
              });

              if (active && !foundTarget) {
                nextConversations.unshift(buildSyntheticConversationFromSession(session));
              }
              return nextConversations;
            })(),
          },
        },
      };
    }),
  };
}

export function applySessionActivityToTree(
  current: TreeResponse | undefined,
  input: { sessionId: string; timestamp: string },
): TreeResponse | undefined {
  if (!current) {
    return current;
  }

  return {
    ...current,
    boundSessions: current.boundSessions.map((session) => (
      session.id !== input.sessionId
        ? session
        : {
            ...session,
            updatedAt: input.timestamp,
            lastActivityAt: input.timestamp,
            lastOutputAt: input.timestamp,
          }
    )),
  };
}

export function applySessionUpdateToTimeline(
  current: ConversationTimeline | undefined,
  session: BoundSession,
): ConversationTimeline | undefined {
  if (!current) {
    return current;
  }

  const matchesCurrent =
    current.boundSession?.id === session.id
    || (
      current.conversation.projectSlug === session.projectSlug
      && current.conversation.provider === session.provider
      && current.conversation.ref === session.conversationRef
    );
  if (!matchesCurrent) {
    return current;
  }

  const active = isActiveSessionStatus(session.status);
  const nextRef = current.boundSession?.id === session.id
    ? session.conversationRef
    : current.conversation.ref;
  const refChanged = nextRef !== current.conversation.ref;
  return {
    ...current,
    conversation: {
      ...current.conversation,
      ref: nextRef,
      kind: refChanged ? (session.conversationRef.startsWith('pending:') ? 'pending' : 'history') : current.conversation.kind,
      title: session.title ?? current.conversation.title,
      updatedAt: session.lastCompletedAt ?? current.conversation.updatedAt,
      isBound: active,
      boundSessionId: active ? session.id : undefined,
    },
    boundSession: active
      ? {
          ...(current.boundSession ?? session),
          ...session,
        }
      : undefined,
  };
}

export function applySessionActivityToTimeline(
  current: ConversationTimeline | undefined,
  input: { sessionId: string; timestamp: string },
): ConversationTimeline | undefined {
  if (!current || current.boundSession?.id !== input.sessionId) {
    return current;
  }

  return {
    ...current,
    boundSession: {
      ...current.boundSession,
      updatedAt: input.timestamp,
      lastActivityAt: input.timestamp,
      lastOutputAt: input.timestamp,
    },
  };
}

function messageTimestampMs(message: NormalizedMessage): number | undefined {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messagesRepresentSameTimelineEntry(a: NormalizedMessage, b: NormalizedMessage): boolean {
  if (a.id === b.id) {
    return true;
  }
  if (a.role !== b.role || a.text.trim() !== b.text.trim()) {
    return false;
  }
  if (a.source !== b.source && a.rawMetadata?.optimistic !== true && b.rawMetadata?.optimistic !== true) {
    return false;
  }
  const aMs = messageTimestampMs(a);
  const bMs = messageTimestampMs(b);
  return aMs !== undefined
    && bMs !== undefined
    && Math.abs(aMs - bMs) <= OPTIMISTIC_MESSAGE_DUPLICATE_WINDOW_MS;
}

function preferTimelineMessage(existing: NormalizedMessage, candidate: NormalizedMessage): NormalizedMessage {
  if (existing.rawMetadata?.optimistic === true && candidate.rawMetadata?.optimistic !== true) {
    return candidate;
  }
  return existing;
}

export function mergeTimelineMessage(messages: NormalizedMessage[], message: NormalizedMessage): NormalizedMessage[] {
  const duplicateIndex = messages.findIndex((existing) => messagesRepresentSameTimelineEntry(existing, message));
  if (duplicateIndex !== -1) {
    const next = [...messages];
    next[duplicateIndex] = preferTimelineMessage(next[duplicateIndex]!, message);
    return next;
  }

  return [...messages, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function appendTimelineMessage(
  current: ConversationTimeline | undefined,
  message: NormalizedMessage,
): ConversationTimeline | undefined {
  if (!current) {
    return current;
  }
  const messages = mergeTimelineMessage(current.messages, message);
  return {
    ...current,
    messages,
    messagePage: current.messagePage
      ? {
          ...current.messagePage,
          total: Math.max(current.messagePage.total, messages.length),
        }
      : current.messagePage,
  };
}

export function removeTimelineMessage(
  current: ConversationTimeline | undefined,
  messageId: string,
): ConversationTimeline | undefined {
  if (!current) {
    return current;
  }
  const messages = current.messages.filter((message) => message.id !== messageId);
  if (messages.length === current.messages.length) {
    return current;
  }
  return {
    ...current,
    messages,
    messagePage: current.messagePage
      ? {
          ...current.messagePage,
          total: Math.max(0, current.messagePage.total - 1),
        }
      : current.messagePage,
  };
}

export type TimelineHistoryData = InfiniteData<ConversationTimeline, number | undefined>;

export function appendTimelineHistoryMessage(
  current: TimelineHistoryData | undefined,
  message: NormalizedMessage,
): TimelineHistoryData | undefined {
  if (!current?.pages.length) {
    return current;
  }
  const pages = [...current.pages];
  const newestPage = pages[0];
  if (!newestPage) {
    return current;
  }
  pages[0] = appendTimelineMessage(newestPage, message) ?? newestPage;
  return {
    ...current,
    pages,
  };
}

export function removeTimelineHistoryMessage(
  current: TimelineHistoryData | undefined,
  messageId: string,
): TimelineHistoryData | undefined {
  if (!current?.pages.length) {
    return current;
  }
  let changed = false;
  const pages = current.pages.map((page) => {
    const next = removeTimelineMessage(page, messageId);
    if (next !== page) {
      changed = true;
    }
    return next ?? page;
  });
  return changed ? { ...current, pages } : current;
}

export function buildLiveUserMessage(input: {
  sessionId: string;
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  messageId?: string;
  text: string;
  timestamp: string;
  optimistic?: boolean;
}): NormalizedMessage {
  return {
    id: input.messageId ?? `${input.optimistic ? 'optimistic' : 'live'}:${input.sessionId}:${input.timestamp}:user:${input.text}`,
    provider: input.provider,
    role: 'user',
    lifecycle: 'durable',
    text: input.text,
    timestamp: input.timestamp,
    conversationRef: input.conversationRef,
    source: 'user-input',
    rawMetadata: input.optimistic ? { optimistic: true } : undefined,
  };
}
