import type { SessionEvent } from '@agent-console/shared';
import { describe, expect, it } from 'vitest';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';

describe('RealtimeEventBus', () => {
  it('warns when listener count reaches the configured high-water mark', () => {
    const warnings: number[] = [];
    const bus = new RealtimeEventBus({
      maxListeners: 3,
      warnAtListeners: 2,
      onHighListenerCount: (count) => warnings.push(count),
    });
    const received: SessionEvent[] = [];
    const event: SessionEvent = {
      type: 'conversation.index-updated',
      timestamp: '2026-07-01T00:00:00.000Z',
    };

    const unsubscribeFirst = bus.subscribe((next) => received.push(next));
    const unsubscribeSecond = bus.subscribe(() => undefined);
    expect(warnings).toEqual([2]);

    const unsubscribeThird = bus.subscribe(() => undefined);
    expect(warnings).toEqual([2, 3]);

    bus.emit(event);
    expect(received).toEqual([event]);

    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeThird();
  });
});
