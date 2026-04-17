import { useEffect, useLayoutEffect, useRef } from 'react';

const BOTTOM_STICKINESS_THRESHOLD = 48;
const TOP_LOAD_THRESHOLD = 160;
const UNDERFILL_THRESHOLD = 64;

type ConversationSurface = 'live' | 'history' | 'empty';

interface UseConversationScrollControllerArgs {
  conversationKey?: string;
  activeSurface: ConversationSurface;
  tailKey?: string;
  layoutKey: string;
  historyPrependVersion: number;
  liveOutputPrependVersion: number;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  onLoadOlderHistory: () => Promise<void>;
  hasOlderLiveOutput: boolean;
  loadingOlderLiveOutput: boolean;
  onLoadOlderLiveOutput: () => Promise<void>;
  loading: boolean;
}

function updateStickiness(scroller: HTMLDivElement, stickToBottomRef: { current: boolean }): void {
  const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  stickToBottomRef.current = distanceFromBottom <= BOTTOM_STICKINESS_THRESHOLD;
}

export function useConversationScrollController({
  conversationKey,
  activeSurface,
  tailKey,
  layoutKey,
  historyPrependVersion,
  liveOutputPrependVersion,
  hasOlderHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  hasOlderLiveOutput,
  loadingOlderLiveOutput,
  onLoadOlderLiveOutput,
  loading,
}: UseConversationScrollControllerArgs) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const historyLoadInFlightRef = useRef(false);
  const liveOutputLoadInFlightRef = useRef(false);
  const previousConversationKeyRef = useRef<string | undefined>(undefined);
  const previousHistoryPrependVersionRef = useRef(historyPrependVersion);
  const previousLiveOutputPrependVersionRef = useRef(liveOutputPrependVersion);
  const previousTailKeyRef = useRef<string | undefined>(tailKey);
  const previousLayoutKeyRef = useRef(layoutKey);

  function requestOlderHistory(): void {
    if (!hasOlderHistory || loadingOlderHistory || historyLoadInFlightRef.current) {
      return;
    }

    prependScrollHeightRef.current = scrollRef.current?.scrollHeight ?? null;
    historyLoadInFlightRef.current = true;
    void onLoadOlderHistory()
      .catch(() => {
        prependScrollHeightRef.current = null;
      })
      .finally(() => {
        historyLoadInFlightRef.current = false;
      });
  }

  function requestOlderLiveOutput(): void {
    if (!hasOlderLiveOutput || loadingOlderLiveOutput || liveOutputLoadInFlightRef.current) {
      return;
    }

    prependScrollHeightRef.current = scrollRef.current?.scrollHeight ?? null;
    liveOutputLoadInFlightRef.current = true;
    void onLoadOlderLiveOutput()
      .catch(() => {
        prependScrollHeightRef.current = null;
      })
      .finally(() => {
        liveOutputLoadInFlightRef.current = false;
      });
  }

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    const updateScrollState = () => {
      updateStickiness(scroller, stickToBottomRef);

      if (loading || scroller.scrollTop > TOP_LOAD_THRESHOLD) {
        return;
      }

      if (activeSurface === 'live') {
        requestOlderLiveOutput();
      } else if (activeSurface === 'history') {
        requestOlderHistory();
      }
    };

    updateScrollState();
    scroller.addEventListener('scroll', updateScrollState);
    return () => scroller.removeEventListener('scroll', updateScrollState);
  }, [
    activeSurface,
    hasOlderHistory,
    hasOlderLiveOutput,
    loading,
    loadingOlderHistory,
    loadingOlderLiveOutput,
    onLoadOlderHistory,
    onLoadOlderLiveOutput,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || loading) {
      return;
    }

    if (scroller.scrollHeight > scroller.clientHeight + UNDERFILL_THRESHOLD) {
      return;
    }

    if (activeSurface === 'live') {
      requestOlderLiveOutput();
    } else if (activeSurface === 'history') {
      requestOlderHistory();
    }
  }, [
    activeSurface,
    hasOlderHistory,
    hasOlderLiveOutput,
    historyPrependVersion,
    liveOutputPrependVersion,
    loading,
    loadingOlderHistory,
    loadingOlderLiveOutput,
    onLoadOlderHistory,
    onLoadOlderLiveOutput,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      const wasSticky = stickToBottomRef.current;
      updateStickiness(scroller, stickToBottomRef);
      if (wasSticky || stickToBottomRef.current) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
        stickToBottomRef.current = true;
      }
    });

    observer.observe(scroller);
    return () => observer.disconnect();
  }, [conversationKey]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    const scroller = scrollRef.current;
    if (!scroller) {
      previousConversationKeyRef.current = conversationKey;
      return;
    }

    if (conversationKey === previousConversationKeyRef.current) {
      return;
    }

    prependScrollHeightRef.current = null;
    stickToBottomRef.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    previousConversationKeyRef.current = conversationKey;
  }, [conversationKey, loading]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    const historyChanged = historyPrependVersion !== previousHistoryPrependVersionRef.current;
    const liveChanged = liveOutputPrependVersion !== previousLiveOutputPrependVersionRef.current;
    if (!historyChanged && !liveChanged) {
      return;
    }

    previousHistoryPrependVersionRef.current = historyPrependVersion;
    previousLiveOutputPrependVersionRef.current = liveOutputPrependVersion;

    const scroller = scrollRef.current;
    if (!scroller) {
      prependScrollHeightRef.current = null;
      return;
    }

    const previousScrollHeight = prependScrollHeightRef.current;
    if (previousScrollHeight !== null) {
      scroller.scrollTop += scroller.scrollHeight - previousScrollHeight;
      prependScrollHeightRef.current = null;
    }
  }, [historyPrependVersion, liveOutputPrependVersion, loading]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (tailKey === previousTailKeyRef.current) {
      return;
    }

    previousTailKeyRef.current = tailKey;

    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    if (stickToBottomRef.current && prependScrollHeightRef.current === null) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  }, [loading, tailKey]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (layoutKey === previousLayoutKeyRef.current) {
      return;
    }

    previousLayoutKeyRef.current = layoutKey;

    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    if (stickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  }, [layoutKey, loading]);

  return { scrollRef };
}
