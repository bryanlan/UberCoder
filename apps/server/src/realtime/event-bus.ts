import { EventEmitter } from 'node:events';
import type { SessionEvent } from '@agent-console/shared';

export class RealtimeEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: SessionEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
