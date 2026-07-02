import { useCallback, useMemo, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';
import type { ConversationTimeline, ProviderId } from '@agent-console/shared';
import { api } from '../../lib/api';

const TIMELINE_MESSAGE_PAGE_SIZE = 80;

export function conversationMetaQueryKey(
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
) {
  return ['conversation-meta', projectSlug, provider, conversationRef] as const;
}

export function timelineMessagesQueryKey(
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
) {
  return ['timeline-messages', projectSlug, provider, conversationRef] as const;
}

export function invalidateConversationData(
  queryClient: QueryClient,
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
): void {
  if (!projectSlug || !provider || !conversationRef) {
    return;
  }

  void queryClient.invalidateQueries({
    queryKey: conversationMetaQueryKey(projectSlug, provider, conversationRef),
    exact: true,
  });
  void queryClient.invalidateQueries({
    queryKey: timelineMessagesQueryKey(projectSlug, provider, conversationRef),
    exact: true,
  });
}

export function invalidateTimelineMessages(
  queryClient: QueryClient,
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
): void {
  if (!projectSlug || !provider || !conversationRef) {
    return;
  }

  void queryClient.invalidateQueries({
    queryKey: timelineMessagesQueryKey(projectSlug, provider, conversationRef),
    exact: true,
  });
}

interface UseConversationDataArgs {
  authenticated?: boolean;
  selectedProjectSlug?: string;
  selectedProvider?: ProviderId;
  selectedConversationRef?: string;
  debugOpen: boolean;
  realtimeDegraded: boolean;
}

function timelineMatchesSelection(
  timeline: ConversationTimeline,
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
): boolean {
  return Boolean(
    projectSlug
    && provider
    && conversationRef
    && timeline.conversation.projectSlug === projectSlug
    && timeline.conversation.provider === provider
    && timeline.conversation.ref === conversationRef,
  );
}

export function useConversationData({
  authenticated,
  selectedProjectSlug,
  selectedProvider,
  selectedConversationRef,
  debugOpen,
  realtimeDegraded,
}: UseConversationDataArgs) {
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);

  const enabled = Boolean(authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef);

  const metaQuery = useQuery({
    queryKey: conversationMetaQueryKey(selectedProjectSlug, selectedProvider, selectedConversationRef),
    queryFn: () => api.timeline(selectedProjectSlug!, selectedProvider!, selectedConversationRef!, { limit: 0 }),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      if (!realtimeDegraded) {
        return false;
      }
      return query.state.data?.boundSession ? 1000 : 5000;
    },
  });

  const selectedMetaTimeline = useMemo(() => {
    const meta = metaQuery.data;
    if (!meta) {
      return undefined;
    }
    if (
      metaQuery.isPlaceholderData
      && !timelineMatchesSelection(meta, selectedProjectSlug, selectedProvider, selectedConversationRef)
    ) {
      return undefined;
    }
    return meta;
  }, [
    metaQuery.data,
    metaQuery.isPlaceholderData,
    selectedConversationRef,
    selectedProjectSlug,
    selectedProvider,
  ]);
  const selectedBoundSession = selectedMetaTimeline?.boundSession;

  const messagesQuery = useInfiniteQuery({
    queryKey: timelineMessagesQueryKey(selectedProjectSlug, selectedProvider, selectedConversationRef),
    queryFn: ({ pageParam }) => api.timeline(
      selectedProjectSlug!,
      selectedProvider!,
      selectedConversationRef!,
      {
        limit: TIMELINE_MESSAGE_PAGE_SIZE,
        before: typeof pageParam === 'number' ? pageParam : undefined,
      },
    ),
    enabled,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.messagePage?.olderCursor,
    refetchInterval: selectedBoundSession?.isWorking ? 1200 : false,
  });

  const messagePages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    if (!messagesQuery.isPlaceholderData) {
      return pages;
    }
    return pages.filter((page) => timelineMatchesSelection(
      page,
      selectedProjectSlug,
      selectedProvider,
      selectedConversationRef,
    ));
  }, [
    messagesQuery.data?.pages,
    messagesQuery.isPlaceholderData,
    selectedConversationRef,
    selectedProjectSlug,
    selectedProvider,
  ]);

  const pagedTimelineMessages = useMemo(
    () => [...messagePages]
      .reverse()
      .flatMap((page) => page.messages),
    [messagePages],
  );

  const timeline = useMemo(() => {
    const meta = selectedMetaTimeline;
    if (!meta) {
      return undefined;
    }
    return {
      ...meta,
      messages: pagedTimelineMessages,
      messagePage: messagePages.at(-1)?.messagePage ?? meta.messagePage,
    };
  }, [
    messagePages,
    pagedTimelineMessages,
    selectedMetaTimeline,
  ]);

  const boundSession = timeline?.boundSession;
  const liveScreen = timeline?.liveScreen;
  const liveMode = Boolean(boundSession && liveScreen);

  const rawOutputQuery = useQuery({
    queryKey: ['raw-output', boundSession?.id],
    queryFn: () => api.rawOutput(boundSession!.id),
    enabled: Boolean(debugOpen && boundSession?.id),
    refetchInterval: realtimeDegraded && boundSession ? 1000 : false,
  });

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!messagesQuery.hasNextPage) {
      return;
    }

    await messagesQuery.fetchNextPage();
    setHistoryPrependVersion((current) => current + 1);
  }, [messagesQuery.fetchNextPage, messagesQuery.hasNextPage]);

  const tailKey = useMemo(() => {
    const messageCount = timeline?.messages.length ?? 0;
    const lastMessage = timeline?.messages.at(-1);
    if (liveMode && boundSession && liveScreen) {
      return `live:${boundSession.id}:${liveScreen.capturedAt}:${liveScreen.content.length}:${lastMessage?.id ?? 'no-history'}:${messageCount}`;
    }
    if (lastMessage) {
      return `history:${lastMessage.id}:${messageCount}`;
    }
    if (boundSession && liveScreen) {
      return `live-status:${boundSession.id}:${liveScreen.capturedAt}`;
    }
    return undefined;
  }, [boundSession, liveMode, liveScreen, timeline?.messages]);

  return {
    timeline,
    liveMode,
    loading: metaQuery.isLoading || (messagesQuery.isLoading && !messagesQuery.data),
    rawOutput: rawOutputQuery.data?.text,
    rawLoading: rawOutputQuery.isLoading,
    hasOlderMessages: Boolean(messagesQuery.hasNextPage),
    loadingOlderMessages: messagesQuery.isFetchingNextPage,
    loadOlderMessages,
    conversationKey: enabled ? `${selectedProjectSlug}:${selectedProvider}:${selectedConversationRef}` : undefined,
    historyPrependVersion,
    tailKey,
  };
}
