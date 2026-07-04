import type { QueryClient } from '@tanstack/react-query';
import type { ConversationTimeline, NormalizedMessage, ProviderId, SessionEvent, TreeResponse } from '@agent-console/shared';
import {
  conversationMetaQueryKey,
  invalidateConversationData,
  sessionScreenQueryKey,
  timelineMessagesQueryKey,
} from '../conversation/useConversationData';
import {
  applySessionActivityToTimeline,
  applySessionActivityToTree,
  applySessionUpdateToTimeline,
  applySessionUpdateToTree,
  buildLiveUserMessage,
} from './reducers';

export interface ApplySessionEventContext {
  queryClient: QueryClient;
  selectedProjectSlug?: string;
  selectedProvider?: ProviderId;
  selectedConversationRef?: string;
  selectedConversationRouteActive: boolean;
  timelineBoundSessionId?: string;
  debugOpen: boolean;
  appendMessageToConversationCache: (input: {
    projectSlug: string;
    provider: ProviderId;
    conversationRef: string;
    message: NormalizedMessage;
  }) => void;
  scheduleTimelineMessageRefresh: (projectSlug: string, provider: ProviderId, conversationRef: string) => void;
}

function hasSelectedConversation(context: ApplySessionEventContext): context is ApplySessionEventContext & {
  selectedProjectSlug: string;
  selectedProvider: ProviderId;
  selectedConversationRef: string;
} {
  return Boolean(context.selectedProjectSlug && context.selectedProvider && context.selectedConversationRef);
}

function eventTargetsSelectedConversation(
  context: ApplySessionEventContext,
  event: { sessionId?: string; projectSlug?: string; provider?: ProviderId; conversationRef?: string },
): boolean {
  return event.sessionId === context.timelineBoundSessionId
    || (
      event.projectSlug === context.selectedProjectSlug
      && event.provider === context.selectedProvider
      && event.conversationRef === context.selectedConversationRef
    );
}

function invalidateSelectedTimeline(context: ApplySessionEventContext): void {
  if (!hasSelectedConversation(context)) {
    return;
  }
  invalidateConversationData(
    context.queryClient,
    context.selectedProjectSlug,
    context.selectedProvider,
    context.selectedConversationRef,
  );
}

export function applySessionEvent(event: SessionEvent, context: ApplySessionEventContext): void {
  if (event.type === 'heartbeat') {
    return;
  }

  if (event.type === 'session.screen-updated') {
    if (eventTargetsSelectedConversation(context, event) && hasSelectedConversation(context)) {
      void context.queryClient.invalidateQueries({
        queryKey: sessionScreenQueryKey(event.sessionId),
        exact: true,
      });
      void context.queryClient.invalidateQueries({
        queryKey: conversationMetaQueryKey(context.selectedProjectSlug, context.selectedProvider, context.selectedConversationRef),
      });
    }
    return;
  }

  if (event.type === 'session.raw-output') {
    const matchesSelectedSession = eventTargetsSelectedConversation(context, event);
    context.queryClient.setQueryData<TreeResponse | undefined>(
      ['tree'],
      (current) => applySessionActivityToTree(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    context.queryClient.setQueryData<ConversationTimeline | undefined>(
      conversationMetaQueryKey(event.projectSlug, event.provider, event.conversationRef),
      (current) => applySessionActivityToTimeline(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    if (event.sessionId === context.timelineBoundSessionId && context.debugOpen) {
      context.queryClient.invalidateQueries({ queryKey: ['raw-output', event.sessionId] });
    }
    if (matchesSelectedSession && hasSelectedConversation(context)) {
      context.scheduleTimelineMessageRefresh(
        context.selectedProjectSlug,
        context.selectedProvider,
        context.selectedConversationRef,
      );
    }
    return;
  }

  if (event.type === 'session.transcript-updated') {
    const matchesSelectedSession = eventTargetsSelectedConversation(context, event);
    context.queryClient.setQueryData<TreeResponse | undefined>(
      ['tree'],
      (current) => applySessionActivityToTree(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    context.queryClient.setQueryData<ConversationTimeline | undefined>(
      conversationMetaQueryKey(event.projectSlug, event.provider, event.conversationRef),
      (current) => applySessionActivityToTimeline(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    if (matchesSelectedSession && hasSelectedConversation(context)) {
      context.scheduleTimelineMessageRefresh(
        context.selectedProjectSlug,
        context.selectedProvider,
        context.selectedConversationRef,
      );
    }
    return;
  }

  if (event.type === 'session.user-input') {
    context.queryClient.setQueryData<TreeResponse | undefined>(
      ['tree'],
      (current) => applySessionActivityToTree(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    context.queryClient.setQueryData<ConversationTimeline | undefined>(
      conversationMetaQueryKey(event.projectSlug, event.provider, event.conversationRef),
      (current) => applySessionActivityToTimeline(current, { sessionId: event.sessionId, timestamp: event.timestamp }),
    );
    context.appendMessageToConversationCache({
      projectSlug: event.projectSlug,
      provider: event.provider,
      conversationRef: event.conversationRef,
      message: buildLiveUserMessage({
        sessionId: event.sessionId,
        projectSlug: event.projectSlug,
        provider: event.provider,
        conversationRef: event.conversationRef,
        messageId: event.messageId,
        text: event.text,
        timestamp: event.timestamp,
      }),
    });
    return;
  }

  if (event.type === 'session.updated') {
    context.queryClient.setQueryData<TreeResponse | undefined>(
      ['tree'],
      (current) => applySessionUpdateToTree(current, event.session),
    );
    context.queryClient.setQueryData<ConversationTimeline | undefined>(
      conversationMetaQueryKey(event.session.projectSlug, event.session.provider, event.session.conversationRef),
      (current) => applySessionUpdateToTimeline(current, event.session),
    );
    if (hasSelectedConversation(context)) {
      context.queryClient.setQueryData<ConversationTimeline | undefined>(
        conversationMetaQueryKey(context.selectedProjectSlug, context.selectedProvider, context.selectedConversationRef),
        (current) => applySessionUpdateToTimeline(current, event.session),
      );
      if (eventTargetsSelectedConversation(context, { ...event.session, sessionId: event.session.id })) {
        void context.queryClient.invalidateQueries({
          queryKey: timelineMessagesQueryKey(context.selectedProjectSlug, context.selectedProvider, context.selectedConversationRef),
          exact: true,
        });
      }
    }
    return;
  }

  if (event.type === 'session.released') {
    context.queryClient.invalidateQueries({ queryKey: ['tree'] });
    if (eventTargetsSelectedConversation(context, event)) {
      invalidateSelectedTimeline(context);
    }
    return;
  }

  if (event.type === 'conversation.index-updated') {
    context.queryClient.invalidateQueries({ queryKey: ['tree'] });
    const eventTargetsSelection = Boolean(
      event.projectSlug
      && event.provider
      && event.conversationRef
      && (
        event.projectSlug === context.selectedProjectSlug
        && event.provider === context.selectedProvider
        && event.conversationRef === context.selectedConversationRef
      ),
    );
    if (context.selectedConversationRouteActive && eventTargetsSelection) {
      invalidateSelectedTimeline(context);
    }
    return;
  }

  if (context.selectedConversationRouteActive) {
    invalidateSelectedTimeline(context);
  }
}

export type RealtimeEventHandler = (event: SessionEvent) => void;
