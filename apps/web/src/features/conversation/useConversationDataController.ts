import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ConversationTimeline, ProviderId, SessionScreen } from '@agent-console/shared';
import { api } from '../../lib/api';

const TIMELINE_MESSAGE_PAGE_SIZE = 80;
const LIVE_SCREEN_SCROLLBACK_LINES = 20_000;

function timestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeScreenTailText(scrollbackText: string | undefined, tailText: string | undefined): string | undefined {
  if (!scrollbackText) {
    return tailText;
  }
  if (!tailText) {
    return scrollbackText;
  }
  if (scrollbackText.endsWith(tailText)) {
    return scrollbackText;
  }

  const scrollbackLines = scrollbackText.split('\n');
  const tailLines = tailText.split('\n');
  const maxOverlap = Math.min(scrollbackLines.length, tailLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (scrollbackLines[scrollbackLines.length - overlap + index] !== tailLines[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return [...scrollbackLines, ...tailLines.slice(overlap)].join('\n');
    }
  }

  return `${scrollbackText.replace(/\n*$/, '')}\n${tailText.replace(/^\n*/, '')}`;
}

function mergeLiveScreenSnapshot(
  scrollbackScreen: SessionScreen | undefined,
  latestScreen: SessionScreen | undefined,
): SessionScreen | undefined {
  if (!scrollbackScreen) {
    return latestScreen;
  }
  if (!latestScreen || timestampMs(scrollbackScreen.capturedAt) >= timestampMs(latestScreen.capturedAt)) {
    return scrollbackScreen;
  }

  const contentAnsi = mergeScreenTailText(
    scrollbackScreen.contentAnsi ?? scrollbackScreen.content,
    latestScreen.contentAnsi ?? latestScreen.content,
  );

  return {
    ...latestScreen,
    content: mergeScreenTailText(scrollbackScreen.content, latestScreen.content) ?? latestScreen.content,
    contentAnsi,
  };
}

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
    enabled: Boolean(authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef),
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

  const baseTimeline = useMemo(
    () => timelineQuery.data
      ? {
          ...timelineQuery.data,
          messages: pagedTimelineMessages,
          messagePage: historyPages.at(-1)?.messagePage,
        }
      : undefined,
    [historyPages, pagedTimelineMessages, timelineQuery.data],
  );

  const baseBoundSession = baseTimeline?.boundSession;
  const liveScreenQuery = useQuery({
    queryKey: ['session-screen', baseBoundSession?.id, LIVE_SCREEN_SCROLLBACK_LINES],
    queryFn: () => api.sessionScreen(baseBoundSession!.id, LIVE_SCREEN_SCROLLBACK_LINES),
    enabled: Boolean(authenticated && baseBoundSession?.id),
    refetchInterval: realtimeDegraded && baseBoundSession ? 1000 : false,
  });

  const boundSession = liveScreenQuery.data?.session ?? baseBoundSession;
  const liveScreen = useMemo(
    () => mergeLiveScreenSnapshot(liveScreenQuery.data?.screen, baseTimeline?.liveScreen),
    [baseTimeline?.liveScreen, liveScreenQuery.data?.screen],
  );
  const timeline = useMemo(
    () => baseTimeline
      ? {
          ...baseTimeline,
          boundSession,
          liveScreen,
        }
      : undefined,
    [baseTimeline, boundSession, liveScreen],
  );
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
