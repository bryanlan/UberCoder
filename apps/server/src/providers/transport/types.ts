import type { ProviderId } from '@agent-console/shared';

// Plugin contract for structured (protocol-driven) provider sessions. See docs/structured-providers.md.
// Three levels: plugin (static) -> instance (one binary and home; a shared process when
// processModel is 'shared') -> session (one native conversation).

export interface TransportCapabilities {
  processModel: 'shared' | 'per-session';
  nativeIds: 'server-allocated' | 'client-allocated';
  resume: 'reattach' | 'replay' | 'none';
  steer: 'native' | 'native-cancels-tools' | 'none';
  interrupt: 'terminal-follows' | 'ends-process';
  images: boolean;
  enforcement: 'native' | 'host';
  modelSwitch: 'next-turn' | 'restart' | 'none';
}

export interface ProviderFailure {
  class: 'usage_limit' | 'provider_error' | 'transport_error' | 'permission_error' | 'validation_error' | 'unknown';
  code?: string; // provider code, e.g. codex 'serverOverloaded'
  message: string; // redacted by the plugin before emit
  retryable?: boolean;
  resetAt?: string;
}

export type TransportEvent =
  | { type: 'session.state'; state: 'starting' | 'ready' | 'running' | 'stopped' | 'error'; failure?: ProviderFailure }
  | { type: 'session.native'; nativeSessionId: string; transcriptPath?: string; title?: string }
  | { type: 'turn.started'; turnId: string; origin: 'user' | 'provider'; replay: boolean }
  | { type: 'item.completed'; turnId: string; itemId: string; kind: 'assistant' | 'reasoning' | 'command' | 'file_change' | 'mcp' | 'search' | 'other'; replay: boolean; title?: string }
  | { type: 'request.opened'; requestId: string; kind: 'command' | 'file_change' | 'permission' | 'mcp' | 'question'; summary: string }
  | { type: 'request.closed'; requestId: string; outcome: 'resolved' | 'declined' | 'cancelled' }
  | { type: 'usage.updated'; contextUsedTokens?: number; contextMaxTokens?: number; windows?: Array<{ id: string; usedPercent: number; resetsAt?: string }> }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'turn.terminal'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; failure?: ProviderFailure; sessionUsable: boolean; replay: boolean };

export interface TurnInput {
  text: string;
  images?: Array<{ path: string; mimeType: string }>;
  model?: string;
  effort?: string;
  clientMessageId?: string;
}

export interface TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities: TransportCapabilities;
  readonly events: AsyncIterable<TransportEvent>; // single consumer; ends after session.state 'stopped'
  readonly transcriptPath?: string; // when the provider reports it
  sendTurn(input: TurnInput): Promise<{ turnId: string }>; // rejects with PreviousTurnActiveError while a turn runs
  steer?(turnId: string, input: TurnInput): Promise<void>; // only when capabilities.steer !== 'none'
  interrupt(turnId: string): Promise<void>; // resolves when the request is accepted; terminal follows as an event
  respond(requestId: string, decision: 'decline' | 'cancel'): Promise<void>;
  unload(): Promise<void>; // shared process: drop the thread from memory; per-session: no-op
  close(reason: 'release' | 'shutdown' | 'error'): Promise<void>;
}

export interface OpenOptions {
  conversationId: string; // Console bound-session id
  cwd: string;
  model?: string;
  effort?: string;
  policy: { approvals: 'never' | 'on-request'; sandbox: 'full-access' | 'workspace-write' | 'read-only' };
  env?: Record<string, string>;
}

export interface TransportInstance {
  readonly plugin: string;
  readonly capabilities: TransportCapabilities;
  probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }>;
  start(options: OpenOptions): Promise<TransportSession>;
  resume(nativeSessionId: string, options: OpenOptions): Promise<TransportSession>; // throws ResumeFailedError
  alive(): Promise<{ pid?: number; connected: boolean }>;
  dispose(reason: 'shutdown' | 'restart'): Promise<void>; // shared: disconnect; never kills a process that other Consoles own
}

export interface TransportPlugin<Config = unknown> {
  readonly id: ProviderId | string;
  create(config: Config, context: PluginContext): TransportInstance;
}

export interface PluginContext {
  runtimeDir: string; // <runtimeDir>/structured/<plugin>/
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  spawnScoped(argv: string[], options: { cwd: string; env: Record<string, string>; unit: string }): Promise<{ pid: number }>;
  meta: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
}

/** `sendTurn` was called while the previous turn on the same session is still running. */
export class PreviousTurnActiveError extends Error {
  readonly code = 'previous_turn_active';
  constructor(message = 'A turn is already running on this session.') {
    super(message);
    this.name = 'PreviousTurnActiveError';
  }
}

/** `resume` could not reattach the native session (unknown id, missing rollout, protocol refusal). */
export class ResumeFailedError extends Error {
  readonly code = 'resume_failed';
  constructor(message = 'The native session could not be resumed.') {
    super(message);
    this.name = 'ResumeFailedError';
  }
}

/** The provider binary or its process is unavailable (not installed, not connected, exited). */
export class TransportUnavailableError extends Error {
  readonly code = 'transport_unavailable';
  constructor(message = 'The provider transport is unavailable.') {
    super(message);
    this.name = 'TransportUnavailableError';
  }
}
