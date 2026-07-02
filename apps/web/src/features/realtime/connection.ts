import { useEffect, useRef } from 'react';
import type { SessionEvent } from '@agent-console/shared';
import type { RealtimeEventHandler } from './apply-session-event';

export interface UseRealtimeConnectionOptions {
  authenticated: boolean | undefined;
  onEvent: RealtimeEventHandler;
  onParseError: (message: string) => void;
  onConnectionError: (message: string) => void;
}

export function useRealtimeConnection(options: UseRealtimeConnectionOptions): void {
  const onEventRef = useRef(options.onEvent);
  const onParseErrorRef = useRef(options.onParseError);
  const onConnectionErrorRef = useRef(options.onConnectionError);

  useEffect(() => {
    onEventRef.current = options.onEvent;
    onParseErrorRef.current = options.onParseError;
    onConnectionErrorRef.current = options.onConnectionError;
  }, [options.onConnectionError, options.onEvent, options.onParseError]);

  useEffect(() => {
    if (!options.authenticated) return;

    const source = new EventSource('/api/events', { withCredentials: true });
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as SessionEvent;
        onEventRef.current(parsed);
      } catch {
        onParseErrorRef.current('Lost event stream parsing. Refresh to recover.');
      }
    };
    source.onerror = () => {
      onConnectionErrorRef.current('Realtime connection dropped. The page is still usable and polling the project tree and selected conversation.');
    };

    return () => source.close();
  }, [options.authenticated]);
}
