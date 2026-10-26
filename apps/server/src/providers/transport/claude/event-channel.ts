import type { TransportEvent } from '../types.js';

/**
 * Single-consumer async queue for a session's events. Buffers until read; ends after the first `stopped` state.
 * (The Codex session keeps an identical private class; the two can share one module once both lanes are merged.)
 */
export class EventChannel {
  private readonly queue: TransportEvent[] = [];
  private waiter: ((result: IteratorResult<TransportEvent>) => void) | undefined;
  private ended = false;
  private abandoned = false;
  private claimed = false;

  push(event: TransportEvent): void {
    if (this.ended || this.abandoned) return;
    if (event.type === 'session.state' && event.state === 'stopped') this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  iterable(): AsyncIterable<TransportEvent> {
    return { [Symbol.asyncIterator]: () => this.claim() };
  }

  private claim(): AsyncIterator<TransportEvent> {
    if (this.claimed) throw new Error('TransportSession.events has a single consumer.');
    this.claimed = true;
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.ended || this.abandoned) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<TransportEvent>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.abandoned = true;
        this.queue.length = 0;
        const resolve = this.waiter;
        this.waiter = undefined;
        resolve?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
