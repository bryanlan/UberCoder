import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const KEY = 'agent-console:worker-panel-width';
const DEFAULT = 960;
const MIN = 320;
const MAX = 1600;

export function useWorkerPanelWidth() {
  const panelRef = useRef<HTMLElement>(null);
  const [preferred, setPreferred] = useState(() => {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN && n <= MAX ? n : DEFAULT;
  });
  const [limit, setLimit] = useState(MAX);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const width = Math.min(preferred, limit);

  useEffect(() => { localStorage.setItem(KEY, String(preferred)); }, [preferred]);
  useLayoutEffect(() => {
    const navigation = panelRef.current?.parentElement?.querySelector<HTMLElement>(':scope > aside:not([aria-label="Active workers"])');
    const update = () => setLimit(Math.max(MIN, Math.min(MAX,
      window.innerWidth - (navigation?.getBoundingClientRect().width ?? 0) - 320)));
    update();
    const observer = new ResizeObserver(update);
    if (navigation) observer.observe(navigation);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, [resizing]);

  const resize = (next: number) => setPreferred(Math.max(MIN, Math.min(limit, next)));
  const stop = () => { drag.current = null; setResizing(false); };
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, width }; setResizing(true);
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === e.pointerId) resize(drag.current.width + drag.current.x - e.clientX);
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16;
    switch (e.key) {
      case 'ArrowLeft': resize(width + step); break;
      case 'ArrowRight': resize(width - step); break;
      case 'Home': resize(MIN); break;
      case 'End': resize(limit); break;
      default: return;
    }
    e.preventDefault();
  }
  return { panelRef, width, resizing, separatorProps: {
    role: 'separator', tabIndex: 0, 'aria-label': 'Resize worker panel width', 'aria-orientation': 'vertical' as const,
    'aria-valuemin': MIN, 'aria-valuemax': limit, 'aria-valuenow': width,
    onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop,
    onKeyDown, onDoubleClick: () => setPreferred(DEFAULT),
  } };
}
