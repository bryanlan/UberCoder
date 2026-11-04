import type { InfiniteData } from '@tanstack/react-query';
import type {
  BoundSession,
  ImageAttachment,
  ConversationTimeline,
  NormalizedMessage,
  ProjectSummary,
  ProviderId,
  TreeResponse,
} from '@agent-console/shared';
import { agentDrivenBy } from '@agent-console/shared';

/** The list label for a chat an agent launched. It is cleared, not just left off, once the person has replied in the chat. */
function agentControlledField(session: BoundSession): { agentControlled?: { launcherName: string } } {
  return session.launchContext ? { agentControlled: agentDrivenBy(session.launchContext) } : {};
}

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
    ...agentControlledField(session),
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
  const previous = current.boundSessions.find((item) => item.id === session.id);
  // An update built before the person's reply was recorded must not make the chat agent-driven again.
  const repliedAt = session.launchContext?.humanRepliedAt ?? previous?.launchContext?.humanRepliedAt;
  if (session.launchContext && repliedAt && !session.launchContext.humanRepliedAt) {
    session = { ...session, launchContext: { ...session.launchContext, humanRepliedAt: repliedAt } };
  }
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
                    ...agentControlledField(session),
                  }];
                }
                if (conversation.boundSessionId === session.id) {
                  if (
                    isSyntheticSessionPlaceholder(conversation)
                    || (conversation.kind === 'pending' && !session.conversationRef.startsWith('pending:'))
                  ) {
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
  input: { sessionId: string; timestamp: string; fromPerson?: boolean },
): TreeResponse | undefined {
  if (!current) {
    return current;
  }

  const target = current.boundSessions.find((session) => session.id === input.sessionId);
  // The person's first message in a chat an agent launched makes it theirs as well: it joins the list. That holds
  // when they reopened a saved agent chat too, where the new session has no launch record but the chat is still marked.
  const person = input.fromPerson === true ? target : undefined;
  const firstReply = person?.launchContext !== undefined && !person.launchContext.humanRepliedAt;
  const markedConversation = person !== undefined && current.projects.some((project) => project.slug === person.projectSlug
    && project.providers[person.provider].conversations.some((conversation) => conversation.boundSessionId === person.id && conversation.agentControlled));
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
            ...(firstReply && session.launchContext ? { launchContext: { ...session.launchContext, humanRepliedAt: input.timestamp } } : {}),
          }
    )),
    ...(person && markedConversation ? {
      projects: current.projects.map((project) => (project.slug !== person.projectSlug ? project : {
        ...project,
        providers: {
          ...project.providers,
          [person.provider]: {
            ...project.providers[person.provider],
            conversations: project.providers[person.provider].conversations.map((conversation) => (
              conversation.boundSessionId === person.id ? { ...conversation, agentControlled: undefined } : conversation
            )),
          },
        },
      })),
    } : {}),
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
          queuedInputs: session.queuedInputs,
          // Absent means none are open: the spread above would otherwise keep a question that was answered.
          pendingRequests: session.pendingRequests,
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

function preferTimelineMessage(existing: NormalizedMessage, candidate: NormalizedMessage): NormalizedMessage {
  if (existing.rawMetadata?.optimistic === true && candidate.rawMetadata?.optimistic !== true) {
    return candidate;
  }
  return existing;
}

export function mergeTimelineMessage(messages: NormalizedMessage[], message: NormalizedMessage): NormalizedMessage[] {
  const duplicateIndex = messages.findIndex((existing) => existing.id === message.id);
  if (duplicateIndex !== -1) {
    const next = [...messages];
    next[duplicateIndex] = preferTimelineMessage(next[duplicateIndex]!, message);
    return next;
  }

  return [...messages, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function replaceTimelineMessage(
  current: ConversationTimeline | undefined,
  input: { replaceMessageId: string; message: NormalizedMessage },
): ConversationTimeline | undefined {
  if (!current) {
    return current;
  }
  const withoutReplaced = current.messages.filter((message) => message.id !== input.replaceMessageId);
  const messages = mergeTimelineMessage(withoutReplaced, input.message);
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

export type TimelineMessagesData = InfiniteData<ConversationTimeline, number | undefined>;

export function appendTimelineMessagesMessage(
  current: TimelineMessagesData | undefined,
  message: NormalizedMessage,
): TimelineMessagesData | undefined {
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

export function replaceTimelineMessagesMessage(
  current: TimelineMessagesData | undefined,
  input: { replaceMessageId: string; message: NormalizedMessage },
): TimelineMessagesData | undefined {
  if (!current?.pages.length) {
    return current;
  }
  const pages = [...current.pages];
  const newestPage = pages[0];
  if (!newestPage) {
    return current;
  }
  pages[0] = replaceTimelineMessage(newestPage, input) ?? newestPage;
  return {
    ...current,
    pages,
  };
}

export function removeTimelineMessagesMessage(
  current: TimelineMessagesData | undefined,
  messageId: string,
): TimelineMessagesData | undefined {
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
  optimisticNonce?: string;
  text: string;
  timestamp: string;
  optimistic?: boolean;
  images?: ImageAttachment[];
}): NormalizedMessage {
  const id = input.messageId
    ?? (input.optimisticNonce ? `optimistic:${input.sessionId}:${input.optimisticNonce}` : undefined)
    ?? `${input.optimistic ? 'optimistic' : 'live'}:${input.sessionId}:${input.timestamp}:user:${input.text}`;
  return {
    id,
    provider: input.provider,
    role: 'user',
    lifecycle: 'durable',
    text: input.text,
    images: input.images,
    timestamp: input.timestamp,
    conversationRef: input.conversationRef,
    source: 'user-input',
    rawMetadata: input.optimistic ? { optimistic: true, optimisticNonce: input.optimisticNonce } : undefined,
  };
}
