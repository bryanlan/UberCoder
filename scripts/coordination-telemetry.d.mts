export const TELEMETRY_MAX_BYTES: number;
export const TELEMETRY_FAILURE_MAX_BYTES: number;
export const TELEMETRY_RETENTION_DAYS: number;
export interface CoordinationTelemetryRecord {
  kind: 'rpc_client' | 'rpc_server' | 'http' | 'event_loop' | 'index' | 'hook' | 'offer';
  action?: string; outcome?: string; error?: string; durationMs?: number; event?: string;
  messageId?: string; offeredAt?: number; maxMs?: number; p99Ms?: number; samples?: number;
  operation?: string; project?: string; provider?: string; ref?: string; rows?: number;
}
export function recordCoordinationTelemetry(runtimeDir: string, input: CoordinationTelemetryRecord): boolean;
