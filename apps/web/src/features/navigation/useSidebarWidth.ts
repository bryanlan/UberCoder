import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const STORAGE_KEY = 'agent-console:sidebar-width';
const DEFAULT_WIDTH = 352;
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const MIN_CONTENT_WIDTH = 480;

export function useSidebarWidth(open: boolean) {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
  });
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - MIN_CONTENT_WIDTH));
  const width = Math.min(preferredWidth, maxWidth);

  useEffect(() => {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(preferredWidth));
  }, [preferredWidth]);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    if (!open) {
      drag.current = null;
      setResizing(false);
    }
  }, [open]);

  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizing]);

  function resize(nextWidth: number): void {
    setPreferredWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, nextWidth)));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setResizing(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    resize(drag.current.startWidth + event.clientX - drag.current.startX);
  }

  function stopResizing(): void {
    drag.current = null;
    setResizing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 64 : 16;
    switch (event.key) {
      case 'ArrowLeft': resize(width - step); break;
      case 'ArrowRight': resize(width + step); break;
      case 'Home': resize(MIN_WIDTH); break;
      case 'End': resize(maxWidth); break;
      default: return;
    }
    event.preventDefault();
  }

  return {
    width,
    resizing,
    separatorProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-label': 'Resize sidebar width',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': maxWidth,
      'aria-valuenow': width,
      onPointerDown,
      onPointerMove,
      onPointerUp: stopResizing,
      onPointerCancel: stopResizing,
      onLostPointerCapture: stopResizing,
      onKeyDown,
      onDoubleClick: () => resize(DEFAULT_WIDTH),
    },
  };
}
