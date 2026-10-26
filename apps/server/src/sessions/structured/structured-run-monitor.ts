import type { ProviderChildActivity, ProviderRunMonitor, ProviderRunState } from '../../providers/types.js';
import type { ProviderFailure } from '../../providers/transport/types.js';

/**
 * Run state for a structured session. The transport's own turn events are authoritative for the turns the
 * host observed; the provider's transcript monitor (when one exists) still supplies history and native
 * child activity. RunRecovery watches this object under a stable key, so the transcript path can arrive
 * later without re-attaching.
 */
export class StructuredRunMonitor implements ProviderRunMonitor {
  private protocol?: ProviderRunState;
  private transcript?: { monitor: ProviderRunMonitor; path: string };

  /** Attach the provider's transcript monitor once the transcript path is known. True when a monitor was newly attached. */
  attachTranscript(path: string | undefined, create: (() => ProviderRunMonitor) | undefined): boolean {
    if (!path || !create || this.transcript?.path === path) return false;
    this.transcript = { monitor: create(), path };
    return true;
  }

  /** The connection is gone: turns it carried are lost, so their state must not look current. */
  reset(): void {
    this.protocol = undefined;
  }

  turnStarted(turnId: string, at: string): void {
    this.protocol = { turnId, timestamp: at, startedAt: at, status: 'running' };
  }

  itemCompleted(at: string): void {
    if (this.protocol?.status === 'running') this.protocol = { ...this.protocol, progressAt: at };
  }

  turnTerminal(turnId: string, status: 'completed' | 'interrupted' | 'failed', failure: ProviderFailure | undefined, at: string): void {
    const sameTurn = this.protocol?.turnId === turnId ? this.protocol : undefined;
    const mapped: ProviderRunState['status'] = status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed';
    this.protocol = {
      turnId,
      timestamp: at,
      startedAt: sameTurn?.startedAt ?? at,
      progressAt: sameTurn?.progressAt,
      status: mapped,
      error: mapped === 'failed'
        ? { code: failure?.code ?? failure?.class ?? 'unknown', message: failure?.message ?? 'The provider stopped.' }
        : undefined,
    };
  }

  async read(): Promise<ProviderRunState | undefined> {
    const history = this.transcript ? await this.transcript.monitor.read(this.transcript.path).catch(() => undefined) : undefined;
    const live = this.protocol;
    if (!live) return history;
    if (!history || history.turnId === live.turnId) return live;
    return Date.parse(history.timestamp) > Date.parse(live.timestamp) ? history : live;
  }

  takeChildActivity(): ProviderChildActivity[] {
    return this.transcript?.monitor.takeChildActivity?.() ?? [];
  }
}
