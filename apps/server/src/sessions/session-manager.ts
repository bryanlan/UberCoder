import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CLAUDE_COST_PROFILES, CODEX_COST_PROFILES, visibleModelMatchesProfile, type BoundSession, type ClaudeCostProfileKey, type CodexCostProfileKey, type ConversationSummary, type ModelProfileDeferredReason, type ModelProfileKey, type ModelProfileRequest, type ProviderId, type RecordedUserInput, type SessionEvent, type SessionInputResponse, type SessionModelProfileResponse, type SessionScreen } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { commandToShell } from '../lib/shell.js';
import { sleep } from '../lib/async.js';
import { AppDatabase } from '../db/database.js';
import type { ActiveProject } from '../projects/project-service.js';
import type { MergedProviderSettings } from '../config/service.js';
import type { ProviderAdapter } from '../providers/types.js';
import { isTmuxSessionMissingError, type TmuxClient } from './tmux-client.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { normalizeRawOutputLines } from './live-output/filters.js';
import { parseSessionScreenSnapshot } from './session-screen.js';
import { checkTmuxLiveness } from './tmux-health.js';
import {
  adoptPendingConversation,
  clearPendingRestoreBinding as clearPendingConversationRestoreBinding,
  findPendingAdoptionMatch,
  markPendingSessionNotLive as markPendingConversationSessionNotLive,
  pendingConversationHasRecordedUserInput,
  recordPendingUserInput,
} from './pending-adoption.js';
import {
  combinedTextKeySettleWaitMs,
  extractLastClaudeModelFromText,
  hashScreen,
  screenAllowsLiteralSelectionTokenWithoutInput,
  screenInputChanged,
  screenIsStartingUp,
  screenLooksReadyForLiteralPrompt,
  screenShowsClaudeResumeSessionChoice,
  screenShowsQueuedMessageHint,
  screenShowsInteractiveSelectionHint,
  sessionScreenShowsWorking,
  shouldUseBracketedPasteTransport,
  submittedTextShouldCreateUserTurn,
  TMUX_LITERAL_TEXT_CHUNK_SIZE,
} from './screen-heuristics.js';
import { isRecentTimestamp, nextIdleExpiryDecision, nextScreenWorkingState } from './working-state.js';
import { OutputWatcherRegistry } from './output-watcher.js';
import { RunRecovery } from './run-recovery.js';
import { TranscriptWatcherRegistry } from './transcript-watcher.js';
import { SessionRuntimeRegistry, type SessionRuntimeState } from './session-runtime.js';
import { planKeystrokeSend, type KeystrokeSendPayload } from './keystroke-transport.js';
import type { ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';

const SESSION_COMPLETION_IDLE_MS = 60_000;
const TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS = 1_800;
const CLAUDE_RESUME_READY_WAIT_MS = 15_000;
const QUEUED_MESSAGE_COMPOSER_WAIT_MS = 1_200;
const DEFERRED_TEXT_READY_TTL_MS = 15_000;
const RAW_OUTPUT_SCREEN_UPDATE_THROTTLE_MS = 500;
const SESSION_MODEL_METADATA_KEY = 'lastLiveModel';
const SESSION_MODEL_PROFILE_REQUEST_METADATA_KEY = '@agent_console_model_profile_request_id';
const SESSION_PROFILE_METADATA_KEYS = {
  codex: '@agent_console_codex_profile',
  claude: '@agent_console_claude_profile',
} as const;

function selectedModelProfile(provider: ProviderId, profile: ModelProfileKey) {
  return provider === 'codex' ? CODEX_COST_PROFILES[profile] : CLAUDE_COST_PROFILES[profile];
}

function activeModelProfile(session: BoundSession): ModelProfileKey | undefined {
  return session.provider === 'codex' ? session.codexProfile : session.claudeProfile;
}

function launchModelProfile(provider: ProviderId, profile: ModelProfileKey | undefined) {
  return provider === 'codex' ? { codexProfile: profile } : { claudeProfile: profile };
}
const SESSION_MODEL_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_RECONCILIATION_INTERVAL_MS = 30_000;
const SESSION_RECONCILIATION_INITIAL_DELAY_MS = 5_000;
const AUTO_TRACK_CONCURRENCY = 2;
// Sessions idle this long stop being kept alive and stop being auto-restored by
// reconciliation. Their rows stay bound and tree-visible, so work-mode
// conversations never disappear; selecting one restores its tmux session on demand.
const DEFAULT_SESSION_EAGER_RESTORE_MS = 48 * 60 * 60 * 1000;
// Restoring a session does not move recency, so a freshly restored idle session
// gets this long before the reaper may suspend it again.
const DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS = 24 * 60 * 60 * 1000;
const SESSION_NOT_RUNNING_INPUT_MESSAGE = 'Session is no longer running. Rebind or restore the conversation before sending input.';
const RESTORE_FAILURE_STATUS_TAIL_BYTES = 64 * 1024;
interface SessionRecoveryDependencies {
  projectService: Pick<ProjectService, 'getProjectBySlug' | 'getMergedProviderSettings'>;
  providerRegistry: Pick<ProviderRegistry, 'get'>;
}

interface SessionManagerOptions {
  eagerRestoreWindowMs?: number;
  restoreGraceMs?: number;
}

type SessionEventLogEntry = { type: 'user-input' | 'raw-output' | 'status'; text: string; timestamp: string };

interface AppendedSessionEvent {
  event: SessionEventLogEntry;
  messageId: string;
  offset: number;
}

export type SessionCommandResult = BoundSession & SessionInputResponse;

export class SessionInputRejectedError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionInputRejectedError';
  }
}

export class SessionKeystrokeRejectedError extends SessionInputRejectedError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionKeystrokeRejectedError';
  }
}

function readTextTailSync(filePath: string | undefined, maxBytes: number): string {
  if (!filePath) {
    return '';
  }
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readLastUserInput(eventLogPath: string | undefined): string | undefined {
  if (!eventLogPath) {
    return undefined;
  }

  try {
    const lines = fs.readFileSync(eventLogPath, 'utf8').split(/\r?\n/);
    for (const line of lines.reverse()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as { type?: unknown; text?: unknown };
        if (event.type === 'user-input' && typeof event.text === 'string') {
          return event.text;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readLastStatusEventText(eventLogPath: string | undefined): string | undefined {
  const text = readTextTailSync(eventLogPath, RESTORE_FAILURE_STATUS_TAIL_BYTES);
  if (!text) {
    return undefined;
  }

  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: unknown; text?: unknown };
      if (event.type === 'status' && typeof event.text === 'string') {
        return event.text;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function liveMessageId(sessionId: string, offset: number): string {
  return `live:${sessionId}:${offset}`;
}

function recordedUserInputFromEvent(appended: AppendedSessionEvent | undefined): RecordedUserInput | undefined {
  if (!appended || appended.event.type !== 'user-input') {
    return undefined;
  }
  return {
    id: appended.messageId,
    text: appended.event.text,
    timestamp: appended.event.timestamp,
  };
}

function sessionCommandResult(
  session: BoundSession,
  recordedUserInput?: RecordedUserInput,
): SessionCommandResult {
  return {
    ...session,
    session,
    recordedUserInput,
  };
}

function splitLiteralTextForTmux(text: string): string[] {
  if (!text.length) {
    return [];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  let currentChunkLength = 0;
  for (const char of text) {
    currentChunk += char;
    currentChunkLength += 1;
    if (currentChunkLength >= TMUX_LITERAL_TEXT_CHUNK_SIZE) {
      chunks.push(currentChunk);
      currentChunk = '';
      currentChunkLength = 0;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

interface SessionManagerLogger {
  warn(bindings: unknown, message?: string): void;
}

export interface AutoTrackConversationsResult {
  attempted: number;
  tracked: BoundSession[];
  failed: Array<{
    projectSlug: string;
    provider: ProviderId;
    conversationRef: string;
    error: string;
  }>;
}

export class SessionManager {
  private readonly outputWatchers = new OutputWatcherRegistry();
  private readonly transcriptWatchers = new TranscriptWatcherRegistry();
  private readonly runRecovery: RunRecovery;
  private readonly unsubscribeRealtimeEvents: () => void;
  private readonly runtimes: SessionRuntimeRegistry;
  private reconciliationTimer?: ReturnType<typeof setInterval>;
  private reconciliationStartupTimer?: ReturnType<typeof setTimeout>;
  // Sessions confirmed suspended (tmux dead) this process lifetime, so each
  // reconciliation cycle does not re-check tmux liveness for every idle session.
  private readonly suspendedSessionIds = new Set<string>();
  private readonly suspensionGraceUntilMs = new Map<string, number>();
  private readonly conversationBindRuns = new Map<string, Promise<BoundSession>>();
  private readonly scheduledModelProfileDrains = new Set<string>();
  private readonly requestedModelProfileRedrains = new Set<string>();
  private readonly autoTrackLaunchQueue: Array<() => void> = [];
  private readonly eagerRestoreWindowMs: number;
  private readonly restoreGraceMs: number;
  private autoTrackActiveLaunches = 0;
  private reconciliationRun?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly tmuxClient: TmuxClient,
    private readonly runtimeDir: string,
    private readonly eventBus: RealtimeEventBus,
    private readonly recoveryDependencies?: SessionRecoveryDependencies,
    private readonly logger?: SessionManagerLogger,
    options: SessionManagerOptions = {},
  ) {
    this.eagerRestoreWindowMs = options.eagerRestoreWindowMs ?? DEFAULT_SESSION_EAGER_RESTORE_MS;
    this.restoreGraceMs = options.restoreGraceMs ?? DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.runtimes = new SessionRuntimeRegistry({
      onSlowCommand: ({ sessionId, label, elapsedMs }) => {
        this.logger?.warn(
          { sessionId, command: label, elapsedMs },
          'Session runtime command is still running.',
        );
      },
    });
    this.runRecovery = new RunRecovery({
      db: this.db,
      runExclusive: (id, fn) => this.runtimes.run(id, 'runRecovery', fn),
      canRetry: async (session) => {
        if (this.stopped || this.getCurrentRestorableSession(session)?.id !== session.id || session.status !== 'bound') return 'This session no longer owns the conversation.';
        const project = await this.recoveryDependencies?.projectService.getProjectBySlug(session.projectSlug);
        if (!project || !this.recoveryDependencies?.projectService.getMergedProviderSettings(project, session.provider).enabled) return 'This provider or project is no longer enabled.';
        if (await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) !== 'alive') return 'The provider session is unavailable. Resume it manually.';
        if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id) return 'Session ownership could not be verified.';
        const screen = await this.captureSessionScreen(session);
        if (screen.inputText.trim() || sessionScreenShowsWorking(screen) || screenIsStartingUp(screen) || screenShowsInteractiveSelectionHint(screen) || screenShowsQueuedMessageHint(screen) || screen.contextPercent === undefined) return 'The provider is busy, has an unsent draft, or needs your input.';
        return undefined;
      },
      submit: async (session, text) => {
        if (this.getCurrentRestorableSession(session)?.id !== session.id) throw new Error('Conversation ownership changed before recovery submission.');
        this.runtimeState(session.id).submittedTurnAt = nowIso();
        await this.runInputTmuxAction(session, () => this.submitTextToSession(session.tmuxSessionName, text));
        const timestamp = nowIso();
        const updated = this.updateBoundSessionFields(session.id, { isWorking: true, lastActivityAt: timestamp, updatedAt: timestamp });
        this.appendEvent(updated, { type: 'status', text: 'Submitted automatic recovery for the interrupted turn.', timestamp });
        this.eventBus.emit({ type: 'session.updated', session: updated });
      },
      publish: (session) => this.eventBus.emit({ type: 'session.updated', session }),
      onRunState: (id) => {
        const session = this.db.boundSessions.getById(id);
        if (session?.shouldRestore && session.status === 'bound') {
          this.syncSessionWorkingState(session, { screenShowsWorking: false, capturedAt: nowIso() });
        }
        this.scheduleModelProfileDrain(id);
      },
      onError: (error) => this.logger?.warn({ err: error }, 'Run recovery failed.'),
    });
    this.unsubscribeRealtimeEvents = this.eventBus.subscribe((event) => this.handleRealtimeLifecycleEvent(event));
  }

  private listRestorableSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter((session) => session.shouldRestore && session.status !== 'ended');
  }

  listActiveSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter(isTreeVisibleBoundSession);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const sessionsToDetach = this.listRestorableSessions()
      .filter((session) => session.rawLogPath && (session.status === 'starting' || session.status === 'bound'));
    this.stopped = true;
    this.scheduledModelProfileDrains.clear();
    this.requestedModelProfileRedrains.clear();
    this.runRecovery.stop();
    if (this.reconciliationStartupTimer) {
      clearTimeout(this.reconciliationStartupTimer);
      this.reconciliationStartupTimer = undefined;
    }
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = undefined;
    }
    this.unsubscribeRealtimeEvents();
    await this.closeRawLogPipes(sessionsToDetach);
    for (const sessionId of [...this.outputWatchers.keys()]) {
      this.stopWatching(sessionId);
    }
    for (const sessionId of [...this.transcriptWatchers.keys()]) {
      this.transcriptWatchers.stop(sessionId);
    }
    for (const sessionId of [...this.runtimes.keys()]) {
      const state = this.runtimeState(sessionId);
      if (state.workingIdleTimer) {
        clearTimeout(state.workingIdleTimer);
        state.workingIdleTimer = undefined;
      }
      if (state.rawOutputScreenUpdateTimer) {
        clearTimeout(state.rawOutputScreenUpdateTimer);
        state.rawOutputScreenUpdateTimer = undefined;
      }
    }
    this.runtimes.clear();
  }

  private async closeRawLogPipes(sessions: BoundSession[]): Promise<void> {
    await Promise.all(sessions.map(async (session) => {
      try {
        await this.tmuxClient.closePanePipe(session.tmuxSessionName);
      } catch (error) {
        if (isTmuxSessionMissingError(error)) {
          return;
        }
        this.logger?.warn(
          { err: error, sessionId: session.id, tmuxSessionName: session.tmuxSessionName },
          'Failed to close tmux raw-log pipe during shutdown.',
        );
      }
    }));
  }

  private async tryEnsureRawLogPipe(session: BoundSession): Promise<void> {
    if (!session.rawLogPath) {
      return;
    }
    try {
      await this.tmuxClient.pipePaneToFile(session.tmuxSessionName, session.rawLogPath);
    } catch (error) {
      this.logger?.warn(
        { err: error, sessionId: session.id, tmuxSessionName: session.tmuxSessionName },
        'Failed to attach tmux raw-log pipe.',
      );
    }
  }

  private async cleanupCreatedTmuxSession(session: Pick<BoundSession, 'id' | 'tmuxSessionName'>): Promise<void> {
    try {
      const tmuxOwner = await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id');
      if (tmuxOwner && tmuxOwner !== session.id) {
        return;
      }
      await this.tmuxClient.killSession(session.tmuxSessionName);
    } catch (cleanupError) {
      void cleanupError;
    }
  }

  private runtimeState(sessionId: string): SessionRuntimeState {
    return this.runtimes.state(sessionId);
  }

  private providerTurnIsWorking(sessionId: string): boolean | undefined {
    const run = this.runRecovery.getRunState(sessionId);
    const state = this.runtimeState(sessionId);
    if (!run) return undefined;
    // A previous completion cannot acknowledge a newly submitted turn.
    if (state.submittedTurnAt && run.timestamp < state.submittedTurnAt) return true;
    state.submittedTurnAt = undefined;
    return run.status === 'running';
  }

  private shouldWatchSession(session: BoundSession): boolean {
    return !this.stopped
      && session.shouldRestore !== false
      && (session.status === 'starting' || session.status === 'bound');
  }

  private handleRealtimeLifecycleEvent(event: SessionEvent): void {
    if (this.stopped) {
      return;
    }

    if (event.type === 'session.updated') {
      if (!this.shouldWatchSession(event.session)) {
        this.stopWatching(event.session.id);
        return;
      }
      this.watchSessionOutput(event.session);
      if (event.session.modelProfileRequest) {
        this.scheduleModelProfileDrain(event.session.id);
      }
      return;
    }

    if (event.type === 'session.released') {
      this.stopWatching(event.sessionId);
      return;
    }

    if (event.type === 'conversation.index-updated') {
      for (const session of this.listRestorableSessions()) {
        if (!this.shouldWatchSession(session)) {
          continue;
        }
        if (
          event.projectSlug && event.projectSlug !== session.projectSlug
          || event.provider && event.provider !== session.provider
          || event.conversationRef && event.conversationRef !== session.conversationRef
        ) {
          continue;
        }
        this.watchSessionOutput(session);
      }
    }
  }

  async observeSessions(): Promise<void> {
    for (const session of this.listRestorableSessions()) {
      await this.runtimes.run(session.id, 'observeSession', () => this.refreshSessionState(session, { restoreMissing: false }));
    }
  }

  private cleanupSessionRuntimeDir(sessionId: string): void {
    const sessionDir = path.join(this.runtimeDir, sessionId);
    void fs.promises.rm(sessionDir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger?.warn({ err: error, sessionId }, 'Failed to remove ended session runtime directory.');
    });
  }

  /**
   * Removes runtime log directories that no longer serve a live or restorable
   * session: dirs for ended non-restorable sessions and dirs with no session row.
   */
  async cleanupEndedSessionRuntimeDirs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.runtimeDir);
    } catch {
      return;
    }
    const sessions = new Map(this.db.boundSessions.list().map((session) => [session.id, session]));
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}$/i.test(entry)) {
        continue;
      }
      const session = sessions.get(entry);
      if (session && !(session.status === 'ended' && !session.shouldRestore)) {
        continue;
      }
      await fs.promises.rm(path.join(this.runtimeDir, entry), { recursive: true, force: true }).catch((error: unknown) => {
        this.logger?.warn({ err: error, sessionId: entry }, 'Failed to sweep ended session runtime directory.');
      });
    }
  }

  async reconcileSessions(): Promise<void> {
    for (const session of this.listRestorableSessions()) {
      if (session.modelProfileRequest) {
        await this.runtimes.run(session.id, 'reconcileModelProfileRequest', () => this.drainModelProfileRequestInternal(session.id));
        const current = this.db.boundSessions.getById(session.id);
        if (!current?.shouldRestore || current.status === 'error') {
          continue;
        }
      }
      if (this.isIdleSuspendable(session)) {
        await this.runtimes.run(session.id, 'reconcileSession', () => this.suspendIdleSession(session));
        continue;
      }
      this.suspendedSessionIds.delete(session.id);
      await this.runtimes.run(session.id, 'reconcileSession', () => this.refreshSessionState(session, { restoreMissing: true }));
    }
  }

  private sessionIdleTimestampMs(session: BoundSession): number {
    const candidates = [session.lastActivityAt, session.lastOutputAt, session.lastCompletedAt, session.startedAt];
    let latest = 0;
    for (const candidate of candidates) {
      const parsed = candidate ? Date.parse(candidate) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > latest) {
        latest = parsed;
      }
    }
    return latest;
  }

  private isIdleSuspendable(session: BoundSession): boolean {
    if (session.isWorking || session.modelProfileRequest || session.conversationRef.startsWith('pending:')) {
      return false;
    }
    const graceUntilMs = this.suspensionGraceUntilMs.get(session.id);
    if (graceUntilMs !== undefined && Date.now() < graceUntilMs) {
      return false;
    }
    const idleSinceMs = this.sessionIdleTimestampMs(session);
    return idleSinceMs > 0 && Date.now() - idleSinceMs >= this.eagerRestoreWindowMs;
  }

  private async suspendIdleSession(staleSession: BoundSession): Promise<void> {
    // The idle decision was made before this callback reached the front of the
    // session's operation queue; inputs, binds, or restores may have run since.
    // Re-read the row and re-check so fresh activity or a new restore grace is
    // never followed by a stale kill.
    const session = this.db.boundSessions.getById(staleSession.id);
    if (!session || !session.shouldRestore || !this.isIdleSuspendable(session)) {
      return;
    }
    if (this.suspendedSessionIds.has(session.id)) {
      return;
    }
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness === 'unknown') {
      return;
    }
    if (liveness === 'alive') {
      try {
        await this.tmuxClient.killSession(session.tmuxSessionName);
      } catch {
        return;
      }
      const finalLiveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
      if (finalLiveness !== 'dead') {
        return;
      }
      this.appendEvent(session, {
        type: 'status',
        text: 'Session suspended after extended idle; it will restore on next use.',
        timestamp: nowIso(),
      });
    }
    this.stopWatching(session.id);
    this.runtimes.clearEphemeral(session.id);
    this.suspendedSessionIds.add(session.id);
    if (session.isWorking || session.pid !== undefined) {
      const suspended: BoundSession = { ...session, isWorking: false, pid: undefined, updatedAt: nowIso() };
      this.db.boundSessions.upsert(suspended);
      this.eventBus.emit({ type: 'session.updated', session: suspended });
    }
  }

  startSessionReconciliation(options: { intervalMs?: number; initialDelayMs?: number } = {}): void {
    if (this.reconciliationTimer || this.reconciliationStartupTimer) {
      return;
    }

    const intervalMs = options.intervalMs ?? SESSION_RECONCILIATION_INTERVAL_MS;
    const initialDelayMs = options.initialDelayMs ?? SESSION_RECONCILIATION_INITIAL_DELAY_MS;
    const run = () => {
      if (this.stopped || this.reconciliationRun) {
        return;
      }
      this.reconciliationRun = this.reconcileSessions()
        .catch((error) => {
          this.logger?.warn({ err: error }, 'Failed to reconcile live sessions.');
        })
        .finally(() => {
          this.reconciliationRun = undefined;
        });
    };

    this.reconciliationStartupTimer = setTimeout(() => {
      this.reconciliationStartupTimer = undefined;
      run();
      if (this.stopped) {
        return;
      }
      this.reconciliationTimer = setInterval(run, intervalMs);
      this.reconciliationTimer.unref?.();
    }, initialDelayMs);
    this.reconciliationStartupTimer.unref?.();
  }

  private async sendLiteralTextToSession(sessionName: string, text: string): Promise<void> {
    for (const chunk of splitLiteralTextForTmux(text)) {
      await this.tmuxClient.sendLiteralText(sessionName, chunk);
    }
  }

  private recordRestoreFailure(session: BoundSession, text: string): BoundSession {
    if (session.status === 'error') {
      if (readLastStatusEventText(session.eventLogPath) === text) {
        return session;
      }
      const failed = { ...session, isWorking: false };
      if (session.isWorking) {
        this.db.boundSessions.upsert(failed);
      }
      this.appendEvent(failed, { type: 'status', text, timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      return failed;
    }
    const failedAt = nowIso();
    const failed = { ...session, status: 'error' as const, updatedAt: failedAt, isWorking: false };
    this.db.boundSessions.upsert(failed);
    this.appendEvent(failed, { type: 'status', text, timestamp: failedAt });
    this.eventBus.emit({ type: 'session.updated', session: failed });
    return failed;
  }

  private getCurrentRestorableSession(session: BoundSession): BoundSession | undefined {
    const current = this.db.boundSessions.getById(session.id);
    if (!current || !current.shouldRestore || current.status === 'releasing') {
      return undefined;
    }
    const owner = this.db.boundSessions.getRestorableByConversation(
      current.projectSlug,
      current.provider,
      current.conversationRef,
    );
    return owner?.id === current.id ? current : undefined;
  }

  private recordRestoreFailureIfOwned(session: BoundSession, text: string): BoundSession | undefined {
    const current = this.getCurrentRestorableSession(session);
    return current ? this.recordRestoreFailure(current, text) : undefined;
  }

  private markSessionMissingDuringInput(session: BoundSession): void {
    this.stopWatching(session.id);
    this.runtimes.clearEphemeral(session.id);
    const current = this.db.boundSessions.getById(session.id) ?? session;
    if (current.status === 'error' || current.status === 'ended') {
      return;
    }
    const failedAt = nowIso();
    const failed = { ...current, status: 'error' as const, updatedAt: failedAt, isWorking: false };
    this.db.boundSessions.upsert(failed);
    this.appendEvent(failed, {
      type: 'status',
      text: 'Session exited before input could be delivered.',
      timestamp: failedAt,
    });
    this.eventBus.emit({ type: 'session.updated', session: failed });
  }

  private rejectMissingSessionInputError(session: BoundSession, error: unknown): never {
    if (isTmuxSessionMissingError(error)) {
      this.markSessionMissingDuringInput(session);
      throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
    }
    throw error;
  }

  private async runInputTmuxAction<T>(session: BoundSession, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      return this.rejectMissingSessionInputError(session, error);
    }
  }

  private async submitTextToSession(sessionName: string, text: string): Promise<void> {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) {
        if (shouldUseBracketedPasteTransport(line)) {
          await this.tmuxClient.pasteText(sessionName, line);
        } else {
          await this.sendLiteralTextToSession(sessionName, line);
        }
      }
      await this.tmuxClient.sendKeys(sessionName, ['Enter']);
    }
  }

  private ensureSessionLogPaths(session: BoundSession): BoundSession {
    const sessionDir = path.join(this.runtimeDir, session.id);
    const rawLogPath = session.rawLogPath ?? path.join(sessionDir, 'raw.log');
    const eventLogPath = session.eventLogPath ?? path.join(sessionDir, 'events.jsonl');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(rawLogPath, '', { flag: 'a' });
    fs.writeFileSync(eventLogPath, '', { flag: 'a' });
    if (rawLogPath === session.rawLogPath && eventLogPath === session.eventLogPath) {
      return session;
    }
    const updated = {
      ...session,
      rawLogPath,
      eventLogPath,
    };
    this.db.boundSessions.upsert(updated);
    return updated;
  }

  private buildRecoveryLaunchCommand(
    session: BoundSession,
    project: ActiveProject,
    provider: ProviderAdapter,
    providerSettings: MergedProviderSettings,
  ): { cwd: string; argv: string[]; env: Record<string, string> } | undefined {
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    if (resumeConversationRef) {
      return provider.getLaunchCommand(project, resumeConversationRef, providerSettings, {
        codexProfile: session.provider === 'codex' ? session.codexProfile : undefined,
        claudeProfile: session.provider === 'claude' ? session.claudeProfile : undefined,
      });
    }
    return undefined;
  }

  private async tryResolvePendingResumeSession(
    session: BoundSession,
    project: ActiveProject,
    provider: ProviderAdapter,
    providerSettings: MergedProviderSettings,
  ): Promise<BoundSession> {
    if (!session.conversationRef.startsWith('pending:') || session.resumeConversationRef) {
      return session;
    }

    const pending = this.db.pendingConversations.get(session.conversationRef);
    if (!pending) {
      return session;
    }

    const conversations = provider.listPendingAdoptionCandidates
      ? await provider.listPendingAdoptionCandidates(project, pending, providerSettings)
      : await provider.listConversations(project, providerSettings);
    const matchedConversation = findPendingAdoptionMatch(pending, conversations);
    if (!matchedConversation) {
      return session;
    }

    const adoption = adoptPendingConversation({
      db: this.db,
      projectSlug: project.slug,
      providerId: provider.id,
      pendingRef: pending.ref,
      matchedConversation,
    });
    if (adoption.reboundSession) {
      this.eventBus.emit({ type: 'session.updated', session: adoption.reboundSession });
    }
    return this.db.boundSessions.getById(session.id) ?? session;
  }

  private hasRecordedPendingUserInput(session: BoundSession): boolean {
    if (!session.conversationRef.startsWith('pending:')) {
      return false;
    }
    const pending = this.db.pendingConversations.get(session.conversationRef);
    return pendingConversationHasRecordedUserInput(pending);
  }

  private markPendingSessionNotLive(session: BoundSession): void {
    if (!session.conversationRef.startsWith('pending:')) {
      return;
    }

    const updatedAt = nowIso();
    const { failed, shouldEmitFailure } = markPendingConversationSessionNotLive({
      db: this.db,
      session,
      updatedAt,
    });
    if (shouldEmitFailure) {
      this.appendEvent(failed, {
        type: 'status',
        text: 'Pending session is no longer live; waiting for provider transcript adoption.',
        timestamp: updatedAt,
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
    }
  }

  private async restoreSession(requestedSession: BoundSession): Promise<BoundSession | undefined> {
    let session = this.getCurrentRestorableSession(requestedSession);
    if (!session) {
      return undefined;
    }
    // Restores do not move recency, so grant an explicit grace window before the
    // idle reaper may suspend this session again.
    this.suspendedSessionIds.delete(session.id);
    this.suspensionGraceUntilMs.set(session.id, Date.now() + this.restoreGraceMs);

    const dependencies = this.recoveryDependencies;
    if (!dependencies) {
      return undefined;
    }

    const project = await dependencies.projectService.getProjectBySlug(session.projectSlug);
    if (!project) {
      this.recordRestoreFailureIfOwned(session, 'Failed to restore session: project not found.');
      return undefined;
    }

    const provider = dependencies.providerRegistry.get(session.provider);
    const providerSettings = dependencies.projectService.getMergedProviderSettings(project, session.provider);
    if (!providerSettings.enabled) {
      this.recordRestoreFailureIfOwned(session, 'Failed to restore session: provider is disabled.');
      return undefined;
    }

    const resolvedSession = await this.tryResolvePendingResumeSession(session, project, provider, providerSettings);
    session = this.getCurrentRestorableSession(resolvedSession);
    if (!session) {
      return undefined;
    }
    const launch = this.buildRecoveryLaunchCommand(session, project, provider, providerSettings);
    if (!launch) {
      const pending = session.conversationRef.startsWith('pending:')
        ? this.db.pendingConversations.get(session.conversationRef)
        : undefined;
      const hasRecordedUserInput = this.hasRecordedPendingUserInput(session);
      if (pending && !hasRecordedUserInput) {
        const ended = clearPendingConversationRestoreBinding({
          db: this.db,
          session,
        });
        this.appendEvent(ended, {
          type: 'status',
          text: 'Pending session expired before its first prompt was submitted.',
          timestamp: ended.updatedAt,
        });
        this.eventBus.emit({ type: 'session.updated', session: ended });
        return undefined;
      }
      this.recordRestoreFailureIfOwned(session, 'Failed to restore session: no resumable conversation reference is available yet.');
      return undefined;
    }

    const prepared = this.ensureSessionLogPaths(session);
    const shouldEmitRestoreAttempt = prepared.status !== 'error';
    const restoring = {
      ...prepared,
      status: 'starting' as const,
      updatedAt: nowIso(),
      isWorking: false,
      pid: undefined,
    };
    if (shouldEmitRestoreAttempt) {
      this.db.boundSessions.upsert(restoring);
      this.eventBus.emit({ type: 'session.updated', session: restoring });
      this.appendEvent(restoring, { type: 'status', text: 'Restoring bound session.', timestamp: nowIso() });
    }

    let tmuxCreated = false;
    try {
      await this.tmuxClient.newDetachedSession(restoring.tmuxSessionName, launch.cwd, commandToShell(launch.argv, launch.env));
      tmuxCreated = true;
      await this.tmuxClient.pipePaneToFile(restoring.tmuxSessionName, restoring.rawLogPath!);
      await this.configureTmuxSessionOptions(restoring.tmuxSessionName, {
        sessionId: restoring.id,
        conversationRef: restoring.conversationRef,
        provider: restoring.provider,
      });
      const pid = await this.tmuxClient.getPanePid(restoring.tmuxSessionName);
      await this.verifyStartupSurvived({ ...restoring, pid });
      const current = this.getCurrentRestorableSession(restoring);
      if (!current) {
        throw new Error('Session restore was superseded during startup.');
      }
      const rebound: BoundSession = {
        ...current,
        status: 'bound',
        updatedAt: nowIso(),
        pid,
      };
      this.db.boundSessions.upsert(rebound);
      this.appendEvent(rebound, { type: 'status', text: 'Restored bound session.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: rebound });
      this.watchSessionOutput(rebound);
      await this.emitScreenUpdate(rebound);
      return rebound;
    } catch (error) {
      if (tmuxCreated) {
        await this.cleanupCreatedTmuxSession(restoring);
      }
      this.recordRestoreFailureIfOwned(
        restoring,
        `Failed to restore session: ${error instanceof Error ? error.message : 'Unknown error.'}`,
      );
      return undefined;
    }
  }

  async bindConversation(input: {
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    conversationRef: string;
    title: string;
    kind: ConversationSummary['kind'];
    initialPrompt?: string;
    codexProfile?: CodexCostProfileKey;
    claudeProfile?: ClaudeCostProfileKey;
    autoTrackedAt?: string;
  }): Promise<BoundSession> {
    const bindKey = `${input.project.slug}:${input.provider.id}:${input.conversationRef}`;
    const activeRun = this.conversationBindRuns.get(bindKey);
    if (activeRun) {
      return this.applyAutoTrackProvenance(await activeRun, input.autoTrackedAt);
    }

    const run = (async () => {
      const existing = this.db.boundSessions.getRestorableByConversation(input.project.slug, input.provider.id, input.conversationRef);
      const sessionId = existing?.id ?? randomUUID();
      const result = await this.runtimes.run(sessionId, 'bind', () => this.bindConversationInternal(input, sessionId));
      return result.session;
    })();
    this.conversationBindRuns.set(bindKey, run);
    try {
      return this.applyAutoTrackProvenance(await run, input.autoTrackedAt);
    } finally {
      if (this.conversationBindRuns.get(bindKey) === run) {
        this.conversationBindRuns.delete(bindKey);
      }
    }
  }

  private applyAutoTrackProvenance(session: BoundSession, autoTrackedAt?: string): BoundSession {
    if (!autoTrackedAt || session.autoTrackedAt === autoTrackedAt) {
      return session;
    }
    const current = this.db.boundSessions.getById(session.id) ?? session;
    const autoTrackedSession = { ...current, autoTrackedAt };
    this.db.boundSessions.upsert(autoTrackedSession);
    this.eventBus.emit({ type: 'session.updated', session: autoTrackedSession });
    return autoTrackedSession;
  }

  private acquireAutoTrackLaunchSlot(): Promise<void> {
    if (this.autoTrackActiveLaunches < AUTO_TRACK_CONCURRENCY) {
      this.autoTrackActiveLaunches += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.autoTrackLaunchQueue.push(() => {
        this.autoTrackActiveLaunches += 1;
        resolve();
      });
    });
  }

  private releaseAutoTrackLaunchSlot(): void {
    this.autoTrackActiveLaunches = Math.max(0, this.autoTrackActiveLaunches - 1);
    const next = this.autoTrackLaunchQueue.shift();
    if (next) {
      next();
    }
  }

  private async runWithAutoTrackLaunchSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireAutoTrackLaunchSlot();
    try {
      return await fn();
    } finally {
      this.releaseAutoTrackLaunchSlot();
    }
  }

  async autoTrackConversations(
    conversations: ConversationSummary[],
    autoTrackedAt = nowIso(),
  ): Promise<AutoTrackConversationsResult> {
    const uniqueConversations = [...new Map(
      conversations
        .filter((conversation) => conversation.kind === 'history')
        .map((conversation) => [
          `${conversation.projectSlug}:${conversation.provider}:${conversation.ref}`,
          conversation,
        ]),
    ).values()];
    const tracked: BoundSession[] = [];
    const failed: AutoTrackConversationsResult['failed'] = [];
    const dependencies = this.recoveryDependencies;
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < uniqueConversations.length) {
        const conversation = uniqueConversations[nextIndex++];
        if (!conversation) {
          continue;
        }
        try {
          if (!dependencies) {
            throw new Error('Session recovery dependencies are unavailable.');
          }
          const project = await dependencies.projectService.getProjectBySlug(conversation.projectSlug);
          if (!project) {
            throw new Error('Project not found.');
          }
          const provider = dependencies.providerRegistry.get(conversation.provider);
          const providerSettings = dependencies.projectService.getMergedProviderSettings(project, conversation.provider);
          if (!providerSettings.enabled) {
            throw new Error('Provider is disabled.');
          }
          tracked.push(await this.runWithAutoTrackLaunchSlot(() => this.bindConversation({
            project,
            provider,
            providerSettings,
            conversationRef: conversation.ref,
            title: conversation.title,
            kind: 'history',
            autoTrackedAt,
          })));
        } catch (error) {
          const failure = {
            projectSlug: conversation.projectSlug,
            provider: conversation.provider,
            conversationRef: conversation.ref,
            error: error instanceof Error ? error.message : 'Unknown auto-track failure.',
          };
          failed.push(failure);
          this.logger?.warn(failure, 'Failed to auto-track recent provider conversation.');
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(AUTO_TRACK_CONCURRENCY, uniqueConversations.length) },
      () => runWorker(),
    ));
    return {
      attempted: uniqueConversations.length,
      tracked,
      failed,
    };
  }

  private async bindConversationInternal(input: {
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    conversationRef: string;
    title: string;
    kind: ConversationSummary['kind'];
    initialPrompt?: string;
    codexProfile?: CodexCostProfileKey;
    claudeProfile?: ClaudeCostProfileKey;
    autoTrackedAt?: string;
  }, sessionId: string): Promise<SessionCommandResult> {
    const existing = this.db.boundSessions.getRestorableByConversation(input.project.slug, input.provider.id, input.conversationRef);
    if (existing) {
      const liveSession = await this.refreshSessionState(existing);
      if (liveSession) {
        return sessionCommandResult(liveSession);
      }
      throw new Error(`Conversation ${input.conversationRef} is still bound but could not be restored.`);
    }

    const tmuxSessionName = this.buildTmuxSessionName(input.project.slug, input.provider.id, input.conversationRef);
    const sessionDir = path.join(this.runtimeDir, sessionId);
    const rawLogPath = path.join(sessionDir, 'raw.log');
    const eventLogPath = path.join(sessionDir, 'events.jsonl');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(rawLogPath, '', { flag: 'a' });
    fs.writeFileSync(eventLogPath, '', { flag: 'a' });

    const launch = input.provider.getLaunchCommand(
      input.project,
      input.kind === 'pending' ? null : input.conversationRef,
      input.providerSettings,
      { initialPrompt: input.initialPrompt, codexProfile: input.codexProfile, claudeProfile: input.claudeProfile },
    );
    const now = nowIso();
    const initialPrompt = input.initialPrompt?.trim();
    const session: BoundSession = {
      id: sessionId,
      provider: input.provider.id,
      codexProfile: input.provider.id === 'codex'
        ? input.codexProfile ?? (input.kind === 'pending' ? 'medium' : undefined)
        : undefined,
      claudeProfile: input.provider.id === 'claude'
        ? input.claudeProfile ?? (input.kind === 'pending' && !input.providerSettings.commands.newCommand.some((arg) =>
          arg === '--model' || arg.startsWith('--model=') || arg === '--effort' || arg.startsWith('--effort=')) ? 'medium' : undefined)
        : undefined,
      projectSlug: input.project.slug,
      conversationRef: input.conversationRef,
      resumeConversationRef: input.kind === 'history' ? input.conversationRef : undefined,
      tmuxSessionName,
      status: 'starting',
      shouldRestore: true,
      title: input.title,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: initialPrompt ? now : undefined,
      lastOutputAt: undefined,
      lastCompletedAt: undefined,
      autoTrackedAt: input.autoTrackedAt,
      isWorking: false,
      rawLogPath,
      eventLogPath,
    };
    this.db.boundSessions.upsert(session);

    let tmuxCreated = false;
    try {
      await this.tmuxClient.newDetachedSession(tmuxSessionName, launch.cwd, commandToShell(launch.argv, launch.env));
      tmuxCreated = true;
      await this.tmuxClient.pipePaneToFile(tmuxSessionName, rawLogPath);
      await this.configureTmuxSessionOptions(tmuxSessionName, {
        sessionId,
        conversationRef: input.conversationRef,
        provider: input.provider.id,
      });
      const pid = await this.tmuxClient.getPanePid(tmuxSessionName);

      await this.verifyStartupSurvived({ ...session, pid });

      const boundSession: BoundSession = {
        ...session,
        status: 'bound',
        updatedAt: nowIso(),
        pid,
      };
      this.db.boundSessions.upsert(boundSession);
      let recordedInitialUserInput: RecordedUserInput | undefined;
      if (initialPrompt && boundSession.conversationRef.startsWith('pending:')) {
        const inputAt = nowIso();
        recordPendingUserInput({
          db: this.db,
          pendingRef: boundSession.conversationRef,
          boundSessionId: boundSession.id,
          text: initialPrompt,
          inputAt,
        });
        recordedInitialUserInput = recordedUserInputFromEvent(
          this.appendEvent(boundSession, { type: 'user-input', text: initialPrompt, timestamp: inputAt }),
        );
      }
      this.appendEvent(boundSession, { type: 'status', text: `Bound ${input.provider.id} session in ${input.project.displayName}.`, timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: boundSession });
      this.watchSessionOutput(boundSession);
      await this.emitScreenUpdate(boundSession);
      return sessionCommandResult(boundSession, recordedInitialUserInput);
    } catch (error) {
      if (tmuxCreated) {
        await this.cleanupCreatedTmuxSession(session);
      }
      const failed: BoundSession = {
        ...session,
        status: 'error',
        shouldRestore: false,
        updatedAt: nowIso(),
        isWorking: false,
      };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, {
        type: 'status',
        text: `Failed to bind session: ${error instanceof Error ? error.message : 'Unknown error.'}`,
        timestamp: nowIso(),
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw error;
    }
  }

  async sendInput(sessionId: string, text: string): Promise<SessionCommandResult> {
    this.runRecovery.cancel(sessionId);
    return await this.runtimes.run(sessionId, 'sendInput', () => this.sendInputInternal(sessionId, text));
  }

  private async sendInputInternal(sessionId: string, text: string): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
    }
    this.runtimeState(liveSession.id).submittedTurnAt = nowIso();
    await this.runInputTmuxAction(liveSession, () => this.submitTextToSession(liveSession.tmuxSessionName, text));
    const activityAt = nowIso();
    const updated = this.updateBoundSessionFields(liveSession.id, {
      updatedAt: activityAt,
      lastActivityAt: activityAt,
    });
    if (updated.conversationRef.startsWith('pending:')) {
      recordPendingUserInput({
        db: this.db,
        pendingRef: updated.conversationRef,
        boundSessionId: updated.id,
        text,
        inputAt: activityAt,
      });
    }
    const recordedUserInput = recordedUserInputFromEvent(
      this.appendEvent(updated, { type: 'user-input', text, timestamp: activityAt }),
    );
    await this.emitScreenUpdate(updated);
    return sessionCommandResult(updated, recordedUserInput);
  }

  private updateBoundSessionFields(sessionId: string, patch: Partial<BoundSession>): BoundSession {
    const current = this.mustGetSession(sessionId);
    const updated: BoundSession = {
      ...current,
      ...patch,
    };
    this.db.boundSessions.upsert(updated);
    return updated;
  }

  async sendKeystrokes(sessionId: string, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    if (payload.text || payload.keys?.length) this.runRecovery.cancel(sessionId);
    return await this.runtimes.run(sessionId, 'sendKeystrokes', () => this.sendKeystrokesInternal(sessionId, payload));
  }

  private async sendKeystrokesInternal(sessionId: string, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
    }
    if (payload.keys?.includes('Escape')) this.runtimeState(liveSession.id).submittedTurnAt = undefined;

    let plan = planKeystrokeSend(undefined, payload, liveSession.provider, {
      deferredTextReady: payload.deferScreenUpdate === true
        && (this.runtimeState(liveSession.id).deferredTextReadyUntil ?? 0) > Date.now(),
    });
    if (plan.hasSpecialKeys) {
      this.runtimeState(liveSession.id).deferredTextReadyUntil = undefined;
    }

    if (plan.isTextOnlySend && plan.transportText) {
      let preparedScreen: SessionScreen | undefined;
      if (plan.shouldCapturePreparedScreenBeforeText) {
        preparedScreen = await this.captureSessionScreen(liveSession);
        if (
          screenIsStartingUp(preparedScreen)
          || screenShowsQueuedMessageHint(preparedScreen)
          || (plan.shouldProbeClaudeResumePrompt && screenShowsClaudeResumeSessionChoice(preparedScreen))
        ) {
          const screenToPrepare = preparedScreen;
          preparedScreen = await this.runInputTmuxAction(
            liveSession,
            () => this.prepareScreenForCombinedTextSubmit(liveSession, screenToPrepare),
          );
        }
        if (plan.shouldProbeClaudeResumePrompt && screenShowsClaudeResumeSessionChoice(preparedScreen)) {
          throw new SessionKeystrokeRejectedError('Claude resume choice was not resolved before text entry. The draft was not submitted.');
        }
      }
      if (plan.shouldProbeDeferredSelection && preparedScreen && screenAllowsLiteralSelectionTokenWithoutInput(preparedScreen, plan.trimmedTransportText)) {
        this.runtimeState(liveSession.id).deferredSelectionInput = {
          text: plan.trimmedTransportText,
          expiresAt: Date.now() + DEFERRED_TEXT_READY_TTL_MS,
        };
      }
      const transportText = plan.transportText;
      if (plan.useBracketedPasteTransport) {
        await this.runInputTmuxAction(
          liveSession,
          () => this.tmuxClient.pasteText(liveSession.tmuxSessionName, transportText),
        );
      } else {
        await this.runInputTmuxAction(
          liveSession,
          () => this.sendLiteralTextToSession(liveSession.tmuxSessionName, transportText),
        );
      }

      const activityAt = nowIso();
      const updated = this.updateBoundSessionFields(liveSession.id, {
        updatedAt: activityAt,
        lastActivityAt: activityAt,
      });
      this.runtimeState(updated.id).deferredTextReadyUntil = Date.now() + DEFERRED_TEXT_READY_TTL_MS;
      if (!payload.deferScreenUpdate) {
        await this.emitScreenUpdate(updated);
      }
      return sessionCommandResult(updated);
    }

    const beforeScreen = await this.captureSessionScreen(liveSession);
    let latestObservedScreen = beforeScreen;
    let latestObservedHash = hashScreen(beforeScreen);
    let shouldRecordTextAsUserInput = false;
    plan = planKeystrokeSend(beforeScreen, payload, liveSession.provider);
    const submittedText = plan.submittedText;
    const rememberedSelection = submittedText ? this.runtimeState(liveSession.id).deferredSelectionInput : undefined;
    const submittedDeferredSelection = Boolean(
      rememberedSelection
        && rememberedSelection.expiresAt > Date.now()
        && rememberedSelection.text === submittedText,
    );
    if (plan.hasSpecialKeys) {
      this.runtimeState(liveSession.id).deferredSelectionInput = undefined;
    }

    if (plan.transportText) {
      const transportText = plan.transportText;
      let expectsVisibleInputChange = plan.expectsVisibleInputChange;
      shouldRecordTextAsUserInput = plan.shouldRecordTextAsUserInput;
      const useBracketedPasteTransport = plan.useBracketedPasteTransport;
      const shouldPrepareClaudeResumePrompt = plan.shouldPrepareClaudeResumePrompt;
      if ((plan.hasSpecialKeys || useBracketedPasteTransport) && (expectsVisibleInputChange || shouldPrepareClaudeResumePrompt)) {
        latestObservedScreen = await this.runInputTmuxAction(
          liveSession,
          () => this.prepareScreenForCombinedTextSubmit(liveSession, latestObservedScreen),
        );
        latestObservedHash = hashScreen(latestObservedScreen);
        if (shouldPrepareClaudeResumePrompt && screenShowsClaudeResumeSessionChoice(latestObservedScreen)) {
          throw new SessionKeystrokeRejectedError('Claude resume choice was not resolved before text entry. The draft was not submitted.');
        }
        plan = planKeystrokeSend(latestObservedScreen, payload, liveSession.provider);
        expectsVisibleInputChange = plan.expectsVisibleInputChange;
        shouldRecordTextAsUserInput = plan.shouldRecordTextAsUserInput;
      }
      const textAlreadyVisible = plan.textAlreadyVisible;
      const textEntryScreen = latestObservedScreen;
      const transportTextShouldCreateUserTurn = plan.transportTextShouldCreateUserTurn;
      if (!textAlreadyVisible) {
        if (useBracketedPasteTransport) {
          await this.runInputTmuxAction(
            liveSession,
            () => this.tmuxClient.pasteText(liveSession.tmuxSessionName, transportText),
          );
        } else {
          await this.runInputTmuxAction(
            liveSession,
            () => this.sendLiteralTextToSession(liveSession.tmuxSessionName, transportText),
          );
        }
        if (plan.hasSpecialKeys || useBracketedPasteTransport) {
          const textSettledScreen = await this.waitForInputTextChange(
            liveSession,
            latestObservedHash,
            textEntryScreen,
            combinedTextKeySettleWaitMs(transportText),
          );
          if (textSettledScreen) {
            latestObservedScreen = textSettledScreen;
            latestObservedHash = hashScreen(textSettledScreen);
            this.publishScreenUpdate(liveSession, textSettledScreen);
          }
          if (expectsVisibleInputChange && transportTextShouldCreateUserTurn && !screenInputChanged(textEntryScreen, latestObservedScreen)) {
            this.appendDebugTrace(liveSession, {
              action: 'send-keystrokes-rejected',
              text: payload.text,
              keys: payload.keys,
              before: textEntryScreen,
              after: latestObservedScreen,
            });
            throw new SessionKeystrokeRejectedError('Live session did not accept the typed text into its input buffer. The draft was not submitted.');
          }
        }
      }
    }
    if (plan.hasSpecialKeys) {
      if (payload.keys?.includes('Enter') && !submittedDeferredSelection
        && submittedTextShouldCreateUserTurn(beforeScreen, submittedText ?? (shouldRecordTextAsUserInput ? payload.text : undefined))) {
        this.runtimeState(liveSession.id).submittedTurnAt = nowIso();
      }
      await this.runInputTmuxAction(
        liveSession,
        () => this.tmuxClient.sendKeys(liveSession.tmuxSessionName, payload.keys ?? []),
      );
    }

    const activityAt = nowIso();
    const updated = this.updateBoundSessionFields(liveSession.id, {
      updatedAt: activityAt,
      lastActivityAt: activityAt,
    });
    const submittedUserTurnText = !submittedDeferredSelection && submittedTextShouldCreateUserTurn(beforeScreen, submittedText)
      ? submittedText
      : undefined;
    const fallbackUserTurnText = submittedText === undefined
      && payload.keys?.includes('Enter')
      && shouldRecordTextAsUserInput
      && submittedTextShouldCreateUserTurn(beforeScreen, payload.text)
      ? payload.text
      : undefined;
    const userInputTextToRecord = submittedUserTurnText
      ?? fallbackUserTurnText;
    if (userInputTextToRecord && updated.conversationRef.startsWith('pending:')) {
      recordPendingUserInput({
        db: this.db,
        pendingRef: updated.conversationRef,
        boundSessionId: updated.id,
        text: userInputTextToRecord,
        inputAt: activityAt,
      });
    }
    const recordedUserInput = userInputTextToRecord
      ? recordedUserInputFromEvent(this.appendEvent(updated, { type: 'user-input', text: userInputTextToRecord, timestamp: activityAt }))
      : undefined;
    await this.emitScreenUpdate(updated, {
      waitForChange: Boolean(payload.keys?.length),
      previousHashOverride: latestObservedHash,
    });
    const afterScreen = await this.captureSessionScreen(updated);
    this.publishScreenUpdate(updated, afterScreen);
    this.appendDebugTrace(updated, {
      action: 'send-keystrokes',
      text: payload.text,
      keys: payload.keys,
      before: latestObservedScreen,
      after: afterScreen,
    });
    return sessionCommandResult(updated, recordedUserInput);
  }

  async restartPendingSessionWithInitialPrompt(input: {
    sessionId: string;
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    initialPrompt: string;
  }): Promise<SessionCommandResult> {
    return await this.runtimes.run(input.sessionId, 'restartPendingSessionWithInitialPrompt', () => this.restartPendingSessionWithInitialPromptInternal(input));
  }

  private async restartPendingSessionWithInitialPromptInternal(input: {
    sessionId: string;
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    initialPrompt: string;
  }): Promise<SessionCommandResult> {
    const session = this.mustGetSession(input.sessionId);
    if (!session.conversationRef.startsWith('pending:')) {
      throw new Error('Only pending sessions can be restarted with an initial prompt.');
    }
    await this.releaseSessionInternal(session.id);
    return await this.bindConversationInternal({
      project: input.project,
      provider: input.provider,
      providerSettings: input.providerSettings,
      conversationRef: session.conversationRef,
      title: session.title ?? 'New conversation',
      kind: 'pending',
      initialPrompt: input.initialPrompt,
      codexProfile: session.codexProfile,
      claudeProfile: session.claudeProfile,
    }, randomUUID());
  }

  async requestModelProfile(sessionId: string, profile: ModelProfileKey): Promise<SessionModelProfileResponse> {
    const response = await this.runtimes.run(sessionId, 'requestModelProfile', async () => {
      const session = this.mustGetSession(sessionId);
      if (!session.shouldRestore || !['starting', 'bound'].includes(session.status)
        || !this.getCurrentRestorableSession(session)) {
        throw new SessionInputRejectedError('This session no longer owns the conversation.');
      }
      if (session.modelProfileRequest?.state === 'applying') {
        throw new SessionInputRejectedError('A model-profile switch is already in progress.');
      }
      const dependencies = this.recoveryDependencies;
      const project = await dependencies?.projectService.getProjectBySlug(session.projectSlug);
      if (!dependencies || !project) {
        throw new SessionInputRejectedError('The session project is unavailable.');
      }
      if (!dependencies.projectService.getMergedProviderSettings(project, session.provider).enabled) {
        throw new SessionInputRejectedError(`${session.provider === 'codex' ? 'Codex' : 'Claude'} is disabled for this project.`);
      }
      const visibleModel = activeModelProfile(session) === profile
        ? (await this.captureSessionScreen(session, false)).model
        : undefined;
      if (activeModelProfile(session) === profile
        && visibleModelMatchesProfile(session.provider, profile, visibleModel) !== false) {
        const updatedAt = nowIso();
        const unchanged = session.modelProfileRequest
          ? this.db.boundSessions.replaceModelProfileRequest(session.id, undefined, updatedAt)
          : session;
        if (!unchanged) throw new SessionInputRejectedError('Session not found.');
        if (session.modelProfileRequest) {
          this.appendEvent(unchanged, { type: 'status', text: `Cancelled the queued model change; ${session.provider} already uses ${profile}.`, timestamp: updatedAt });
          this.eventBus.emit({ type: 'session.updated', session: unchanged });
        }
        return { session: unchanged };
      }
      const requestedAt = nowIso();
      const request: ModelProfileRequest = {
        requestId: randomUUID(),
        profile,
        requestedAt,
        state: 'queued',
        deferredReason: session.isWorking ? 'turn_running' : undefined,
      };
      const updated = this.db.boundSessions.replaceModelProfileRequest(session.id, request, requestedAt);
      if (!updated) throw new SessionInputRejectedError('Session not found.');
      const target = selectedModelProfile(session.provider, profile);
      this.appendEvent(updated, {
        type: 'status',
        text: `Queued ${profile} ${session.provider} profile (${target.model}, ${target.reasoningEffort}).`,
        timestamp: requestedAt,
      });
      this.eventBus.emit({ type: 'session.updated', session: updated });
      return { session: updated };
    });
    this.scheduleModelProfileDrain(sessionId);
    return response;
  }

  async cancelModelProfileRequest(sessionId: string, requestId: string): Promise<SessionModelProfileResponse> {
    return await this.runtimes.run(sessionId, 'cancelModelProfileRequest', () => {
      const session = this.mustGetSession(sessionId);
      const request = session.modelProfileRequest;
      if (!request) return { session };
      if (request.requestId !== requestId) {
        throw new SessionInputRejectedError('The queued model request changed. Refresh and try again.');
      }
      if (request.state === 'applying') {
        throw new SessionInputRejectedError('The model-profile switch is already in progress.');
      }
      const updatedAt = nowIso();
      const updated = this.db.boundSessions.compareAndSetModelProfileRequest({
        id: session.id,
        requestId,
        expectedState: request.state,
        next: undefined,
        updatedAt,
      });
      if (!updated) {
        throw new SessionInputRejectedError('The queued model request changed. Refresh and try again.');
      }
      this.appendEvent(updated, { type: 'status', text: `Cancelled the queued ${request.profile} ${session.provider} profile.`, timestamp: updatedAt });
      this.eventBus.emit({ type: 'session.updated', session: updated });
      return { session: updated };
    });
  }

  private scheduleModelProfileDrain(sessionId: string): void {
    if (this.stopped || !this.db.isOpen()) return;
    if (this.scheduledModelProfileDrains.has(sessionId)) {
      this.requestedModelProfileRedrains.add(sessionId);
      return;
    }
    this.scheduledModelProfileDrains.add(sessionId);
    setTimeout(() => {
      if (this.stopped || !this.db.isOpen()) {
        this.scheduledModelProfileDrains.delete(sessionId);
        this.requestedModelProfileRedrains.delete(sessionId);
        return;
      }
      void this.runtimes.run(sessionId, 'drainModelProfileRequest', () => this.drainModelProfileRequestInternal(sessionId))
        .catch((error: unknown) => {
          if (!this.stopped && this.db.isOpen()) {
            this.logger?.warn({ err: error, sessionId }, 'Failed to drain queued model-profile request.');
          }
        })
        .finally(() => {
          this.scheduledModelProfileDrains.delete(sessionId);
          if (this.requestedModelProfileRedrains.delete(sessionId)) {
            this.scheduleModelProfileDrain(sessionId);
          }
        });
    }, 0).unref?.();
  }

  private deferModelProfileRequest(session: BoundSession, request: Extract<ModelProfileRequest, { state: 'queued' }>, reason: ModelProfileDeferredReason): void {
    if (request.deferredReason === reason) return;
    const updated = this.db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id,
      requestId: request.requestId,
      expectedState: 'queued',
      next: { ...request, deferredReason: reason },
      updatedAt: nowIso(),
    });
    if (updated) this.eventBus.emit({ type: 'session.updated', session: updated });
  }

  private failModelProfileRequest(
    session: BoundSession,
    request: ModelProfileRequest,
    message: string,
  ): BoundSession | undefined {
    const failedAt = nowIso();
    const failed = this.db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id,
      requestId: request.requestId,
      expectedState: request.state,
      next: {
        requestId: request.requestId,
        profile: request.profile,
        requestedAt: request.requestedAt,
        state: 'failed',
        failedAt,
        message,
      },
      updatedAt: failedAt,
    });
    if (!failed) return undefined;
    this.appendEvent(failed, { type: 'status', text: `Failed to switch ${session.provider} profile: ${message}`, timestamp: failedAt });
    this.eventBus.emit({ type: 'session.updated', session: failed });
    return failed;
  }

  private async reconcileApplyingModelProfileRequest(
    session: BoundSession,
    request: Extract<ModelProfileRequest, { state: 'applying' }>,
  ): Promise<void> {
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    const owner = liveness === 'alive'
      ? await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id').catch(() => undefined)
      : undefined;
    const marker = liveness === 'alive'
      ? await this.tmuxClient.getOption(session.tmuxSessionName, SESSION_MODEL_PROFILE_REQUEST_METADATA_KEY).catch(() => undefined)
      : undefined;
    const profile = liveness === 'alive'
      ? await this.tmuxClient.getOption(session.tmuxSessionName, SESSION_PROFILE_METADATA_KEYS[session.provider]).catch(() => undefined)
      : undefined;
    if (liveness === 'alive' && owner === session.id && marker === request.requestId && profile === request.profile) {
      const pid = await this.tmuxClient.getPanePid(session.tmuxSessionName);
      this.updateBoundSessionFields(session.id, { status: 'bound', isWorking: false, pid, updatedAt: nowIso() });
      const completed = this.db.boundSessions.completeModelProfileRequest({
        id: session.id,
        requestId: request.requestId,
        profile: request.profile,
        updatedAt: nowIso(),
      });
      if (completed) {
        const selected = selectedModelProfile(session.provider, request.profile);
        this.runtimeState(completed.id).liveSessionModel = selected.model;
        if (session.provider === 'codex') this.runtimeState(completed.id).codexProfile = request.profile;
        else this.runtimeState(completed.id).claudeProfile = request.profile;
        this.appendEvent(completed, { type: 'status', text: `${session.provider} session now uses ${request.profile} (${selected.model}, ${selected.reasoningEffort}).`, timestamp: completed.updatedAt });
        this.eventBus.emit({ type: 'session.updated', session: completed });
        this.watchSessionOutput(completed);
      }
      return;
    }
    const current = liveness === 'alive'
      ? this.updateBoundSessionFields(session.id, { status: 'bound', isWorking: false, updatedAt: nowIso() })
      : this.updateBoundSessionFields(session.id, { status: 'error', isWorking: false, updatedAt: nowIso() });
    this.failModelProfileRequest(current, request, 'The server stopped during the model switch and could not prove its outcome. Review the session and select a profile again.');
  }

  private async drainModelProfileRequestInternal(sessionId: string): Promise<void> {
    let session = this.db.boundSessions.getById(sessionId);
    let request = session?.modelProfileRequest;
    if (!session || !request || request.state === 'failed') return;
    if (request.state === 'applying') {
      await this.reconcileApplyingModelProfileRequest(session, request);
      return;
    }
    if (!session.shouldRestore || !['starting', 'bound'].includes(session.status)
      || !this.getCurrentRestorableSession(session)) {
      this.db.boundSessions.replaceModelProfileRequest(session.id, undefined, nowIso());
      return;
    }
    const dependencies = this.recoveryDependencies;
    const project = await dependencies?.projectService.getProjectBySlug(session.projectSlug);
    if (!dependencies || !project) {
      this.failModelProfileRequest(session, request, 'The session project is unavailable.');
      return;
    }
    const provider = dependencies.providerRegistry.get(session.provider);
    const providerSettings = dependencies.projectService.getMergedProviderSettings(project, session.provider);
    if (!providerSettings.enabled) {
      this.failModelProfileRequest(session, request, `${session.provider} is disabled or unavailable for this project.`);
      return;
    }
    session = await this.tryResolvePendingResumeSession(session, project, provider, providerSettings);
    session = this.mustGetSession(session.id);
    request = session.modelProfileRequest;
    if (!request || request.state !== 'queued') return;
    if (session.conversationRef.startsWith('pending:')) {
      if (this.hasRecordedPendingUserInput(session)) {
        this.deferModelProfileRequest(session, request, 'awaiting_native_conversation');
        return;
      }
      if (session.provider === 'codex') {
        const startedAt = nowIso();
        const applying: Extract<ModelProfileRequest, { state: 'applying' }> = {
          ...request,
          state: 'applying',
          startedAt,
          previousProfile: activeModelProfile(session),
          resumeConversationRef: session.conversationRef,
        };
        const transitioned = this.db.boundSessions.compareAndSetModelProfileRequest({
          id: session.id,
          requestId: request.requestId,
          expectedState: 'queued',
          next: applying,
          updatedAt: startedAt,
        });
        if (!transitioned) return;
        const completed = this.db.boundSessions.completeModelProfileRequest({ id: session.id, requestId: request.requestId, profile: request.profile, updatedAt: nowIso() });
        if (!completed) return;
        this.runtimeState(completed.id).codexProfile = request.profile;
        const selected = selectedModelProfile(session.provider, request.profile);
        this.appendEvent(completed, { type: 'status', text: `Selected ${request.profile} profile for the first Codex turn (${selected.model}, ${selected.reasoningEffort}).`, timestamp: completed.updatedAt });
        this.eventBus.emit({ type: 'session.updated', session: completed });
        return;
      }
    }
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness === 'unknown') {
      this.deferModelProfileRequest(session, request, 'cannot_verify_idle');
      return;
    }
    if (liveness === 'dead') {
      const failedSession = this.updateBoundSessionFields(session.id, { status: 'error', isWorking: false, updatedAt: nowIso() });
      this.failModelProfileRequest(failedSession, request, 'The provider session is unavailable. Resume it manually before selecting a profile.');
      return;
    }
    const owner = await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id').catch(() => undefined);
    if (owner !== session.id) {
      this.failModelProfileRequest(session, request, 'Session ownership could not be verified.');
      return;
    }
    const screen = await this.captureSessionScreen(session, false);
    await this.runRecovery.refresh(session.id);
    this.syncSessionWorkingState(this.mustGetSession(session.id), {
      screenShowsWorking: sessionScreenShowsWorking(screen), capturedAt: screen.capturedAt,
    });
    session = this.mustGetSession(session.id);
    request = session.modelProfileRequest;
    if (!request || request.state !== 'queued') return;
    const providerWorking = this.providerTurnIsWorking(session.id);
    if (session.isWorking || (providerWorking === undefined && sessionScreenShowsWorking(screen))) {
      this.deferModelProfileRequest(session, request, 'turn_running');
      return;
    }
    if (screen.inputText.trim()) {
      this.deferModelProfileRequest(session, request, 'unsent_input');
      return;
    }
    if (screenShowsInteractiveSelectionHint(screen)) {
      this.deferModelProfileRequest(session, request, 'interactive_input');
      return;
    }
    if (screenShowsQueuedMessageHint(screen)) {
      this.deferModelProfileRequest(session, request, 'provider_message_queued');
      return;
    }
    if (screenIsStartingUp(screen) && screen.contextPercent === undefined
      && (session.provider === 'codex' ? !screen.model : !screenLooksReadyForLiteralPrompt(screen))) {
      this.deferModelProfileRequest(session, request, 'starting');
      return;
    }
    if (screen.contextPercent === undefined
      && (session.provider === 'codex' ? !screen.model : !screenLooksReadyForLiteralPrompt(screen))
      && providerWorking !== false) {
      this.deferModelProfileRequest(session, request, 'cannot_verify_idle');
      return;
    }
    const resumeConversationRef = session.resumeConversationRef ?? session.conversationRef;
    const startedAt = nowIso();
    const applying: Extract<ModelProfileRequest, { state: 'applying' }> = {
      ...request,
      state: 'applying',
      startedAt,
      previousProfile: activeModelProfile(session)
        && visibleModelMatchesProfile(session.provider, activeModelProfile(session)!, screen.model) !== false
        ? activeModelProfile(session)
        : undefined,
      resumeConversationRef,
    };
    const transitioned = this.db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id,
      requestId: request.requestId,
      expectedState: 'queued',
      next: applying,
      updatedAt: startedAt,
    });
    if (!transitioned) return;
    this.eventBus.emit({ type: 'session.updated', session: transitioned });
    await this.applyModelProfileRequest(transitioned, applying, project, provider, providerSettings);
  }

  private async applyModelProfileRequest(
    liveSession: BoundSession,
    request: Extract<ModelProfileRequest, { state: 'applying' }>,
    project: ActiveProject,
    provider: ProviderAdapter,
    providerSettings: MergedProviderSettings,
  ): Promise<void> {
    const selected = selectedModelProfile(liveSession.provider, request.profile);
    const previousProfile = request.previousProfile;
    const starting = this.updateBoundSessionFields(liveSession.id, {
      status: 'starting',
      updatedAt: nowIso(),
      isWorking: false,
    });
    this.eventBus.emit({ type: 'session.updated', session: starting });
    this.appendEvent(starting, {
      type: 'status',
      text: `Switching this ${liveSession.provider} session to ${request.profile} (${selected.model}, ${selected.reasoningEffort}).`,
      timestamp: starting.updatedAt,
    });
    let tmuxCreated = false;
    let originalStopped = false;
    let rebound: BoundSession;
    try {
      const owner = await this.tmuxClient.getOption(starting.tmuxSessionName, '@agent_console_session_id');
      if (owner !== starting.id) throw new Error('Session ownership changed before the model switch.');
      await this.tmuxClient.closePanePipe(starting.tmuxSessionName).catch(() => undefined);
      const ownerBeforeKill = await this.tmuxClient.getOption(starting.tmuxSessionName, '@agent_console_session_id');
      if (ownerBeforeKill !== starting.id) throw new Error('Session ownership changed before the model switch.');
      await this.tmuxClient.killSession(starting.tmuxSessionName);
      originalStopped = true;
      const resumeRef = request.resumeConversationRef.startsWith('pending:') ? null : request.resumeConversationRef;
      const launch = provider.getLaunchCommand(project, resumeRef, providerSettings, launchModelProfile(starting.provider, request.profile));
      await this.tmuxClient.newDetachedSession(starting.tmuxSessionName, launch.cwd, commandToShell(launch.argv, launch.env));
      tmuxCreated = true;
      await this.tmuxClient.pipePaneToFile(starting.tmuxSessionName, starting.rawLogPath!);
      await this.configureTmuxSessionOptions(starting.tmuxSessionName, {
        sessionId: starting.id,
        conversationRef: starting.conversationRef,
        provider: starting.provider,
      });
      await this.tmuxClient.setOption(starting.tmuxSessionName, SESSION_PROFILE_METADATA_KEYS[starting.provider], request.profile);
      const pid = await this.tmuxClient.getPanePid(starting.tmuxSessionName);
      await this.verifyStartupSurvived({ ...starting, pid });
      await this.tmuxClient.setOption(starting.tmuxSessionName, SESSION_MODEL_PROFILE_REQUEST_METADATA_KEY, request.requestId);
      this.updateBoundSessionFields(starting.id, { status: 'bound', updatedAt: nowIso(), pid });
      const completed = this.db.boundSessions.completeModelProfileRequest({
        id: starting.id,
        requestId: request.requestId,
        profile: request.profile,
        updatedAt: nowIso(),
      });
      if (!completed) throw new Error('The queued model request changed during startup.');
      rebound = completed;
    } catch (error) {
      if (tmuxCreated) await this.cleanupCreatedTmuxSession(starting);
      let recovered = false;
      let shouldRollback = originalStopped;
      if (!originalStopped) {
        const originalLiveness = await checkTmuxLiveness(this.tmuxClient, starting.tmuxSessionName);
        if (originalLiveness === 'alive') {
          await this.tmuxClient.pipePaneToFile(starting.tmuxSessionName, starting.rawLogPath!).catch(() => undefined);
          recovered = true;
        } else if (originalLiveness === 'dead') {
          shouldRollback = true;
        }
      }
      if (shouldRollback) {
        let rollbackCreated = false;
        try {
          const resumeRef = request.resumeConversationRef.startsWith('pending:') ? null : request.resumeConversationRef;
          const rollbackLaunch = provider.getLaunchCommand(project, resumeRef, providerSettings, launchModelProfile(starting.provider, previousProfile));
          await this.tmuxClient.newDetachedSession(starting.tmuxSessionName, rollbackLaunch.cwd, commandToShell(rollbackLaunch.argv, rollbackLaunch.env));
          rollbackCreated = true;
          await this.tmuxClient.pipePaneToFile(starting.tmuxSessionName, starting.rawLogPath!);
          await this.configureTmuxSessionOptions(starting.tmuxSessionName, { sessionId: starting.id, conversationRef: starting.conversationRef, provider: starting.provider });
          if (previousProfile) await this.tmuxClient.setOption(starting.tmuxSessionName, SESSION_PROFILE_METADATA_KEYS[starting.provider], previousProfile);
          const rollbackPid = await this.tmuxClient.getPanePid(starting.tmuxSessionName);
          await this.verifyStartupSurvived({ ...starting, pid: rollbackPid });
          this.updateBoundSessionFields(starting.id, {
            status: 'bound', ...launchModelProfile(starting.provider, previousProfile), updatedAt: nowIso(), pid: rollbackPid,
          });
          recovered = true;
        } catch (rollbackError) {
          if (rollbackCreated) await this.cleanupCreatedTmuxSession(starting);
          this.logger?.warn({ err: rollbackError, sessionId: starting.id }, 'Failed to restore the previous session after a model-profile switch error.');
        }
      }
      const alive = recovered
        && await checkTmuxLiveness(this.tmuxClient, starting.tmuxSessionName) === 'alive';
      const current = this.updateBoundSessionFields(starting.id, {
        status: alive ? 'bound' : 'error',
        shouldRestore: true,
        updatedAt: nowIso(),
        isWorking: false,
        ...launchModelProfile(starting.provider, previousProfile),
      });
      const failed = this.failModelProfileRequest(current, request, error instanceof Error ? error.message : 'Unknown error.');
      if (failed && alive) {
        this.watchSessionOutput(failed);
        await this.emitScreenUpdate(failed);
      }
      return;
    }
    this.runtimeState(rebound.id).liveSessionModel = selected.model;
    if (starting.provider === 'codex') this.runtimeState(rebound.id).codexProfile = request.profile;
    else this.runtimeState(rebound.id).claudeProfile = request.profile;
    try {
      this.appendEvent(rebound, { type: 'status', text: `${starting.provider} session now uses ${request.profile} (${selected.model}, ${selected.reasoningEffort}).`, timestamp: rebound.updatedAt });
      this.eventBus.emit({ type: 'session.updated', session: rebound });
      this.watchSessionOutput(rebound);
      await this.emitScreenUpdate(rebound);
    } catch (error) {
      this.logger?.warn({ err: error, sessionId: rebound.id }, 'Model-profile switch committed, but publishing its updated state failed.');
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.runRecovery.cancel(sessionId);
    await this.runtimes.run(sessionId, 'releaseSession', () => this.releaseSessionInternal(sessionId));
  }

  private async releaseSessionInternal(sessionId: string): Promise<void> {
    let session = this.mustGetSession(sessionId);
    if (session.modelProfileRequest) {
      session = this.db.boundSessions.replaceModelProfileRequest(session.id, undefined, nowIso()) ?? session;
    }
    const releasing = {
      ...session,
      status: 'releasing' as const,
      shouldRestore: false,
      updatedAt: nowIso(),
      isWorking: false,
    };
    this.db.boundSessions.upsert(releasing);
    this.eventBus.emit({ type: 'session.updated', session: releasing });
    this.appendEvent(releasing, { type: 'status', text: 'Releasing session.', timestamp: nowIso() });

    const initialLiveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (initialLiveness === 'unknown') {
      const failed = { ...releasing, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, { type: 'status', text: 'Failed to verify tmux session before release.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw new Error(`Failed to verify tmux session ${session.tmuxSessionName}`);
    }

    if (initialLiveness === 'alive') {
      try {
        await this.tmuxClient.interrupt(session.tmuxSessionName);
        await sleep(300);
      } catch (interruptError) {
        void interruptError;
      }

      try {
        await this.tmuxClient.killSession(session.tmuxSessionName);
      } catch (killError) {
        void killError;
      }
    }

    const finalLiveness = initialLiveness === 'dead'
      ? 'dead'
      : await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (finalLiveness !== 'dead') {
      const failed = { ...releasing, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, {
        type: 'status',
        text: finalLiveness === 'unknown'
          ? 'Failed to verify tmux session release.'
          : 'Failed to release tmux session cleanly.',
        timestamp: nowIso(),
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw new Error(`Failed to release tmux session ${session.tmuxSessionName}`);
    }

    this.stopWatching(session.id);
    this.runtimes.clearEphemeral(session.id);
    const ended = { ...releasing, status: 'ended' as const, updatedAt: nowIso(), isWorking: false };
    this.db.boundSessions.upsert(ended);
    if (session.conversationRef.startsWith('pending:')) {
      const pending = this.db.pendingConversations.get(session.conversationRef);
      if (pending) {
        this.db.pendingConversations.put({
          ...pending,
          isBound: false,
          boundSessionId: undefined,
          updatedAt: nowIso(),
        });
      }
    }
    this.eventBus.emit({ type: 'session.released', sessionId: session.id, conversationRef: session.conversationRef, projectSlug: session.projectSlug, provider: session.provider, timestamp: nowIso() });
    this.eventBus.emit({ type: 'session.updated', session: ended });
    this.cleanupSessionRuntimeDir(session.id);
  }

  getSessionById(sessionId: string): BoundSession | undefined {
    return this.db.boundSessions.getById(sessionId);
  }

  getSessionByConversation(projectSlug: string, provider: ProviderId, conversationRef: string): BoundSession | undefined {
    return this.db.boundSessions.getRestorableByConversation(projectSlug, provider, conversationRef);
  }

  async allowsLiteralSelectionKeystroke(sessionId: string, text: string): Promise<boolean> {
    const session = this.db.boundSessions.getById(sessionId);
    if (!session) {
      return false;
    }
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness !== 'alive') {
      return false;
    }
    const snapshot = await this.tmuxClient.capturePane(session.tmuxSessionName).catch(() => '');
    if (!snapshot) {
      return false;
    }
    const screen = this.decorateScreenForSession(session, parseSessionScreenSnapshot(snapshot, nowIso()));
    return screenAllowsLiteralSelectionTokenWithoutInput(screen, text);
  }

  async ensureSession(sessionId: string): Promise<BoundSession | undefined> {
    return await this.runtimes.run(sessionId, 'ensureSession', () => this.ensureSessionInternal(sessionId));
  }

  private async ensureSessionInternal(sessionId: string): Promise<BoundSession | undefined> {
    const session = this.mustGetSession(sessionId);
    return await this.refreshSessionState(session);
  }

  async getSessionScreen(
    sessionId: string,
    options: { startLine?: number } = {},
  ): Promise<{ session: BoundSession; screen: SessionScreen } | undefined> {
    const session = this.mustGetSession(sessionId);
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    const liveSession = liveness === 'dead'
      ? await this.runtimes.run(sessionId, 'restoreSessionForScreen', async () => {
          const current = this.mustGetSession(sessionId);
          if (current.status === 'error') {
            return undefined;
          }
          return await this.refreshSessionState(current, { restoreMissing: true });
        })
      : await this.refreshSessionState(session, { restoreMissing: false });
    if (!liveSession) {
      return undefined;
    }
    const snapshot = await this.tmuxClient.capturePane(liveSession.tmuxSessionName, options.startLine).catch(() => '');
    const screen = this.decorateScreenForSession(liveSession, parseSessionScreenSnapshot(snapshot, nowIso()));
    this.syncSessionWorkingState(this.mustGetSession(liveSession.id), {
      screenShowsWorking: sessionScreenShowsWorking(screen), capturedAt: screen.capturedAt,
    });
    return {
      session: this.mustGetSession(liveSession.id),
      screen,
    };
  }

  private buildTmuxSessionName(projectSlug: string, provider: ProviderId, conversationRef: string): string {
    const digest = createHash('sha1').update(`${projectSlug}:${provider}:${conversationRef}`).digest('hex').slice(0, 10);
    return `ac-${provider}-${projectSlug}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) + `-${digest}`;
  }

  private async configureTmuxSessionOptions(
    sessionName: string,
    options: { sessionId: string; conversationRef: string; provider: ProviderId },
  ): Promise<void> {
    await this.tmuxClient.setOption(sessionName, '@agent_console_session_id', options.sessionId);
    await this.tmuxClient.setOption(sessionName, '@agent_console_conversation_ref', options.conversationRef);
    await this.tmuxClient.setOption(sessionName, '@agent_console_provider', options.provider);
  }

  private mustGetSession(sessionId: string): BoundSession {
    const session = this.db.boundSessions.getById(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  private async refreshSessionState(
    staleSession: BoundSession,
    options: { restoreMissing?: boolean } = {},
  ): Promise<BoundSession | undefined> {
    let session = this.db.boundSessions.getById(staleSession.id);
    if (!session) {
      return undefined;
    }
    const restoreMissing = options.restoreMissing ?? true;
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    session = this.db.boundSessions.getById(staleSession.id);
    if (!session) {
      return undefined;
    }
    if (liveness === 'unknown') {
      return session;
    }
    if (liveness === 'dead') {
      this.stopWatching(session.id);
      this.runtimes.clearEphemeral(session.id);
      if (!restoreMissing && session.conversationRef.startsWith('pending:')) {
        if (this.hasRecordedPendingUserInput(session)) {
          this.markPendingSessionNotLive(session);
        } else {
          const ended = clearPendingConversationRestoreBinding({ db: this.db, session });
          this.eventBus.emit({ type: 'session.updated', session: ended });
        }
        return undefined;
      }
      if (restoreMissing && session.shouldRestore && session.status !== 'releasing') {
        return await this.restoreSession(session);
      }
      if (session.shouldRestore && session.status !== 'releasing') {
        return undefined;
      }
      const terminalStatus = session.status === 'releasing' ? 'ended' : 'error';
      const ended: BoundSession = {
        ...session,
        status: terminalStatus,
        updatedAt: nowIso(),
        isWorking: false,
      };
      this.db.boundSessions.upsert(ended);
      if (terminalStatus === 'error') {
        this.appendEvent(ended, {
          type: 'status',
          text: 'Session exited unexpectedly.',
          timestamp: nowIso(),
        });
      }
      this.eventBus.emit({ type: 'session.updated', session: ended });
      if (terminalStatus === 'ended' && !ended.shouldRestore) {
        this.cleanupSessionRuntimeDir(ended.id);
      }
      return undefined;
    }

    if (!this.getCurrentRestorableSession(session)) {
      return undefined;
    }

    const logReadySession = this.ensureSessionLogPaths(session);
    const nextStatus = logReadySession.status === 'starting' || logReadySession.status === 'error' ? 'bound' : logReadySession.status;
    const refreshed: BoundSession = nextStatus === logReadySession.status
      ? logReadySession
      : {
          ...logReadySession,
          status: nextStatus,
          updatedAt: nowIso(),
        };
    if (
      refreshed !== logReadySession
      || logReadySession.rawLogPath !== session.rawLogPath
      || logReadySession.eventLogPath !== session.eventLogPath
    ) {
      this.db.boundSessions.upsert(refreshed);
      this.eventBus.emit({ type: 'session.updated', session: refreshed });
    }
    await this.tryEnsureRawLogPipe(refreshed);
    this.watchSessionOutput(refreshed);
    if (!this.runtimeState(refreshed.id).lastScreenHash) {
      await this.emitScreenUpdate(refreshed);
    }
    return refreshed;
  }

  private appendEvent(session: BoundSession, event: SessionEventLogEntry): AppendedSessionEvent | undefined {
    if (!session.eventLogPath) return undefined;
    const offset = fs.existsSync(session.eventLogPath) ? fs.statSync(session.eventLogPath).size : 0;
    const messageId = liveMessageId(session.id, offset);
    fs.appendFileSync(session.eventLogPath, `${JSON.stringify(event)}\n`);
    if (event.type === 'user-input') {
      this.eventBus.emit({
        type: 'session.user-input',
        sessionId: session.id,
        projectSlug: session.projectSlug,
        provider: session.provider,
        conversationRef: session.conversationRef,
        messageId,
        text: event.text,
        timestamp: event.timestamp,
      });
    }
    if (event.type === 'raw-output') {
      this.eventBus.emit({
        type: 'session.raw-output',
        sessionId: session.id,
        projectSlug: session.projectSlug,
        provider: session.provider,
        conversationRef: session.conversationRef,
        chunk: event.text,
        timestamp: event.timestamp,
      });
    }
    return { event, messageId, offset };
  }

  private appendDebugTrace(session: BoundSession, input: {
    action: string;
    text?: string;
    keys?: string[];
    before: SessionScreen;
    after: SessionScreen;
  }): void {
    const debugLogPath = session.rawLogPath ? path.join(path.dirname(session.rawLogPath), 'debug.log') : undefined;
    if (!debugLogPath) {
      return;
    }
    const lines = [
      `[${nowIso()}] ${input.action}`,
      `  text=${JSON.stringify(input.text ?? '')} keys=${JSON.stringify(input.keys ?? [])}`,
      `  before.input=${JSON.stringify(input.before.inputText)}`,
      `  before.status=${JSON.stringify(input.before.status)}`,
      `  before.tail=${JSON.stringify(input.before.content.split('\n').slice(-4))}`,
      `  after.input=${JSON.stringify(input.after.inputText)}`,
      `  after.status=${JSON.stringify(input.after.status)}`,
      `  after.tail=${JSON.stringify(input.after.content.split('\n').slice(-4))}`,
      '',
    ].join('\n');
    fs.appendFileSync(debugLogPath, lines);
  }

  private watchSessionOutput(session: BoundSession): void {
    if (!this.shouldWatchSession(session)) {
      return;
    }

    this.watchSessionTranscript(session);

    if (session.rawLogPath && !this.outputWatchers.has(session.id)) {
      const initialOffset = session.eventLogPath && fs.existsSync(session.eventLogPath) && fs.statSync(session.eventLogPath).size > 0 && fs.existsSync(session.rawLogPath)
        ? fs.statSync(session.rawLogPath).size
        : 0;
      this.outputWatchers.watch({
        sessionId: session.id,
        rawLogPath: session.rawLogPath,
        initialOffset,
        onChunk: (chunk) => this.flushPendingChunk(session.id, chunk),
      });
    }
  }

  private watchSessionTranscript(session: BoundSession): void {
    if (session.conversationRef.startsWith('pending:')) {
      this.transcriptWatchers.stop(session.id);
      return;
    }

    const transcriptPath = this.db.conversationIndex.get(
      session.projectSlug,
      session.provider,
      session.conversationRef,
    )?.transcriptPath;
    if (!transcriptPath) {
      this.transcriptWatchers.stop(session.id);
      return;
    }

    const provider = this.recoveryDependencies?.providerRegistry.get(session.provider);
    if (provider?.createRunMonitor) this.runRecovery.watch(session.id, transcriptPath, () => provider.createRunMonitor!());

    this.transcriptWatchers.watch({
      sessionId: session.id,
      transcriptPath,
      onChange: () => this.emitTranscriptUpdated(session.id),
    });
  }

  private emitTranscriptUpdated(sessionId: string): void {
    this.runRecovery.changed(sessionId);
    const session = this.db.boundSessions.getById(sessionId);
    if (!session || session.status === 'ended') {
      this.transcriptWatchers.stop(sessionId);
      return;
    }
    this.eventBus.emit({
      type: 'session.transcript-updated',
      sessionId: session.id,
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      timestamp: nowIso(),
    });
  }

  private stopWatching(sessionId: string): void {
    this.runRecovery.stopWatching(sessionId);
    this.outputWatchers.stop(sessionId, { flush: true }, (chunk) => this.flushPendingChunk(sessionId, chunk));
    this.transcriptWatchers.stop(sessionId);
    this.clearWorkingExpiry(sessionId);
    this.clearRawOutputScreenUpdate(sessionId);
  }

  private clearWorkingExpiry(sessionId: string): void {
    const state = this.runtimeState(sessionId);
    const timer = state.workingIdleTimer;
    if (timer) {
      clearTimeout(timer);
      state.workingIdleTimer = undefined;
    }
  }

  private clearRawOutputScreenUpdate(sessionId: string): void {
    const state = this.runtimeState(sessionId);
    const timer = state.rawOutputScreenUpdateTimer;
    if (timer) {
      clearTimeout(timer);
      state.rawOutputScreenUpdateTimer = undefined;
    }
  }

  private scheduleRawOutputScreenUpdate(session: BoundSession): void {
    const state = this.runtimeState(session.id);
    if (state.rawOutputScreenUpdateTimer) {
      return;
    }

    const timer = setTimeout(() => {
      state.rawOutputScreenUpdateTimer = undefined;
      if (this.stopped || !this.db.isOpen()) {
        return;
      }
      void this.emitScreenUpdate(session).catch((error: unknown) => {
        if (this.stopped || !this.db.isOpen()) {
          return;
        }
        this.logger?.warn({ err: error }, 'Failed to publish deferred session screen update.');
      });
    }, RAW_OUTPUT_SCREEN_UPDATE_THROTTLE_MS);
    state.rawOutputScreenUpdateTimer = timer;
  }

  private scheduleWorkingExpiry(sessionId: string, heartbeatAt: string): void {
    const heartbeatMs = Date.parse(heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      this.clearWorkingExpiry(sessionId);
      return;
    }

    const state = this.runtimeState(sessionId);
    const existing = state.workingIdleTimer;
    if (existing) {
      clearTimeout(existing);
    }
    const delayMs = Math.max(0, heartbeatMs + SESSION_COMPLETION_IDLE_MS - Date.now()) + 100;
    const timer = setTimeout(() => {
      state.workingIdleTimer = undefined;
      void this.handleWorkingIdleExpiry(sessionId, heartbeatAt);
    }, delayMs);
    state.workingIdleTimer = timer;
  }

  private async handleWorkingIdleExpiry(sessionId: string, expectedHeartbeatAt: string): Promise<void> {
    try {
      const session = this.mustGetSession(sessionId);
      const decision = nextIdleExpiryDecision(session, {
        expectedHeartbeatAt,
        now: nowIso(),
        idleMs: SESSION_COMPLETION_IDLE_MS,
        turnIsWorking: this.providerTurnIsWorking(sessionId),
      });
      if (decision.action === 'reschedule') {
        this.scheduleWorkingExpiry(sessionId, decision.heartbeatAt);
        return;
      }
      this.clearWorkingExpiry(sessionId);
      if (decision.action === 'update') {
        this.db.boundSessions.upsert(decision.updatedSession);
        this.eventBus.emit({ type: 'session.updated', session: decision.updatedSession });
      }
    } catch {
      this.clearWorkingExpiry(sessionId);
    }
  }

  private flushPendingChunk(sessionId: string, chunk: string): void {
    if (!chunk.trim()) return;
    const now = nowIso();
    try {
      const session = this.mustGetSession(sessionId);
      const outputLines = normalizeRawOutputLines(chunk, readLastUserInput(session.eventLogPath));
      const hasMeaningfulOutput = outputLines.length > 0;
      const shouldTrackOutput = hasMeaningfulOutput && this.shouldTrackRawOutputForRecency(session);
      const updated = shouldTrackOutput
        ? {
            ...session,
            updatedAt: now,
            lastActivityAt: now,
            lastOutputAt: now,
            isWorking: this.providerTurnIsWorking(sessionId) ?? true,
          }
        : session;
      if (shouldTrackOutput) {
        this.db.boundSessions.upsert(updated);
        this.scheduleWorkingExpiry(sessionId, now);
        this.appendEvent(updated, { type: 'raw-output', text: chunk, timestamp: now });
      }
      this.scheduleRawOutputScreenUpdate(updated);
    } catch (updateError) {
      void updateError;
    }
  }

  private shouldTrackRawOutputForRecency(session: BoundSession): boolean {
    if (session.runFailure && session.runFailure.status !== 'retrying') return false;
    if (session.isWorking) {
      return true;
    }

    const lastActivityMs = Date.parse(session.lastActivityAt ?? '');
    if (!Number.isFinite(lastActivityMs)) {
      return false;
    }

    const lastOutputMs = Date.parse(session.lastOutputAt ?? session.lastCompletedAt ?? '');
    if (!Number.isFinite(lastOutputMs)) {
      return true;
    }

    return lastActivityMs > lastOutputMs;
  }

  private publishScreenUpdate(
    session: BoundSession,
    screen: SessionScreen,
  ): boolean {
    const nextHash = hashScreen(screen);
    const state = this.runtimeState(session.id);
    if (state.lastScreenHash === nextHash) {
      return false;
    }

    state.lastScreenHash = nextHash;
    this.syncSessionWorkingState(this.mustGetSession(session.id), {
      screenShowsWorking: sessionScreenShowsWorking(screen), capturedAt: screen.capturedAt,
    });
    const currentSession = this.mustGetSession(session.id);
    this.eventBus.emit({
      type: 'session.screen-updated',
      sessionId: currentSession.id,
      projectSlug: currentSession.projectSlug,
      provider: currentSession.provider,
      conversationRef: currentSession.conversationRef,
      screen,
      timestamp: screen.capturedAt,
    });
    return true;
  }

  private async captureSessionScreen(session: BoundSession, decorate = true): Promise<SessionScreen> {
    const snapshot = await this.tmuxClient.capturePane(session.tmuxSessionName).catch(() => '');
    const screen = parseSessionScreenSnapshot(snapshot, nowIso());
    return decorate ? this.decorateScreenForSession(session, screen) : screen;
  }

  private async waitForScreenChange(
    session: BoundSession,
    previousHash: string | undefined,
    timeoutMs: number,
  ): Promise<SessionScreen | undefined> {
    const deadline = previousHash ? Date.now() + timeoutMs : Date.now();

    while (true) {
      const screen = await this.captureSessionScreen(session);
      if (previousHash !== hashScreen(screen)) {
        return screen;
      }
      if (!previousHash || Date.now() >= deadline) {
        return undefined;
      }
      await sleep(35);
    }
  }

  private async waitForInputTextChange(
    session: BoundSession,
    previousHash: string | undefined,
    previousScreen: SessionScreen,
    timeoutMs: number,
  ): Promise<SessionScreen | undefined> {
    const deadline = previousHash ? Date.now() + timeoutMs : Date.now();
    let latestChangedScreen: SessionScreen | undefined;
    let latestHash = previousHash;

    while (true) {
      const screen = await this.captureSessionScreen(session);
      const nextHash = hashScreen(screen);
      if (nextHash !== latestHash) {
        latestChangedScreen = screen;
        latestHash = nextHash;
        if (screenInputChanged(previousScreen, screen)) {
          return screen;
        }
      }
      if (!previousHash || Date.now() >= deadline) {
        return latestChangedScreen;
      }
      await sleep(35);
    }
  }

  private async waitForScreenMatch(
    session: BoundSession,
    previousHash: string | undefined,
    timeoutMs: number,
    matcher: (screen: SessionScreen) => boolean,
  ): Promise<SessionScreen | undefined> {
    const deadline = previousHash ? Date.now() + timeoutMs : Date.now();
    let latestChangedScreen: SessionScreen | undefined;
    let latestHash = previousHash;

    while (true) {
      const screen = await this.captureSessionScreen(session);
      const nextHash = hashScreen(screen);
      if (nextHash !== latestHash) {
        latestChangedScreen = screen;
        latestHash = nextHash;
        if (matcher(screen)) {
          return screen;
        }
      }
      if (!previousHash || Date.now() >= deadline) {
        return latestChangedScreen;
      }
      await sleep(35);
    }
  }

  private async prepareScreenForCombinedTextSubmit(
    session: BoundSession,
    initialScreen: SessionScreen,
  ): Promise<SessionScreen> {
    let screen = initialScreen;

    if (screenIsStartingUp(screen)) {
      const settledScreen = await this.waitForScreenMatch(
        session,
        hashScreen(screen),
        TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS,
        (candidate) => !screenIsStartingUp(candidate),
      );
      if (settledScreen) {
        screen = settledScreen;
        this.publishScreenUpdate(session, screen);
      }
    }

    if (session.provider === 'codex' && screenShowsQueuedMessageHint(screen)) {
      await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Tab']);
      const composerScreen = await this.waitForScreenChange(
        session,
        hashScreen(screen),
        QUEUED_MESSAGE_COMPOSER_WAIT_MS,
      );
      if (composerScreen) {
        screen = composerScreen;
        this.publishScreenUpdate(session, screen);
      }
    }

    if (session.provider === 'claude' && screenShowsClaudeResumeSessionChoice(screen)) {
      await this.sendLiteralTextToSession(session.tmuxSessionName, '1');
      await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Enter']);
      const afterChoiceScreen = await this.waitForScreenMatch(
        session,
        hashScreen(screen),
        CLAUDE_RESUME_READY_WAIT_MS,
        (candidate) => !screenShowsClaudeResumeSessionChoice(candidate),
      );
      if (afterChoiceScreen) {
        screen = afterChoiceScreen;
        this.publishScreenUpdate(session, screen);
      }

      if (!screenLooksReadyForLiteralPrompt(screen)) {
        const readyScreen = await this.waitForScreenMatch(
          session,
          hashScreen(screen),
          CLAUDE_RESUME_READY_WAIT_MS,
          screenLooksReadyForLiteralPrompt,
        );
        if (readyScreen) {
          screen = readyScreen;
          this.publishScreenUpdate(session, screen);
        }
      }
    }

    return screen;
  }

  private async emitScreenUpdate(
    session: BoundSession,
    options: {
      waitForChange?: boolean;
      previousHashOverride?: string;
    } = {},
  ): Promise<void> {
    const previousHash = options.previousHashOverride ?? this.runtimeState(session.id).lastScreenHash;
    const screen = await this.waitForScreenChange(
      session,
      previousHash,
      options.waitForChange ? 220 : 0,
    );
    if (screen) {
      this.publishScreenUpdate(session, screen);
    }
  }

  private syncSessionWorkingState(
    session: BoundSession,
    screen: { screenShowsWorking: boolean; capturedAt: string },
  ): void {
    const next = nextScreenWorkingState(session, {
      screenShowsWorking: screen.screenShowsWorking,
      capturedAt: screen.capturedAt,
      idleMs: SESSION_COMPLETION_IDLE_MS,
      turnIsWorking: this.providerTurnIsWorking(session.id),
    });

    if (next.expiryHeartbeatAt) {
      this.scheduleWorkingExpiry(session.id, next.expiryHeartbeatAt);
    }
    if (next.clearExpiry) {
      this.clearWorkingExpiry(session.id);
    }

    if (!next.updatedSession) {
      return;
    }
    this.db.boundSessions.upsert(next.updatedSession);
    this.eventBus.emit({ type: 'session.updated', session: next.updatedSession });
  }

  private async waitForStartupOutput(session: BoundSession): Promise<void> {
    if (!session.rawLogPath) return;

    const deadline = Date.now() + 5000;
    let sawOutput = false;
    let lastSize = 0;
    const startedAt = Date.now();
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      try {
        const size = fs.statSync(session.rawLogPath).size;
        if (size !== lastSize) {
          lastSize = size;
          stableSince = Date.now();
          sawOutput ||= size > 0;
        } else if (sawOutput && Date.now() - stableSince >= 350) {
          return;
        } else if (!sawOutput && Date.now() - startedAt >= 500) {
          return;
        }
      } catch {
        return;
      }
      await sleep(100);
    }
  }

  private async verifyStartupSurvived(session: BoundSession): Promise<void> {
    await this.waitForStartupOutput(session);
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness !== 'alive') {
      throw new Error(liveness === 'dead'
        ? 'Provider session exited during startup.'
        : 'Could not verify provider session startup.');
    }
  }

  private decorateScreenForSession(session: BoundSession, screen: SessionScreen): SessionScreen {
    const model = screen.model ?? this.getStoredSessionModel(session) ?? this.recoverSessionModelFromLogs(session);
    if (model && model !== screen.model) {
      screen = { ...screen, model };
    }
    if (model) {
      this.rememberSessionModel(session, model);
    }

    if (session.provider !== 'claude') {
      return screen;
    }

    const badge = 'bypass permissions on';
    if (screen.status.toLowerCase().includes(badge)) {
      return screen;
    }

    const nextStatus = screen.status === 'Session active'
      ? badge
      : `${badge} · ${screen.status}`;

    return {
      ...screen,
      status: nextStatus,
      statusAnsi: nextStatus,
    };
  }

  private getStoredSessionModel(session: BoundSession): string | undefined {
    const cached = this.runtimeState(session.id).liveSessionModel;
    if (cached) {
      return cached;
    }
    if (!session.conversationRef.startsWith('pending:')) {
      return undefined;
    }
    const pending = this.db.pendingConversations.get(session.conversationRef);
    const model = pending?.rawMetadata?.[SESSION_MODEL_METADATA_KEY];
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  }

  private rememberSessionModel(session: BoundSession, model: string): void {
    this.runtimeState(session.id).liveSessionModel = model;
    if (!session.conversationRef.startsWith('pending:')) {
      return;
    }
    const pending = this.db.pendingConversations.get(session.conversationRef);
    if (!pending) {
      return;
    }
    if (pending.rawMetadata?.[SESSION_MODEL_METADATA_KEY] === model) {
      return;
    }
    this.db.pendingConversations.put({
      ...pending,
      rawMetadata: {
        ...(pending.rawMetadata ?? {}),
        [SESSION_MODEL_METADATA_KEY]: model,
      },
    });
  }

  private recoverSessionModelFromLogs(session: BoundSession): string | undefined {
    if (session.provider !== 'claude') {
      return undefined;
    }

    return extractLastClaudeModelFromText(readTextTailSync(session.rawLogPath, SESSION_MODEL_LOG_TAIL_BYTES))
      ?? extractLastClaudeModelFromText(readTextTailSync(session.eventLogPath, SESSION_MODEL_LOG_TAIL_BYTES));
  }
}
