import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ConversationTimeline, ProviderId } from '@agent-console/shared';
import { api } from '../../lib/api';

const TIMELINE_MESSAGE_PAGE_SIZE = 80;
const TIMELINE_HISTORY_ENABLE_DELAY_MS = 1000;

export function resetTimelineHistoryQuery(
  queryClient: QueryClient,
  projectSlug: string | undefined,
  provider: ProviderId | undefined,
  conversationRef: string | undefined,
): void {
  if (!projectSlug || !provider || !conversationRef) {
    return;
  }

  void queryClient.resetQueries({
    queryKey: ['timeline-history', projectSlug, provider, conversationRef],
    exact: true,
  });
}

interface UseConversationDataControllerArgs {
  authenticated?: boolean;
  selectedProjectSlug?: string;
  selectedProvider?: ProviderId;
  selectedConversationRef?: string;
  debugOpen: boolean;
  realtimeDegraded: boolean;
}

export function useConversationDataController({
  authenticated,
  selectedProjectSlug,
  selectedProvider,
  selectedConversationRef,
  debugOpen,
  realtimeDegraded,
}: UseConversationDataControllerArgs) {
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);
  const [retainedHistoryState, setRetainedHistoryState] = useState<{
    key?: string;
    pages: ConversationTimeline[];
  }>({ pages: [] });

  const conversationKey = selectedProjectSlug && selectedProvider && selectedConversationRef
    ? `${selectedProjectSlug}:${selectedProvider}:${selectedConversationRef}`
    : undefined;

  const timelineQuery = useQuery({
    queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
    queryFn: () => api.timeline(selectedProjectSlug!, selectedProvider!, selectedConversationRef!, { limit: 0 }),
    enabled: Boolean(authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef),
    refetchInterval: (query) => {
      if (!realtimeDegraded) {
        return false;
      }
      return query.state.data?.boundSession ? 1000 : 5000;
    },
  });

  const [historyEnabledKey, setHistoryEnabledKey] = useState<string>();
  const metadataReady = Boolean(timelineQuery.data);

  useEffect(() => {
    setHistoryEnabledKey(undefined);
    if (!conversationKey || !metadataReady) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setHistoryEnabledKey(conversationKey);
    }, TIMELINE_HISTORY_ENABLE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [conversationKey, metadataReady]);

  const timelineHistoryQuery = useInfiniteQuery({
    queryKey: ['timeline-history', selectedProjectSlug, selectedProvider, selectedConversationRef],
    queryFn: ({ pageParam }) => api.timeline(
      selectedProjectSlug!,
      selectedProvider!,
      selectedConversationRef!,
      {
        limit: TIMELINE_MESSAGE_PAGE_SIZE,
        before: typeof pageParam === 'number' ? pageParam : undefined,
      },
    ),
    enabled: Boolean(authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef && historyEnabledKey === conversationKey),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.messagePage?.olderCursor,
  });

  const historyPages = useMemo(
    () => timelineHistoryQuery.data?.pages
      ?? (retainedHistoryState.key === conversationKey ? retainedHistoryState.pages : []),
    [conversationKey, retainedHistoryState, timelineHistoryQuery.data?.pages],
  );

  useEffect(() => {
    if (!conversationKey || !timelineHistoryQuery.data) {
      return;
    }

    setRetainedHistoryState({ key: conversationKey, pages: timelineHistoryQuery.data.pages });
  }, [conversationKey, timelineHistoryQuery.data]);

  const pagedTimelineMessages = useMemo(
    () => [...historyPages]
      .reverse()
      .flatMap((page) => page.messages),
    [historyPages],
  );

  const timeline = useMemo(
    () => timelineQuery.data
      ? {
          ...timelineQuery.data,
          messages: pagedTimelineMessages,
          messagePage: historyPages.at(-1)?.messagePage,
        }
      : undefined,
    [historyPages, pagedTimelineMessages, timelineQuery.data],
  );

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
    if (!timelineHistoryQuery.hasNextPage) {
      return;
    }

    await timelineHistoryQuery.fetchNextPage();
    setHistoryPrependVersion((current) => current + 1);
  }, [timelineHistoryQuery.fetchNextPage, timelineHistoryQuery.hasNextPage]);

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

  const hasResolvedHistory = Boolean(timelineHistoryQuery.data) || (Boolean(conversationKey) && retainedHistoryState.key === conversationKey);

  return {
    timeline,
    liveMode,
    loading: timelineQuery.isLoading || (timelineHistoryQuery.isLoading && !hasResolvedHistory),
    rawOutput: rawOutputQuery.data?.text,
    rawLoading: rawOutputQuery.isLoading,
    hasOlderMessages: Boolean(timelineHistoryQuery.hasNextPage),
    loadingOlderMessages: timelineHistoryQuery.isFetchingNextPage,
    loadOlderMessages,
    conversationKey,
    historyPrependVersion,
    tailKey,
  };
}
