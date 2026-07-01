import { EventEmitter } from 'node:events';
import type { SessionEvent } from '@agent-console/shared';

const DEFAULT_MAX_LISTENERS = 50;
const DEFAULT_WARN_AT_LISTENERS = 40;

interface RealtimeEventBusOptions {
  maxListeners?: number;
  warnAtListeners?: number;
  onHighListenerCount?: (count: number) => void;
}

export class RealtimeEventBus {
  private readonly emitter = new EventEmitter();
  private readonly warnAtListeners: number;
  private readonly onHighListenerCount: (count: number) => void;
  private lastWarnedListenerCount = 0;

  constructor(options: RealtimeEventBusOptions = {}) {
    const maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    this.warnAtListeners = options.warnAtListeners ?? DEFAULT_WARN_AT_LISTENERS;
    this.onHighListenerCount = options.onHighListenerCount ?? ((count) => {
      process.emitWarning(`Realtime event bus has ${count} listeners.`, {
        type: 'RealtimeEventBusListenerWarning',
      });
    });
    this.emitter.setMaxListeners(maxListeners);
  }

  emit(event: SessionEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.emitter.on('event', listener);
    const listenerCount = this.emitter.listenerCount('event');
    if (listenerCount >= this.warnAtListeners && listenerCount > this.lastWarnedListenerCount) {
      this.lastWarnedListenerCount = listenerCount;
      this.onHighListenerCount(listenerCount);
    }
    return () => this.emitter.off('event', listener);
  }
}
