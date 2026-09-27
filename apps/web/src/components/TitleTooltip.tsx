import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// One third of Chromium's default 500 ms native tooltip delay.
const SHOW_DELAY_MS = Math.round(500 / 3);
const HIDE_DELAY_MS = 100;
const VIEWPORT_MARGIN = 12;
const TOOLTIP_GAP = 8;
const TOOLTIP_WIDTH = 560;

interface TooltipPosition {
  left: number;
  top: number;
  width: number;
}

export function TitleTooltip({ text, className, children }: {
  text: string;
  className: string;
  children?: ReactNode;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<TooltipPosition>();

  const dismiss = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    setPosition(undefined);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!position || !anchorRef.current || !tooltipRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const height = tooltipRef.current.getBoundingClientRect().height;
    const below = anchor.bottom + TOOLTIP_GAP;
    const top = below + height <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, anchor.top - height - TOOLTIP_GAP);
    if (top !== position.top) setPosition({ ...position, top });
  }, [position, text]);

  useEffect(() => {
    if (!position) return;
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && tooltipRef.current?.contains(event.target)) return;
      dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [position, dismiss]);

  function scheduleShow(): void {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
    if (position) return;
    showTimer.current = window.setTimeout(() => {
      if (!anchorRef.current) return;
      const anchor = anchorRef.current.getBoundingClientRect();
      const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - width - VIEWPORT_MARGIN)),
        top: anchor.bottom + TOOLTIP_GAP,
        width,
      });
    }, SHOW_DELAY_MS);
  }

  function scheduleHide(): void {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(dismiss, HIDE_DELAY_MS);
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={className}
        aria-describedby={position ? id : undefined}
        onPointerEnter={(event) => { if (event.pointerType !== 'touch') scheduleShow(); }}
        onPointerLeave={scheduleHide}
        onPointerDown={dismiss}
      >
        {children ?? text}
      </span>
      {position && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className="fixed z-50 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-600 bg-slate-900 px-4 py-3 text-sm leading-6 text-slate-100 shadow-panel"
          style={{ ...position, maxHeight: window.innerHeight - VIEWPORT_MARGIN * 2 }}
          onPointerEnter={() => window.clearTimeout(hideTimer.current)}
          onPointerLeave={scheduleHide}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
