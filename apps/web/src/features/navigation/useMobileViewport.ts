import { useLayoutEffect, useState } from 'react';

function readViewport() {
  return {
    height: window.visualViewport?.height ?? window.innerHeight,
    top: window.visualViewport?.offsetTop ?? 0,
  };
}

// Mobile keyboards can shrink/pan the visual viewport without resizing the page.
export function useMobileViewport(enabled: boolean) {
  const [viewport, setViewport] = useState(readViewport);
  useLayoutEffect(() => {
    if (!enabled) return;
    const update = () => setViewport(readViewport());
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return viewport;
}
