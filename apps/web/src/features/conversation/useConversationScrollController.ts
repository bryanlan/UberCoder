import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

function selectionTouchesScroller(scroller: HTMLDivElement): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(
    (anchorNode && scroller.contains(anchorNode))
    || (focusNode && scroller.contains(focusNode)),
  );
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
  const pointerDownInsideScrollerRef = useRef(false);
  const selectingInsideScrollerRef = useRef(false);
  const [selectionActive, setSelectionActive] = useState(false);

  function setSelectingInsideScroller(nextSelectionActive: boolean): void {
    if (selectingInsideScrollerRef.current === nextSelectionActive) {
      return;
    }
    selectingInsideScrollerRef.current = nextSelectionActive;
    setSelectionActive(nextSelectionActive);
  }

  function isSelectingInScroller(scroller: HTMLDivElement): boolean {
    return selectingInsideScrollerRef.current || selectionTouchesScroller(scroller);
  }

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
    pointerDownInsideScrollerRef.current = false;
    setSelectingInsideScroller(false);
  }, [conversationKey]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    const syncSelectionState = () => {
      setSelectingInsideScroller(pointerDownInsideScrollerRef.current || selectionTouchesScroller(scroller));
    };

    const beginPotentialSelection = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node) || !scroller.contains(event.target)) {
        return;
      }

      pointerDownInsideScrollerRef.current = true;
      setSelectingInsideScroller(true);
    };

    const endPotentialSelection = () => {
      pointerDownInsideScrollerRef.current = false;
      window.setTimeout(() => {
        syncSelectionState();
      }, 0);
    };

    scroller.addEventListener('pointerdown', beginPotentialSelection);
    window.addEventListener('pointerup', endPotentialSelection);
    window.addEventListener('pointercancel', endPotentialSelection);
    document.addEventListener('selectionchange', syncSelectionState);

    return () => {
      scroller.removeEventListener('pointerdown', beginPotentialSelection);
      window.removeEventListener('pointerup', endPotentialSelection);
      window.removeEventListener('pointercancel', endPotentialSelection);
      document.removeEventListener('selectionchange', syncSelectionState);
    };
  }, [conversationKey]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    const updateScrollState = () => {
      updateStickiness(scroller, stickToBottomRef);

      if (isSelectingInScroller(scroller)) {
        return;
      }

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
    if (!scroller || loading || isSelectingInScroller(scroller)) {
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
      if (isSelectingInScroller(scroller)) {
        return;
      }

      const wasSticky = stickToBottomRef.current;
      if (wasSticky) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
        stickToBottomRef.current = true;
        return;
      }

      updateStickiness(scroller, stickToBottomRef);
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
    if (isSelectingInScroller(scroller)) {
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
    if (isSelectingInScroller(scroller)) {
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
    if (isSelectingInScroller(scroller)) {
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
    if (isSelectingInScroller(scroller)) {
      return;
    }

    if (stickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  }, [layoutKey, loading]);

  return { scrollRef, selectionActive };
}
