import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const BOTTOM_STICKINESS_THRESHOLD = 48;
const TOP_LOAD_THRESHOLD = 160;
const UNDERFILL_THRESHOLD = 64;
const SELECTION_RELEASE_GRACE_MS = 500;

type ConversationSurface = 'live' | 'history' | 'empty';

interface UseConversationScrollControllerArgs {
  conversationKey?: string;
  activeSurface: ConversationSurface;
  tailKey?: string;
  layoutKey: string;
  historyPrependVersion: number;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  onLoadOlderHistory: () => Promise<void>;
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
  hasOlderHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  loading,
}: UseConversationScrollControllerArgs) {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollElementRef.current = node;
    setScrollNode((current) => (current === node ? current : node));
  }, []);
  const stickToBottomRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const historyLoadInFlightRef = useRef(false);
  const previousConversationKeyRef = useRef<string | undefined>(undefined);
  const previousHistoryPrependVersionRef = useRef(historyPrependVersion);
  const previousTailKeyRef = useRef<string | undefined>(tailKey);
  const previousLayoutKeyRef = useRef(layoutKey);
  const pointerDownInsideScrollerRef = useRef(false);
  const selectionHoldUntilRef = useRef(0);
  const selectionReleaseTimerRef = useRef<number | undefined>(undefined);
  const selectingInsideScrollerRef = useRef(false);
  const [selectionActive, setSelectionActive] = useState(false);

  function setSelectingInsideScroller(nextSelectionActive: boolean, options: { sync?: boolean } = {}): void {
    if (selectingInsideScrollerRef.current === nextSelectionActive) {
      return;
    }
    selectingInsideScrollerRef.current = nextSelectionActive;
    if (options.sync) {
      try {
        flushSync(() => setSelectionActive(nextSelectionActive));
      } catch {
        setSelectionActive(nextSelectionActive);
      }
      return;
    }
    setSelectionActive(nextSelectionActive);
  }

  function isSelectingInScroller(scroller: HTMLDivElement): boolean {
    return selectingInsideScrollerRef.current || selectionTouchesScroller(scroller);
  }

  function requestOlderHistory(): void {
    if (!hasOlderHistory || loadingOlderHistory || historyLoadInFlightRef.current) {
      return;
    }

    prependScrollHeightRef.current = scrollElementRef.current?.scrollHeight ?? null;
    historyLoadInFlightRef.current = true;
    void onLoadOlderHistory()
      .catch(() => {
        prependScrollHeightRef.current = null;
      })
      .finally(() => {
        historyLoadInFlightRef.current = false;
      });
  }

  useEffect(() => {
    pointerDownInsideScrollerRef.current = false;
    selectionHoldUntilRef.current = 0;
    if (selectionReleaseTimerRef.current !== undefined) {
      window.clearTimeout(selectionReleaseTimerRef.current);
      selectionReleaseTimerRef.current = undefined;
    }
    setSelectingInsideScroller(false);
  }, [conversationKey]);

  useEffect(() => {
    const scroller = scrollNode;
    if (!scroller) {
      return;
    }

    const syncSelectionState = () => {
      setSelectingInsideScroller(
        pointerDownInsideScrollerRef.current
        || Date.now() < selectionHoldUntilRef.current
        || selectionTouchesScroller(scroller),
      );
    };

    const beginPotentialSelection = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node) || !scroller.contains(event.target)) {
        return;
      }

      pointerDownInsideScrollerRef.current = true;
      selectionHoldUntilRef.current = 0;
      if (selectionReleaseTimerRef.current !== undefined) {
        window.clearTimeout(selectionReleaseTimerRef.current);
        selectionReleaseTimerRef.current = undefined;
      }
      if (event.shiftKey) {
        document.getSelection()?.removeAllRanges();
      }
      setSelectingInsideScroller(true, { sync: true });
    };

    const endPotentialSelection = () => {
      const shouldHoldSelection = pointerDownInsideScrollerRef.current || selectionTouchesScroller(scroller);
      pointerDownInsideScrollerRef.current = false;
      if (selectionReleaseTimerRef.current !== undefined) {
        window.clearTimeout(selectionReleaseTimerRef.current);
        selectionReleaseTimerRef.current = undefined;
      }
      if (!shouldHoldSelection) {
        selectionHoldUntilRef.current = 0;
        syncSelectionState();
        return;
      }

      selectionHoldUntilRef.current = Date.now() + SELECTION_RELEASE_GRACE_MS;
      selectionReleaseTimerRef.current = window.setTimeout(() => {
        selectionHoldUntilRef.current = 0;
        selectionReleaseTimerRef.current = undefined;
        syncSelectionState();
      }, SELECTION_RELEASE_GRACE_MS);
      syncSelectionState();
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
      if (selectionReleaseTimerRef.current !== undefined) {
        window.clearTimeout(selectionReleaseTimerRef.current);
        selectionReleaseTimerRef.current = undefined;
      }
    };
  }, [conversationKey, scrollNode]);

  useEffect(() => {
    const scroller = scrollNode;
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

      if (activeSurface === 'history' && hasOlderHistory) {
        requestOlderHistory();
      }
    };

    updateScrollState();
    scroller.addEventListener('scroll', updateScrollState);
    return () => scroller.removeEventListener('scroll', updateScrollState);
  }, [
    activeSurface,
    hasOlderHistory,
    scrollNode,
    loading,
    loadingOlderHistory,
    onLoadOlderHistory,
  ]);

  useEffect(() => {
    const scroller = scrollNode;
    if (!scroller || loading || isSelectingInScroller(scroller)) {
      return;
    }

    if (scroller.scrollHeight > scroller.clientHeight + UNDERFILL_THRESHOLD) {
      return;
    }

    if (activeSurface === 'history' && hasOlderHistory) {
      requestOlderHistory();
    }
  }, [
    activeSurface,
    hasOlderHistory,
    historyPrependVersion,
    scrollNode,
    loading,
    loadingOlderHistory,
    onLoadOlderHistory,
  ]);

  useEffect(() => {
    const scroller = scrollNode;
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
  }, [conversationKey, scrollNode]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    const scroller = scrollNode;
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
  }, [conversationKey, loading, scrollNode]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (historyPrependVersion === previousHistoryPrependVersionRef.current) {
      return;
    }

    previousHistoryPrependVersionRef.current = historyPrependVersion;

    const scroller = scrollNode;
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
  }, [historyPrependVersion, loading, scrollNode]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (tailKey === previousTailKeyRef.current) {
      return;
    }

    previousTailKeyRef.current = tailKey;

    const scroller = scrollNode;
    if (!scroller) {
      return;
    }
    if (isSelectingInScroller(scroller)) {
      return;
    }

    if (stickToBottomRef.current && prependScrollHeightRef.current === null) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  }, [loading, scrollNode, tailKey]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (layoutKey === previousLayoutKeyRef.current) {
      return;
    }

    previousLayoutKeyRef.current = layoutKey;

    const scroller = scrollNode;
    if (!scroller) {
      return;
    }
    if (isSelectingInScroller(scroller)) {
      return;
    }

    if (stickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  }, [layoutKey, loading, scrollNode]);

  return { scrollRef, selectionActive };
}
