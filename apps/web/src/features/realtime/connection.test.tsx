import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@agent-console/shared';
import { useRealtimeConnection } from './connection';

const originalEventSource = globalThis.EventSource;

class CapturingEventSource extends EventTarget {
  static instances: CapturingEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = CapturingEventSource.CONNECTING;
  readonly OPEN = CapturingEventSource.OPEN;
  readonly CLOSED = CapturingEventSource.CLOSED;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = CapturingEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL, eventSourceInitDict: EventSourceInit = {}) {
    super();
    this.url = String(url);
    this.withCredentials = eventSourceInitDict.withCredentials === true;
    CapturingEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = CapturingEventSource.CLOSED;
  }
}

function Harness(props: {
  authenticated: boolean;
  onEvent: (event: SessionEvent) => void;
  onParseError?: (message: string) => void;
  onConnectionError?: (message: string) => void;
}) {
  useRealtimeConnection({
    authenticated: props.authenticated,
    onEvent: props.onEvent,
    onParseError: props.onParseError ?? vi.fn(),
    onConnectionError: props.onConnectionError ?? vi.fn(),
  });
  return null;
}

describe('useRealtimeConnection', () => {
  beforeEach(() => {
    CapturingEventSource.instances = [];
    globalThis.EventSource = CapturingEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it('keeps one EventSource alive across handler changes', () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const { rerender, unmount } = render(<Harness authenticated onEvent={firstHandler} />);

    expect(CapturingEventSource.instances).toHaveLength(1);
    expect(CapturingEventSource.instances[0]?.withCredentials).toBe(true);

    rerender(<Harness authenticated onEvent={secondHandler} />);
    expect(CapturingEventSource.instances).toHaveLength(1);

    CapturingEventSource.instances[0]?.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'heartbeat', timestamp: '2026-03-07T00:00:00.000Z' }),
    }));
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith({ type: 'heartbeat', timestamp: '2026-03-07T00:00:00.000Z' });

    unmount();
    expect(CapturingEventSource.instances[0]?.readyState).toBe(CapturingEventSource.CLOSED);
  });

  it('reports parse and connection failures without recreating the stream', () => {
    const onParseError = vi.fn();
    const onConnectionError = vi.fn();
    render(
      <Harness
        authenticated
        onEvent={vi.fn()}
        onParseError={onParseError}
        onConnectionError={onConnectionError}
      />,
    );

    CapturingEventSource.instances[0]?.onmessage?.(new MessageEvent('message', { data: '{bad json' }));
    CapturingEventSource.instances[0]?.onerror?.(new Event('error'));

    expect(CapturingEventSource.instances).toHaveLength(1);
    expect(onParseError).toHaveBeenCalledWith('Lost event stream parsing. Refresh to recover.');
    expect(onConnectionError).toHaveBeenCalledWith('Realtime connection dropped. The page is still usable and polling the project tree and selected conversation.');
  });
});
