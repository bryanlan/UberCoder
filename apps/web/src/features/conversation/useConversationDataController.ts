import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ConversationTimeline, ProviderId } from '@agent-console/shared';
import { api } from '../../lib/api';

const TIMELINE_MESSAGE_PAGE_SIZE = 80;
const DEFAULT_LIVE_OUTPUT_LINES = 240;
const LIVE_OUTPUT_LINE_INCREMENT = 360;
const MAX_LIVE_OUTPUT_LINES = 20_000;

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

function renderScreenText(screen?: ConversationTimeline['liveScreen']): string {
  if (!screen) {
    return '';
  }

  return `${screen.contentAnsi ?? screen.content}\n${screen.statusAnsi ?? screen.status}`;
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
  const [liveOutputLines, setLiveOutputLines] = useState(DEFAULT_LIVE_OUTPUT_LINES);
  const [expandedLiveScreen, setExpandedLiveScreen] = useState<ConversationTimeline['liveScreen']>();
  const [loadingOlderLiveOutput, setLoadingOlderLiveOutput] = useState(false);
  const [hasOlderLiveOutput, setHasOlderLiveOutput] = useState(true);
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);
  const [liveOutputPrependVersion, setLiveOutputPrependVersion] = useState(0);
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

  useEffect(() => {
    setLiveOutputLines(DEFAULT_LIVE_OUTPUT_LINES);
    setExpandedLiveScreen(undefined);
    setLoadingOlderLiveOutput(false);
    setHasOlderLiveOutput(true);
  }, [conversationKey]);

  const effectiveLiveScreen = liveMode && liveOutputLines > DEFAULT_LIVE_OUTPUT_LINES
    ? (expandedLiveScreen ?? liveScreen)
    : liveScreen;

  useEffect(() => {
    if (!boundSession || !liveMode || liveOutputLines <= DEFAULT_LIVE_OUTPUT_LINES) {
      return;
    }

    let cancelled = false;
    const timeoutId = globalThis.setTimeout(() => {
      void api.sessionScreen(boundSession.id, { lines: liveOutputLines })
        .then((response) => {
          if (cancelled) {
            return;
          }
          setExpandedLiveScreen(response.screen ?? undefined);
        })
        .catch(() => undefined);
    }, 250);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [boundSession?.id, liveMode, liveOutputLines, liveScreen?.capturedAt]);

  useEffect(() => {
    if (!liveMode || liveOutputLines <= DEFAULT_LIVE_OUTPUT_LINES) {
      return;
    }

    setHasOlderLiveOutput(true);
  }, [liveMode, liveOutputLines, liveScreen?.capturedAt]);

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

  const loadOlderLiveOutput = useCallback(async (): Promise<void> => {
    if (!boundSession || !liveMode || loadingOlderLiveOutput || !hasOlderLiveOutput) {
      return;
    }

    const nextLines = Math.min(MAX_LIVE_OUTPUT_LINES, liveOutputLines + LIVE_OUTPUT_LINE_INCREMENT);
    if (nextLines <= liveOutputLines) {
      setHasOlderLiveOutput(false);
      return;
    }

    setLoadingOlderLiveOutput(true);
    try {
      const previousRenderedText = renderScreenText(effectiveLiveScreen);
      const response = await api.sessionScreen(boundSession.id, { lines: nextLines });
      const nextScreen = response.screen;
      const nextRenderedText = renderScreenText(nextScreen ?? undefined);

      setExpandedLiveScreen(nextScreen ?? undefined);
      setLiveOutputLines(nextLines);
      setHasOlderLiveOutput(nextLines < MAX_LIVE_OUTPUT_LINES && nextRenderedText !== previousRenderedText);
      setLiveOutputPrependVersion((current) => current + 1);
    } finally {
      setLoadingOlderLiveOutput(false);
    }
  }, [boundSession, effectiveLiveScreen, hasOlderLiveOutput, liveMode, liveOutputLines, loadingOlderLiveOutput]);

  const tailKey = useMemo(() => {
    if (boundSession && effectiveLiveScreen) {
      return `live:${boundSession.id}:${effectiveLiveScreen.capturedAt}`;
    }

    const messageCount = timeline?.messages.length ?? 0;
    const lastMessage = timeline?.messages.at(-1);
    return lastMessage ? `history:${lastMessage.id}:${messageCount}` : undefined;
  }, [boundSession, effectiveLiveScreen, timeline?.messages]);

  const hasResolvedHistory = Boolean(timelineHistoryQuery.data) || (Boolean(conversationKey) && retainedHistoryState.key === conversationKey);

  return {
    timeline,
    liveMode,
    effectiveLiveScreen,
    loading: timelineQuery.isLoading || (timelineHistoryQuery.isLoading && !hasResolvedHistory),
    rawOutput: rawOutputQuery.data?.text,
    rawLoading: rawOutputQuery.isLoading,
    hasOlderMessages: Boolean(timelineHistoryQuery.hasNextPage),
    loadingOlderMessages: timelineHistoryQuery.isFetchingNextPage,
    loadOlderMessages,
    hasOlderLiveOutput: liveMode && hasOlderLiveOutput,
    loadingOlderLiveOutput,
    loadOlderLiveOutput,
    conversationKey,
    historyPrependVersion,
    liveOutputPrependVersion,
    tailKey,
  };
}
