import fs from 'node:fs';
import { imagePromptDisplay } from '../images/prompt.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CLAUDE_COST_PROFILES, CODEX_COST_PROFILES, visibleModelMatchesProfile, type AgentLaunchContext, type BoundSession, type ClaudeCostProfileKey, type CodexCostProfileKey, type ConversationSummary, type ModelProfileDeferredReason, type ModelProfileKey, type ModelProfileRequest, type ProviderId, type RecordedUserInput, type SessionEvent, type SessionInputResponse, type SessionModelProfileResponse, type SessionScreen } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { commandToShell } from '../lib/shell.js';
import { sleep } from '../lib/async.js';
import { AppDatabase } from '../db/database.js';
import type { ActiveProject } from '../projects/project-service.js';
import type { MergedProviderSettings } from '../config/service.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { ProviderRunState } from '../providers/types.js';
import { CONSOLE_PANE_COLUMNS, CONSOLE_PANE_ROWS, isTmuxSessionMissingError, type TmuxClient } from './tmux-client.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { normalizeRawOutputLines } from './live-output/filters.js';
import { LastUserInputCache, readLastUserInput } from './last-user-input.js';
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
  claudeFolderTrustSelection,
  extractLastClaudeModelFromText,
  hashScreen,
  screenAllowsLiteralSelectionTokenWithoutInput,
  screenInputChanged,
  screenInputMatchesText,
  screenInputMatchesPaste,
  screenIsStartingUp,
  screenLooksReadyForLiteralPrompt,
  screenAcceptsHumanPrompt,
  screenShowsClaudeResumeSessionChoice,
  claudeFullSessionResumeSelection,
  screenShowsQueuedMessageHint,
  screenShowsBackgroundWork,
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
import { InputQueue, queuedInputSummary, queuedTransportText, type QueuedInputRecord } from './input-queue.js';
import type { ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import { processStart } from '../coordination/service.js';
import { PEER_WAKE_PROMPT, UNATTENDED_CONTINUATION_PROMPT, GRANTED_RESTART_PROMPT, peerWakeAttemptKey, peerWakeFollowupKey, peerWakePaused, setPeerWakePaused, peerWakeRestoreKey, peerResumeAttemptKey, peerWakeComposerKey, peerWakePauseDetailsKey, queueCodexNotice, type PeerWakeAttempt, type PeerWakeComposer, type WakeBlock, type AutomaticInputPause } from '../coordination/wake.js';
import { alertOverdueAwait, continuationControl, CONTINUATION_DELAYS_MS, pendingContinuation, prepareContinuation, saveContinuation, setContinuation, signalContinuation } from '../coordination/continuation.js';

const SESSION_COMPLETION_IDLE_MS = 60_000;
const QUEUED_PASTE_CONFIRMATION_MS = 30_000;
const TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS = 1_800;
const CLAUDE_RESUME_READY_WAIT_MS = 15_000;
const CLAUDE_FOLDER_TRUST_WAIT_MS = 15_000;
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
// reconciliation. Their rows stay bound and tree-visible until Work-mode release;
// selecting one before release restores its tmux session on demand.
const DEFAULT_SESSION_EAGER_RESTORE_MS = 60 * 60 * 1000;
// Restoring a session does not move recency, so a freshly restored idle session
// gets this long before the reaper may suspend it again.
const DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS = 60 * 60 * 1000;
// Purple starts after 48 hours; retain that state for seven full days before release.
const WORK_SESSION_RELEASE_MS = (48 + 7 * 24) * 60 * 60 * 1000;
const SESSION_NOT_RUNNING_INPUT_MESSAGE = 'Session is no longer running. Rebind or restore the conversation before sending input.';
const RESTORE_FAILURE_STATUS_TAIL_BYTES = 64 * 1024;
interface SessionRecoveryDependencies {
  projectService: Pick<ProjectService, 'getProjectBySlug' | 'getMergedProviderSettings'>;
  providerRegistry: Pick<ProviderRegistry, 'get'>;
}

interface SessionManagerOptions {
  coordinationEnabled?: boolean;
  readLastUserInput?: typeof readLastUserInput;
  eagerRestoreWindowMs?: number;
  restoreGraceMs?: number;
  pressureSuspendAvailableBytes?: number;
  pressureSuspendIdleMs?: number;
  readMemInfo?: () => string;
  queueCodexNotice?: typeof queueCodexNotice;
  hasActiveLaunchAuthority?: (session: BoundSession) => boolean;
  launchAuthorityContext?: (context: AgentLaunchContext) => string | undefined;
}

type SessionEventLogEntry = { type: 'user-input' | 'agent-input' | 'raw-output' | 'status'; text: string; timestamp: string };

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
    ...imagePromptDisplay(appended.event.text),
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
  private readonly inputQueue: InputQueue;
  private readonly inputDrainTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeInputCommands = new Set<Promise<unknown>>();
  private reconciliationTimer?: ReturnType<typeof setInterval>;
  private reconciliationStartupTimer?: ReturnType<typeof setTimeout>;
  // Restoration grants a loaded idle window without advancing conversation recency.
  private readonly suspensionGraceUntilMs = new Map<string, number>();
  private readonly conversationBindRuns = new Map<string, Promise<BoundSession>>();
  private readonly scheduledModelProfileDrains = new Set<string>();
  private readonly requestedModelProfileRedrains = new Set<string>();
  private readonly autoTrackLaunchQueue: Array<() => void> = [];
  private readonly eagerRestoreWindowMs: number;
  private readonly restoreGraceMs: number;
  private readonly pressureSuspendAvailableBytes?: number;
  private readonly pressureSuspendIdleMs: number;
  private readonly readMemInfo: () => string;
  private readonly readLastUserInput: typeof readLastUserInput;
  private readonly queueCodexNotice: typeof queueCodexNotice;
  private consecutiveLowMemorySamples = 0;
  private autoTrackActiveLaunches = 0;
  private reconciliationRun?: Promise<void>;
  private assignmentWakeRun?: Promise<void>;
  private wakeRequested = false;
  private readonly coordinationEnabled: boolean;
  private readonly hasActiveLaunchAuthority?: (session: BoundSession) => boolean;
  private readonly launchAuthorityContext?: (context: AgentLaunchContext) => string | undefined;
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
    this.coordinationEnabled = options.coordinationEnabled ?? false;
    this.hasActiveLaunchAuthority = options.hasActiveLaunchAuthority;
    this.launchAuthorityContext = options.launchAuthorityContext;
    this.eagerRestoreWindowMs = options.eagerRestoreWindowMs ?? DEFAULT_SESSION_EAGER_RESTORE_MS;
    this.restoreGraceMs = options.restoreGraceMs ?? DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS;
    this.pressureSuspendAvailableBytes = options.pressureSuspendAvailableBytes;
    this.pressureSuspendIdleMs = options.pressureSuspendIdleMs ?? 60 * 60 * 1000;
    this.readMemInfo = options.readMemInfo ?? (() => fs.readFileSync('/proc/meminfo', 'utf8'));
    this.readLastUserInput = options.readLastUserInput ?? readLastUserInput;
    this.queueCodexNotice = options.queueCodexNotice ?? queueCodexNotice;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.inputQueue = new InputQueue(db.sqlite);
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
      mayRecover: (session) => this.unattendedAssignment(session) !== undefined,
      canRetry: async (session) => {
        if (this.stopped || this.getCurrentRestorableSession(session)?.id !== session.id
          || (session.status !== 'bound' && !(session.status === 'error' && session.runFailure?.code === 'process_exited'))) return 'This session no longer owns the conversation.';
        if (!this.unattendedAssignment(session)) return 'Unattended continuation is disabled for this assignment.';
        const assignment = this.db.sqlite.prepare('select status from coordination_assignments where provider=? and native_session_id=?')
          .get(session.provider, session.conversationRef) as { status: string } | undefined;
        if (assignment?.status === 'finished') return 'This assignment is finished.';
        if (session.manualSuspendedAt || session.pressureSuspendedAt || session.idleSuspendedAt || session.queuedInputs?.length || session.modelProfileRequest) return 'This session is paused or has a pending model change.';
        const available = this.availableMemoryBytes();
        if (this.pressureSuspendAvailableBytes !== undefined
          && (available === undefined || available < this.pressureSuspendAvailableBytes)) return 'Recovery is stopped while available memory is below the configured threshold.';
        const project = await this.recoveryDependencies?.projectService.getProjectBySlug(session.projectSlug);
        if (!project || !this.recoveryDependencies?.projectService.getMergedProviderSettings(project, session.provider).enabled) return 'This provider or project is no longer enabled.';
        const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
        if (liveness === 'unknown') return 'Provider liveness could not be confirmed.';
        if (liveness === 'dead') {
          const owner = this.db.sqlite.prepare('select pid,process_start as processStart from coordination_assignments where provider=? and native_session_id=?')
            .get(session.provider, session.conversationRef) as { pid: number; processStart: string } | undefined;
          if (owner && processStart(owner.pid) === owner.processStart) return 'The original provider still has a live owner outside this binding.';
          if (!await this.restoreSession(session)) return 'The original provider conversation could not be restored.';
        }
        if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id) return 'Session ownership could not be verified.';
        let screen = await this.captureSessionScreen(this.mustGetSession(session.id), false);
        if (liveness === 'dead') {
          if (session.provider === 'claude' && claudeFullSessionResumeSelection(screen) !== undefined) screen = await this.resumeFullClaudeSessionForPeerWake(session, screen);
          if (!screen.inputActive || screenIsStartingUp(screen)) screen = await this.waitForScreenMatch(session, hashScreen(screen), CLAUDE_RESUME_READY_WAIT_MS,
            candidate => candidate.inputActive && !screenIsStartingUp(candidate)) ?? screen;
        }
        if (!screen.inputActive || screen.inputText.trim() || sessionScreenShowsWorking(screen) || screenIsStartingUp(screen) || screenShowsInteractiveSelectionHint(screen) || screenShowsQueuedMessageHint(screen)
          || (session.provider === 'codex' ? !screen.model : !screenLooksReadyForLiteralPrompt(screen))) return 'The provider is busy, has an unsent draft, or needs your input.';
        return undefined;
      },
      submit: async (session, text, isCurrent) => {
        const ownsRecovery = () => {
          const current = this.db.boundSessions.getById(session.id);
          const assignment = this.db.sqlite.prepare('select status from coordination_assignments where provider=? and native_session_id=?')
            .get(session.provider, session.conversationRef) as { status: string } | undefined;
          const available = this.pressureSuspendAvailableBytes === undefined ? undefined : this.availableMemoryBytes();
          return isCurrent() && !this.stopped && this.getCurrentRestorableSession(session)?.id === session.id
            && this.unattendedAssignment(session) !== undefined
            && current?.status === 'bound' && !current.manualSuspendedAt && !current.pressureSuspendedAt && !current.idleSuspendedAt && !current.modelProfileRequest && !current.queuedInputs?.length
            && assignment?.status !== 'finished'
            && (this.pressureSuspendAvailableBytes === undefined || (available !== undefined && available >= this.pressureSuspendAvailableBytes));
        };
        if (!ownsRecovery()) throw new Error('Recovery was cancelled or conversation ownership changed before submission.');
        if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id || !ownsRecovery()) throw new Error('Session ownership changed before recovery submission.');
        this.runtimeState(session.id).submittedTurnAt = nowIso();
        try {
          if (session.provider === 'codex') {
            const project = await this.recoveryDependencies!.projectService.getProjectBySlug(session.projectSlug);
            if (!project || !ownsRecovery()) throw new Error('Recovery was cancelled before native submission.');
            await this.queueCodexNotice(session.conversationRef,
              this.recoveryDependencies!.projectService.getMergedProviderSettings(project, 'codex'), project.path, text);
          } else await this.runInputTmuxAction(session, async () => {
            const before = await this.captureSessionScreen(session, false);
            await this.sendLiteralTextToSession(session.tmuxSessionName, text);
            const entered = await this.waitForScreenMatch(session, hashScreen(before), combinedTextKeySettleWaitMs(text),
              screen => screen.inputActive && screenInputMatchesText(screen, text));
            if (!entered || !entered.inputActive || !screenInputMatchesText(entered, text)
              || sessionScreenShowsWorking(entered) || screenShowsInteractiveSelectionHint(entered)
              || screenShowsQueuedMessageHint(entered)) throw new Error('The provider did not confirm the recovery composer; text remains unsent.');
            // Stop runs outside the runtime queue. Never send Enter after it has
            // cancelled recovery during text entry; leave the text unsent.
            if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id || !ownsRecovery()) throw new Error('Recovery cancelled during text entry; recovery text remains unsent.');
            await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Enter']);
          });
        } catch (error) {
          this.runtimeState(session.id).submittedTurnAt = undefined;
          throw error;
        }
        const timestamp = nowIso();
        const updated = this.updateBoundSessionFields(session.id, { isWorking: true, lastActivityAt: timestamp, updatedAt: timestamp });
        this.appendEvent(updated, { type: 'status', text: 'Submitted automatic recovery for the interrupted turn.', timestamp });
        this.eventBus.emit({ type: 'session.updated', session: updated });
      },
      publish: (session) => {
        if (session.runFailure) {
          const failure = session.runFailure;
          this.appendEvent(session, { type: 'status', timestamp: nowIso(), text:
            `Provider recovery ${failure.status} (${failure.attempts}/${failure.maxAttempts}): ${failure.stoppedReason ?? failure.message}` });
        }
        this.eventBus.emit({ type: 'session.updated', session });
      },
      onRunState: (id, run) => {
        const session = this.db.boundSessions.getById(id);
        if (session && run.status === 'cancelled') {
          if (run.timestamp >= (session.lastActivityAt ?? session.startedAt)) this.pauseAutomaticInput(id, 'native_cancellation', `The native provider cancelled turn ${run.turnId} at ${run.timestamp}.`);
        }
        if (session && run.status === 'failed') {
          const assignment = this.assignmentForSession(session);
          const supervisor = assignment && continuationControl(this.db, assignment.id).supervisorId;
          if (supervisor) signalContinuation(this.db, supervisor, { key: `worker-failed:${assignment!.id}:${run.turnId}:${run.timestamp}`,
            source: assignment!.id, timestamp: run.timestamp, reason: `Supervised worker ${assignment!.id} stopped on a provider failure.` });
        }
        if (session?.shouldRestore && session.status === 'bound') {
          if (run.status === 'completed' && session.provider === 'codex') {
            this.recordProviderResponse(session, run);
          } else if (run.status === 'completed' && session.provider === 'claude') {
            void this.confirmClaudeResponse(id, run).catch((error: unknown) => {
              this.logger?.warn({ err: error, sessionId: id }, 'Failed to confirm Claude prompt readiness.');
            });
          } else {
            this.syncSessionWorkingState(session, { screenShowsWorking: false, capturedAt: nowIso() });
          }
        }
        this.scheduleModelProfileDrain(id);
        this.requestAssignmentWake();
      },
      onChildActivity: (id, events) => {
        const session = this.db.boundSessions.getById(id);
        const assignment = session && this.unattendedAssignment(session);
        if (!assignment) return;
        for (const event of events) signalContinuation(this.db, assignment.id, { key: `native-child:${event.id}`, source: event.childId,
          timestamp: event.timestamp, reason: `Native child ${event.childId} ${event.kind}; reconcile its result before continuing.` });
        this.requestAssignmentWake();
      },
      onError: (error) => this.logger?.warn({ err: error }, 'Run recovery failed.'),
    });
    this.unsubscribeRealtimeEvents = this.eventBus.subscribe((event) => this.handleRealtimeLifecycleEvent(event));
    for (const session of this.db.boundSessions.list()) {
      for (const record of this.inputQueue.list(session.id)) {
        if (record.state === 'submitting') this.inputQueue.put(session.id, { ...record, state: 'failed',
          reason: 'The server restarted during submission. Check the conversation before sending again.' });
      }
      this.scheduleInputDrain(session.id);
    }
  }

  private listRestorableSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter((session) => session.shouldRestore && session.status !== 'ended');
  }

  listActiveSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter(isTreeVisibleBoundSession);
  }

  private assignmentForSession(session: BoundSession): { id: string; status: string; pid: number; processStart: string; nativeSessionId: string } | undefined {
    type Assignment = { id: string; status: string; pid: number; processStart: string; nativeSessionId: string };
    if (session.conversationRef.startsWith('pending:')) {
      // Native registration records this exact Console binding before its
      // transcript exists. Ambiguous registrations cannot supply an identity.
      const rows = this.db.sqlite.prepare(`select a.id,a.status,a.pid,a.process_start as processStart,a.native_session_id as nativeSessionId
        from coordination_assignments a join meta m on m.key='console-session:' || a.id
        where m.value=? and a.provider=? limit 2`).all(session.id, session.provider) as Assignment[];
      return rows.length === 1 ? rows[0] : undefined;
    }
    return this.db.sqlite.prepare('select id,status,pid,process_start as processStart,native_session_id as nativeSessionId from coordination_assignments where provider=? and native_session_id=?')
      .get(session.provider, session.resumeConversationRef ?? session.conversationRef) as Assignment | undefined;
  }

  private isFinishedLaunchedSession(session: BoundSession): boolean {
    return !!session.launchContext && this.assignmentForSession(session)?.status === 'finished';
  }

  private async archiveFinishedExitedSession(sessionId: string): Promise<void> {
    const session = this.db.boundSessions.getById(sessionId);
    if (!session?.shouldRestore || session.manualSuspendedAt || !this.isFinishedLaunchedSession(session)) return;
    const assignment = this.assignmentForSession(session)!;
    if (processStart(assignment.pid) === assignment.processStart || !(await this.hasReadableIndexedTranscript(session))) return;
    if (await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) !== 'dead') return;
    const current = this.db.boundSessions.getById(sessionId);
    if (!current?.shouldRestore || current.manualSuspendedAt || !this.isFinishedLaunchedSession(current)) return;
    this.runRecovery.cancel(sessionId);
    await this.releaseSessionInternal(sessionId);
  }

  private unattendedAssignment(session: BoundSession): { id: string; status: string } | undefined {
    if (session.launchContext && this.hasActiveLaunchAuthority && !this.hasActiveLaunchAuthority(session)) return undefined;
    const assignment = this.coordinationEnabled && this.assignmentForSession(session);
    return assignment && assignment.status !== 'finished' && continuationControl(this.db, assignment.id).continuation === 'unattended' ? assignment : undefined;
  }

  private pauseAutomaticInput(sessionId: string, code: AutomaticInputPause['code'], reason: string): void {
    const session = this.db.boundSessions.getById(sessionId);
    const assignment = session && this.assignmentForSession(session);
    if (assignment && assignment.status !== 'finished') {
      setPeerWakePaused(this.db, assignment.id, true, { sessionId, code, reason, timestamp: nowIso() });
      setContinuation(this.db, assignment.id, 'waiting_for_input');
    }
  }

  private requestAssignmentWake(): void {
    queueMicrotask(() => { void this.wakePendingAssignments().catch((error: unknown) =>
      this.logger?.warn({ err: error }, 'Assignment wake deferred.')); });
  }

  /** Bounded unattended work and inbox delivery; ambiguous input is never replayed. */
  wakePendingAssignments(): Promise<void> {
    if (this.stopped || !this.coordinationEnabled) return Promise.resolve();
    this.wakeRequested = true;
    if (this.assignmentWakeRun) return this.assignmentWakeRun;
    this.assignmentWakeRun = (async () => {
      do { this.wakeRequested = false; await this.drainAssignments(); }
      while (this.wakeRequested && !this.stopped);
    })().finally(() => { this.assignmentWakeRun = undefined; });
    return this.assignmentWakeRun;
  }

  private async drainAssignments(): Promise<void> {
    // Historical unfinished assignments can vastly outnumber loaded bindings.
    // Read binding history once per pass, then revalidate each match under its lock.
    const restorableSessions = this.listRestorableSessions();
    const recipients = this.db.sqlite.prepare(`select distinct a.id, a.provider, a.native_session_id as nativeSessionId,
      a.pid, a.process_start as processStart from coordination_assignments a
      where a.status!='finished'`).all() as Array<{
        id: string; provider: string; nativeSessionId: string; pid: number; processStart: string;
      }>;
    for (const recipient of recipients) {
      if (this.stopped) return;
      if (alertOverdueAwait(this.db, recipient.id)) this.requestAssignmentWake();
      if (peerWakePaused(this.db, recipient.id)) continue;
      const sessions = restorableSessions.filter((session) => session.provider === recipient.provider
        && (session.conversationRef === recipient.nativeSessionId || session.resumeConversationRef === recipient.nativeSessionId));
      if (sessions.length !== 1) continue;
      const session = sessions[0]!;
      await this.runtimes.run(session.id, 'assignmentWake', async () => {
        const pending = () => {
          const state = this.db.boundSessions.getById(session.id);
          const stagedText = this.db.meta.get(peerWakeComposerKey(session.id));
          const staged = stagedText ? JSON.parse(stagedText) as PeerWakeComposer : undefined;
          const stagedKeys = new Set(staged?.status === 'staged' && staged.assignmentId === recipient.id
            && staged.pid === state?.pid && staged.startedAt === state?.startedAt ? staged.messages.map(message => message.key) : []);
          const retryable = (attempt: PeerWakeAttempt, key: string) => attempt.sessionId === state?.id
            && ((attempt.status === 'deferred' && attempt.nextAttemptAt && Date.now() >= Date.parse(attempt.nextAttemptAt))
              || (stagedKeys.has(key) && ['deferred', 'submitting'].includes(attempt.status)));
          const messages = this.db.sqlite.prepare(`select id, supplied_at as suppliedAt from coordination_messages
            where recipient_id=? and acknowledged_at is null order by created_at, id`).all(recipient.id) as Array<{ id: string; suppliedAt: string | null }>;
          return messages.flatMap((message) => {
            const initialKey = peerWakeAttemptKey(message.id), stored = this.db.meta.get(initialKey);
            if (!stored) return [{ id: message.id, key: initialKey }];
            const initial = JSON.parse(stored) as PeerWakeAttempt, key = peerWakeFollowupKey(message.id);
            if (retryable(initial, initialKey)) return [{ id: message.id, key: initialKey }];
            const followupText = this.db.meta.get(key);
            if (initial.status === 'submitted' && followupText) {
              return retryable(JSON.parse(followupText) as PeerWakeAttempt, key) ? [{ id: message.id, key }] : [];
            }
            // Wait for a completed turn and for any previous offer's cooldown.
            // Failed/submitting input is ambiguous and is not eligible. The
            // separate durable follow-up record preserves the initial attempt.
            if (!state || initial.status !== 'submitted' || initial.sessionId !== state.id
              || !Number.isFinite(Date.parse(initial.timestamp))
              || !state.lastCompletedAt || state.lastCompletedAt <= initial.timestamp
              || Date.now() - Date.parse(initial.timestamp) < 90_000
              || (message.suppliedAt && Date.now() - Date.parse(message.suppliedAt) < 60_000)) return [];
            return [{ id: message.id, key }];
          });
        };
        let current = this.db.boundSessions.getById(session.id);
        let priorControl = continuationControl(this.db, recipient.id);
        if (current && !priorControl.awaiting && priorControl.recovery?.status === 'submitted'
          && Date.now() - Date.parse(priorControl.recovery.startedAt) >= 30_000) {
          const submittedRevision = priorControl.revision;
          const submittedAt = priorControl.recovery.startedAt;
          await this.runRecovery.refresh(current.id);
          current = this.db.boundSessions.getById(session.id);
          const run = this.runRecovery.getRunState(session.id);
          if (!run || run.timestamp < submittedAt) {
            priorControl = continuationControl(this.db, recipient.id);
            if (priorControl.revision === submittedRevision && priorControl.recovery?.status === 'submitted' && priorControl.recovery.startedAt === submittedAt) {
              priorControl.recovery = { ...priorControl.recovery, status: 'blocked', reason: 'The provider did not acknowledge continuation. Review the conversation before enabling unattended work again.' };
              saveContinuation(this.db, recipient.id, priorControl);
              this.runtimeState(session.id).submittedTurnAt = undefined;
            }
          }
        }
        if (!current || this.getCurrentRestorableSession(current)?.id !== current.id
          || current.isWorking || current.modelProfileRequest || current.queuedInputs?.length || current.manualSuspendedAt
          || current.conversationRef.startsWith('pending:')) return;
        if (current.runFailure) return; // Typed provider failures use the single RunRecovery budget.
        const stagedText = this.db.meta.get(peerWakeComposerKey(session.id));
        const stagedComposer = stagedText ? JSON.parse(stagedText) as PeerWakeComposer : undefined;
        const stagedWork = current.provider === 'claude' && stagedComposer?.status === 'staged'
          && stagedComposer.notice === 'unattended' && stagedComposer.assignmentId === recipient.id
          && stagedComposer.pid === current.pid && stagedComposer.startedAt === current.startedAt
          && !priorControl.awaiting && priorControl.continuation === 'unattended' && stagedComposer.continuationRevision === priorControl.revision
          && priorControl.recovery && ['scheduled', 'submitting'].includes(priorControl.recovery.status);
        // A confirmed unsent work notice finishes its original attempt, even
        // after restart or when that attempt is the last one in the budget.
        const peerResponse = pending().length > 0;
        // Inbox turns do not advance the work budget while delivering the result.
        // Preserve uncertain work submissions as blocked even on an inbox turn.
        const preserveWorkBudget = stagedWork || (peerResponse && priorControl.recovery?.status !== 'submitting');
        let control = preserveWorkBudget ? priorControl
          : prepareContinuation(this.db, recipient.id, current.lastResponseAt ?? current.lastActivityAt);
        if (control.recovery?.status === 'stalled' && control.supervisorId) {
          const signalled = signalContinuation(this.db, control.supervisorId, {
            key: `worker-stalled:${recipient.id}:${control.revision}:${control.recovery.startedAt}`,
            source: recipient.id, timestamp: nowIso(), reason: `Supervised worker ${recipient.id} exhausted its continuation budget; inspect its unfinished work.`,
          });
          if (signalled) this.requestAssignmentWake();
        }
        const workResponse = !peerResponse || !!stagedWork;
        if ((!peerResponse && !stagedWork && !pendingContinuation(control)) || this.stopped) return;
        const revision = control.revision;
        const allowed = () => !this.stopped && !peerWakePaused(this.db, recipient.id)
          && (!workResponse || !continuationControl(this.db, recipient.id).awaiting)
          && (!workResponse || continuationControl(this.db, recipient.id).continuation === 'unattended')
          && (!workResponse || continuationControl(this.db, recipient.id).revision === revision);
        const project = await this.recoveryDependencies?.projectService.getProjectBySlug(current.projectSlug);
        if (!project) return;
        const providerSettings = this.recoveryDependencies!.projectService.getMergedProviderSettings(project, current.provider);
        if (!providerSettings.enabled) return;
        const available = this.availableMemoryBytes();
        if (this.pressureSuspendAvailableBytes !== undefined
          && (available === undefined || available < this.pressureSuspendAvailableBytes)) return;
        const liveness = await checkTmuxLiveness(this.tmuxClient, current.tmuxSessionName);
        if (liveness === 'unknown') return;
        if (liveness === 'dead') {
          // A surviving provider outside this tmux binding must never get a second writer.
          if (recipient.processStart && processStart(recipient.pid) === recipient.processStart) return;
          if (!allowed()) return;
          if (current.pid !== undefined) {
            await this.runRecovery.processExited(current.id);
            return;
          }
          const restored = await this.restoreSession(current);
          if (!restored) {
            const reason = 'The original conversation could not be restored.';
            if (peerResponse) {
              for (const message of pending()) this.db.meta.set(message.key, JSON.stringify({
                status: 'failed', sessionId: current.id, timestamp: nowIso(), reason,
              } satisfies PeerWakeAttempt));
              return;
            }
            control = continuationControl(this.db, recipient.id);
            if (control.revision === revision && control.continuation === 'unattended') {
              const attempts = (control.recovery?.attempts ?? 0) + 1;
              control.recovery = { attempts, status: attempts >= 3 ? 'stalled' : 'scheduled', reason,
                startedAt: control.recovery?.startedAt ?? nowIso(), nextAttemptAt: new Date(Date.now() + CONTINUATION_DELAYS_MS[Math.min(attempts, 2)]!).toISOString() };
              saveContinuation(this.db, recipient.id, control);
            }
            return;
          }
          current = restored;
          this.db.meta.set(peerWakeRestoreKey(current.id), JSON.stringify({ pid: current.pid, restoredAt: nowIso() }));
        }
        if (!allowed() || await this.tmuxClient.getOption(current.tmuxSessionName, '@agent_console_session_id') !== current.id) return;
        await this.runRecovery.refresh(current.id);
        let screen = await this.captureSessionScreen(current, false);
        if (this.stopped) return;
        if (current.provider === 'claude' && claudeFullSessionResumeSelection(screen) !== undefined) {
          try {
            screen = await this.resumeFullClaudeSessionForPeerWake(current, screen);
          } catch (error) {
            // No durable control attempt means no input was submitted. A
            // shutdown or transient ownership read must only defer delivery.
            if (!this.db.meta.get(peerResumeAttemptKey(current))) return;
            for (const message of pending()) this.db.meta.set(message.key, JSON.stringify({
              status: 'failed', sessionId: current.id, timestamp: nowIso(),
              reason: error instanceof Error ? error.message : 'The original Claude session could not finish resuming.',
            } satisfies PeerWakeAttempt));
            return;
          }
        }
        current = this.db.boundSessions.getById(current.id);
        const assignment = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(recipient.id) as { status: string } | undefined;
        const composerText = this.db.meta.get(peerWakeComposerKey(session.id));
        const composer = composerText ? JSON.parse(composerText) as PeerWakeComposer : undefined;
        const prompt = workResponse ? UNATTENDED_CONTINUATION_PROMPT : PEER_WAKE_PROMPT;
        const ownsStagedNotice = current?.provider === 'claude' && composer?.status === 'staged'
          && composer.assignmentId === recipient.id && composer.pid === current.pid && composer.startedAt === current.startedAt
          && (workResponse ? stagedWork && composer.notice === 'unattended' && composer.continuationRevision === revision : composer.notice === 'peer')
          && screenInputMatchesText(screen, prompt);
        if (!allowed() || !current || this.getCurrentRestorableSession(current)?.id !== current.id
          || !assignment || assignment.status === 'finished' || current.status !== 'bound'
          || current.isWorking || this.providerTurnIsWorking(current.id) === true
          || current.modelProfileRequest || current.queuedInputs?.length || current.manualSuspendedAt || current.pressureSuspendedAt
          || composer?.status === 'retiring'
          || (composer?.status === 'staged' && !ownsStagedNotice)
          || !screen.inputActive || (screen.inputText.trim() && !ownsStagedNotice) || sessionScreenShowsWorking(screen) || screenIsStartingUp(screen)
          || screenShowsInteractiveSelectionHint(screen) || screenShowsQueuedMessageHint(screen)
          || (current.provider === 'codex' ? !screen.model : !screenLooksReadyForLiteralPrompt(screen))) return;
        const submissionBlock = (): WakeBlock | undefined => {
          const latest = this.db.boundSessions.getById(session.id);
          if (this.stopped) return { code: 'shutdown', reason: 'The Console backend is stopping.' };
          if (peerWakePaused(this.db, recipient.id)) {
            const details = this.db.meta.get(peerWakePauseDetailsKey(recipient.id));
            const pause = details ? JSON.parse(details) as AutomaticInputPause : undefined;
            return { code: pause?.code ?? 'paused_without_reason', reason: pause?.reason ?? 'Automatic input is paused; the existing record predates pause-reason capture.' };
          }
          const permission = continuationControl(this.db, recipient.id);
          if (workResponse && (permission.awaiting || permission.continuation !== 'unattended' || permission.revision !== revision))
            return { code: 'permission_changed', reason: 'The unattended work permission changed during submission.' };
          const state = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(recipient.id) as { status: string } | undefined;
          if (!state || state.status === 'finished') return { code: 'assignment_finished', reason: 'The assignment finished during submission.' };
          if (latest?.status !== 'bound' || this.getCurrentRestorableSession(latest)?.id !== latest.id
            || latest.pid !== current!.pid || latest.startedAt !== current!.startedAt)
            return { code: 'binding_changed', reason: 'The current provider binding changed during submission.' };
          if (latest.manualSuspendedAt) return { code: 'manual_suspend', reason: 'The session was manually suspended.' };
          if (latest.pressureSuspendedAt) return { code: 'pressure_suspend', reason: 'The session was suspended for memory pressure.' };
          if (latest.modelProfileRequest) return { code: 'model_change', reason: 'A model change is queued.' };
          if (latest.queuedInputs?.length) return { code: 'human_input_queued', reason: 'A queued human message has priority over automatic input.' };
          if (this.pressureSuspendAvailableBytes !== undefined) {
            const availableNow = this.availableMemoryBytes();
            if (availableNow === undefined || availableNow < this.pressureSuspendAvailableBytes) return {
              code: 'memory_pressure', reason: `Available memory ${availableNow === undefined ? 'is unknown' : `is ${availableNow} bytes`}; automatic input requires ${this.pressureSuspendAvailableBytes} bytes.`,
              availableBytes: availableNow, thresholdBytes: this.pressureSuspendAvailableBytes,
            };
          }
          return undefined;
        };
        const messages = pending();
        control = continuationControl(this.db, recipient.id);
        const automatic = pendingContinuation(control);
        if ((peerResponse && !messages.length) || (workResponse && !stagedWork && !automatic)) return;
        if (workResponse && !control.signals.length && screenShowsBackgroundWork(screen)) return;
        const timestamp = nowIso();
        const restoreRecord = this.db.meta.get(peerWakeRestoreKey(current.id));
        const restore = restoreRecord ? JSON.parse(restoreRecord) as { pid: number; restoredAt: string } : undefined;
        const restoration: PeerWakeAttempt['restoration'] = restore && typeof current.pid === 'number' && restore.pid === current.pid
          && (!current.lastResponseAt || current.lastResponseAt < restore.restoredAt) ? 'restored' : 'already_loaded';
        // Persist before touching the terminal. An interrupted or ambiguous submission
        // is never automatically repeated, including after a backend restart.
        const saveAttempt = (status: PeerWakeAttempt['status'], reason?: string, block?: WakeBlock) => {
          for (const message of messages) this.db.meta.set(message.key,
            JSON.stringify({ status, sessionId: current!.id, timestamp, reason, restoration, block,
              ...(status === 'deferred' ? { nextAttemptAt: new Date(Date.now() + 15_000).toISOString() } : {}) } satisfies PeerWakeAttempt));
        };
        saveAttempt('submitting');
        const consumedSignals = new Set(control.signals.map(signal => signal.key));
        if (workResponse) {
          const attempts = (control.recovery?.attempts ?? 0) + (stagedWork ? 0 : 1);
          control.recovery = { status: 'submitting', attempts,
            reason: control.signals.slice(-3).map(signal => signal.reason).join(' ') || control.recovery!.reason,
            startedAt: timestamp,
            nextAttemptAt: new Date(Date.now() + CONTINUATION_DELAYS_MS[Math.min(attempts, 2)]!).toISOString() };
          saveContinuation(this.db, recipient.id, control);
        }
        const runtime = this.runtimeState(current.id);
        const previousSubmittedTurnAt = runtime.submittedTurnAt;
        runtime.submittedTurnAt = timestamp;
        let submissionInvoked = false, pasteStarted = false, composerConfirmed = ownsStagedNotice;
        let block: WakeBlock | undefined;
        const requireSubmissionGuard = async () => {
          const owner = await this.tmuxClient.getOption(current!.tmuxSessionName, '@agent_console_session_id');
          block = owner !== current!.id ? { code: 'ownership_changed', reason: 'The tmux session no longer belongs to this Console binding.' } : submissionBlock();
          if (block) throw new Error(block.reason);
        };
        try {
          await requireSubmissionGuard();
          if (current.provider === 'codex') {
            submissionInvoked = true;
            await this.queueCodexNotice(recipient.nativeSessionId, providerSettings, project.path, prompt);
          }
          else await this.runInputTmuxAction(current, async () => {
            const saveComposer = (status: PeerWakeComposer['status']) => {
              if (typeof current!.pid === 'number') this.db.meta.set(peerWakeComposerKey(current!.id), JSON.stringify({
                assignmentId: recipient.id, pid: current!.pid, startedAt: current!.startedAt, timestamp, status, messages,
                notice: workResponse ? 'unattended' : 'peer', ...(workResponse ? { continuationRevision: revision } : {}),
              } satisfies PeerWakeComposer));
            };
            let entered = await this.captureSessionScreen(current!, false);
            block = submissionBlock();
            if (block) throw new Error(block.reason);
            if (!ownsStagedNotice) {
              if (!entered.inputActive || entered.inputText.trim() || sessionScreenShowsWorking(entered)
                || screenShowsInteractiveSelectionHint(entered) || screenShowsQueuedMessageHint(entered) || screenIsStartingUp(entered))
                throw new Error('The provider composer changed before paste; existing text remains unsent.');
              saveComposer('pasting');
              pasteStarted = true;
              await this.tmuxClient.pasteText(current!.tmuxSessionName, prompt);
              entered = await this.waitForScreenMatch(current!, hashScreen(screen), combinedTextKeySettleWaitMs(prompt),
                candidate => candidate.inputActive && screenInputMatchesText(candidate, prompt)) ?? screen;
            }
            if (!entered || !screenInputMatchesText(entered, prompt) || !entered.inputActive || sessionScreenShowsWorking(entered)
              || screenShowsInteractiveSelectionHint(entered) || screenShowsQueuedMessageHint(entered) || screenIsStartingUp(entered)) throw new Error('The provider did not confirm a ready continuation composer; text remains unsent.');
            composerConfirmed = true;
            saveComposer('staged');
            await requireSubmissionGuard();
            // Ownership checks await tmux and can overlap native typing. Read
            // the actual composer after them, then recheck synchronous guards
            // with no further await before invoking Enter.
            entered = await this.captureSessionScreen(current!, false);
            block = submissionBlock();
            if (block) throw new Error(block.reason);
            if (!entered.inputActive || !screenInputMatchesText(entered, prompt) || sessionScreenShowsWorking(entered)
              || screenShowsInteractiveSelectionHint(entered) || screenShowsQueuedMessageHint(entered) || screenIsStartingUp(entered))
              throw new Error('The provider composer changed before Enter; existing text remains unsent.');
            // From this point an interrupted Enter is ambiguous and cannot be
            // replayed. A refusal before this point leaves a confirmed unsent
            // notice that the same owner may submit once after guards clear.
            saveComposer('submitting');
            submissionInvoked = true;
            await this.tmuxClient.sendKeys(current!.tmuxSessionName, ['Enter']);
          });
          saveAttempt('submitted');
          this.db.meta.set(peerWakeComposerKey(current.id), '');
          if (workResponse && allowed()) {
            control = continuationControl(this.db, recipient.id);
            control.recovery = { ...control.recovery!, status: 'submitted' };
            control.signals = control.signals.filter(signal => !consumedSignals.has(signal.key));
            saveContinuation(this.db, recipient.id, control);
          }
          if (restoreRecord) this.db.meta.set(peerWakeRestoreKey(current.id), '');
          const updated = this.updateBoundSessionFields(current.id, { isWorking: true, lastActivityAt: timestamp, updatedAt: timestamp });
          this.appendEvent(updated, { type: 'status', text: peerResponse ? 'Started peer-inbox response without changing continuation permission.' : 'Started unattended continuation of the existing authorized assignment.', timestamp });
          this.eventBus.emit({ type: 'session.updated', session: updated });
        } catch (error) {
          // The durable attempt still prevents replay. A transport rejection
          // must not make the previous completed provider turn look running.
          if (runtime.submittedTurnAt === timestamp) runtime.submittedTurnAt = previousSubmittedTurnAt;
          const deferred = !submissionInvoked && (!pasteStarted || composerConfirmed);
          const reason = error instanceof Error ? error.message : 'Provider input failed.';
          saveAttempt(deferred ? 'deferred' : 'failed', reason, block);
          this.appendEvent(current, { type: 'status', text: `Automatic ${peerResponse ? 'inbox' : 'work'} input ${deferred ? 'deferred before submission' : 'failed with uncertain delivery'}: ${reason}`, timestamp: nowIso() });
          if (workResponse && allowed()) {
            control = continuationControl(this.db, recipient.id);
            control.recovery = { ...control.recovery!, status: deferred ? 'scheduled' : 'blocked',
              reason: deferred ? `Continuation deferred before submission: ${reason}` : 'Continuation delivery is uncertain. Review the conversation before enabling unattended work again.' };
            saveContinuation(this.db, recipient.id, control);
          }
          this.logger?.warn({ err: error, sessionId: current.id, block, deferred }, 'Assignment input did not complete; uncertain submissions will not be replayed.');
        }
      }).catch((error: unknown) => this.logger?.warn({ err: error, sessionId: session.id }, 'Assignment continuation deferred.'));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const sessionsToDetach = this.listRestorableSessions()
      .filter((session) => session.rawLogPath && (session.status === 'starting' || session.status === 'bound'));
    this.stopped = true;
    for (const timer of this.inputDrainTimers.values()) clearTimeout(timer);
    this.inputDrainTimers.clear();
    await Promise.allSettled([...this.activeInputCommands]);
    await this.assignmentWakeRun;
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

  private async tryEnsurePaneSize(session: BoundSession): Promise<void> {
    const state = this.runtimeState(session.id);
    if (session.pid === undefined || session.pid === null || state.paneSizedPid === session.pid) return;
    try {
      await this.tmuxClient.ensureMinimumWindowSize(session.tmuxSessionName, CONSOLE_PANE_COLUMNS, CONSOLE_PANE_ROWS);
      state.paneSizedPid = session.pid;
    } catch (error) {
      this.logger?.warn({ err: error, sessionId: session.id, tmuxSessionName: session.tmuxSessionName },
        'Failed to size the hidden tmux pane.');
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

  private async verifyNativeProcessEpoch(session: BoundSession): Promise<void> {
    const state = this.runtimeState(session.id);
    if (!session.pid || state.nativeProcess?.pid === session.pid) return;
    const [owner, pid, startedAt] = await Promise.all([
      this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id'),
      this.tmuxClient.getPanePid(session.tmuxSessionName),
      this.tmuxClient.getSessionCreatedAt(session.tmuxSessionName),
    ]);
    if (owner === session.id && pid === session.pid) {
      state.nativeProcess = { pid, startedAt };
      if (state.submittedTurnAt && state.submittedTurnAt < startedAt) state.submittedTurnAt = undefined;
    }
  }

  private runPredatesNativeProcess(session: BoundSession, run: ProviderRunState): boolean {
    const native = this.runtimeState(session.id).nativeProcess;
    return native !== undefined && native.pid === session.pid && run.timestamp < native.startedAt;
  }

  private providerTurnIsWorking(sessionId: string): boolean | undefined {
    const run = this.runRecovery.getRunState(sessionId);
    const state = this.runtimeState(sessionId);
    if (!run) return undefined;
    // A previous completion cannot acknowledge a newly submitted turn.
    if (state.submittedTurnAt && run.timestamp < state.submittedTurnAt) return true;
    const session = this.db.boundSessions.getById(sessionId);
    // Resuming history does not resume its unfinished native request. This also
    // applies to ordinary restores and survives a backend-only restart because
    // the epoch comes from the existing tmux writer, not backend attachment time.
    if (session && this.runPredatesNativeProcess(session, run)) return undefined;
    // Claude can emit end_turn before another Stop hook continues the turn.
    // A completed record only clears working after the input prompt is visible.
    if (session?.provider === 'claude' && run.status === 'completed'
      && (!session.lastResponseAt || run.timestamp > session.lastResponseAt)) return true;
    state.submittedTurnAt = undefined;
    return run.status === 'running';
  }

  private recordProviderResponse(session: BoundSession, run: ProviderRunState): void {
    if (run.status !== 'completed' || !session.shouldRestore || session.status !== 'bound') return;
    if (this.runPredatesNativeProcess(session, run)) return;
    const submittedAt = this.runtimeState(session.id).submittedTurnAt;
    if (submittedAt && run.timestamp < submittedAt) return;
    const completedMs = Date.parse(run.timestamp);
    if (!Number.isFinite(completedMs)) return;
    const priorResponseMs = Date.parse(session.lastResponseAt ?? '');
    const updated: BoundSession = (!Number.isFinite(priorResponseMs) || completedMs > priorResponseMs)
      ? { ...session, lastResponseAt: run.timestamp, updatedAt: nowIso() }
      : session;
    if (updated !== session) this.db.boundSessions.upsert(updated);
    this.runRecovery.confirmCompletion(session.id, run);
    if (updated === session && !session.isWorking) return;
    this.syncSessionWorkingState(updated, { screenShowsWorking: false, capturedAt: nowIso() });
    if (!session.isWorking && updated !== session) this.eventBus.emit({ type: 'session.updated', session: updated });
    if (session.provider === 'claude') this.scheduleModelProfileDrain(session.id);
    this.requestAssignmentWake();
  }

  private confirmClaudeResponseFromScreen(session: BoundSession, screen: SessionScreen): void {
    if (session.provider !== 'claude' || !screenLooksReadyForLiteralPrompt(screen)) return;
    const run = this.runRecovery.getRunState(session.id);
    if (run?.status !== 'completed') return;
    this.recordProviderResponse(session, run);
  }

  private async confirmClaudeResponse(sessionId: string, run: ProviderRunState): Promise<void> {
    const session = this.db.boundSessions.getById(sessionId);
    if (!session || session.provider !== 'claude' || session.status !== 'bound') return;
    const screen = await this.captureSessionScreen(session, false);
    if (this.runRecovery.getRunState(sessionId)?.timestamp !== run.timestamp) return;
    this.confirmClaudeResponseFromScreen(this.db.boundSessions.getById(sessionId) ?? session, screen);
  }

  private shouldWatchSession(session: BoundSession): boolean {
    return !this.stopped
      && session.shouldRestore !== false
      && !session.manualSuspendedAt
      && !session.pressureSuspendedAt
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
    const pressureActive = this.observeLowAvailableMemory();
    const sessions = this.listRestorableSessions();
    if (pressureActive) {
      sessions.sort((a, b) => this.sessionIdleTimestampMs(a) - this.sessionIdleTimestampMs(b));
    }
    let pressureSuspended = false;
    for (let session of sessions) {
      // A user suspension survives reconciliation and backend restarts until
      // that conversation is explicitly opened again.
      if (session.manualSuspendedAt) continue;
      if (session.conversationRef.startsWith('pending:')) {
        const registered = this.assignmentForSession(session);
        if (registered && (session.launchContext || this.hasRecordedPendingUserInput(session)))
          await this.adoptRegisteredSession(session.id, session.provider, registered.nativeSessionId);
        else if (session.provider === 'codex' && this.hasRecordedPendingUserInput(session) && !session.isWorking && !session.queuedInputs?.length && !session.modelProfileRequest
          && Date.now() - this.sessionIdleTimestampMs(session) >= this.eagerRestoreWindowMs && this.recoveryDependencies) {
          await this.runtimes.run(session.id, 'resolveIdlePendingSession', async () => {
            const current = this.mustGetSession(session.id);
            if (current.isWorking || current.queuedInputs?.length || current.modelProfileRequest || current.manualSuspendedAt) return;
            const { projectService, providerRegistry } = this.recoveryDependencies!;
            const project = await projectService.getProjectBySlug(current.projectSlug);
            if (project) await this.tryResolvePendingResumeSession(current, project, providerRegistry.get(current.provider),
              projectService.getMergedProviderSettings(project, current.provider));
          });
        }
        session = this.db.boundSessions.getById(session.id) ?? session;
        if (!session.shouldRestore) continue;
      }
      if (this.isFinishedLaunchedSession(session)) {
        const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
        if (liveness !== 'alive') {
          if (liveness === 'dead') await this.runtimes.run(session.id, 'archiveFinishedExitedSession', () => this.archiveFinishedExitedSession(session.id));
          continue;
        }
      }
      if (this.isWorkReleaseDue(session)) {
        try {
          await this.runtimes.run(session.id, 'releaseExpiredWorkSession', async () => {
            const current = this.db.boundSessions.getById(session.id);
            if (!current || !this.isWorkReleaseDue(current)) return;
            if (!current.conversationRef.startsWith('pending:') && !(await this.hasReadableIndexedTranscript(current))) return;
            const liveness = await checkTmuxLiveness(this.tmuxClient, current.tmuxSessionName);
            if (liveness === 'unknown') return;
            if (liveness === 'alive') {
              const screen = await this.captureSessionScreen(current, false);
              const hasProviderFooter = /^gpt-\d/i.test(screen.status) || /bypass permissions on/i.test(screen.status);
              if (sessionScreenShowsWorking(screen) || (screenIsStartingUp(screen) && !hasProviderFooter)
                || screen.inputText.trim() || screenShowsInteractiveSelectionHint(screen)
                || screenShowsQueuedMessageHint(screen)) return;
            }
            this.runRecovery.cancel(current.id);
            await this.releaseSessionInternal(current.id, true);
          });
        } catch (error) {
          this.logger?.warn({ err: error, sessionId: session.id }, 'Failed to release expired Work session.');
        }
        continue;
      }
      // Pressure suspensions stay stopped after memory recovers and across
      // backend restarts. Selecting the conversation explicitly restores one.
      if (session.pressureSuspendedAt) continue;
      if (session.idleSuspendedAt && !session.queuedInputs?.length && !session.modelProfileRequest) continue;
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
      if (pressureActive && !pressureSuspended && this.isPressureSuspendable(session)) {
        pressureSuspended = await this.runtimes.run(session.id, 'pressureSuspendSession', () => this.suspendPressureIdleSession(session));
        if (pressureSuspended) continue;
      }
      // On the first low-memory sample, wait for confirmation before marking
      // a finished dead session suspended, but do not relaunch it meanwhile.
      if (this.consecutiveLowMemorySamples > 0 && this.isPressureSuspendable(session)
        && !this.hasActiveCoordinationAssignment(session)
        && this.providerTurnIsWorking(session.id) !== true
        && await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) === 'dead') continue;
      await this.runtimes.run(session.id, 'reconcileSession', () => this.refreshSessionState(session, { restoreMissing: true, resumeIdle: true }));
    }
  }

  private sessionIdleTimestampMs(session: BoundSession): number {
    const candidates = [session.lastActivityAt, session.lastOutputAt, session.lastCompletedAt, session.lastResponseAt, session.startedAt];
    let latest = 0;
    for (const candidate of candidates) {
      const parsed = candidate ? Date.parse(candidate) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > latest) {
        latest = parsed;
      }
    }
    return latest;
  }

  private availableMemoryBytes(): number | undefined {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(this.readMemInfo());
      return match ? Number(match[1]) * 1024 : undefined;
    } catch {
      return undefined;
    }
  }

  private observeLowAvailableMemory(): boolean {
    const threshold = this.pressureSuspendAvailableBytes;
    if (threshold === undefined) return false;
    const available = this.availableMemoryBytes();
    this.consecutiveLowMemorySamples = available !== undefined && available < threshold
      ? Math.min(this.consecutiveLowMemorySamples + 1, 2)
      : 0;
    // Two consecutive reconciliation samples prevent a brief dip from
    // stopping a provider. Reconciliation runs every 30 seconds.
    return this.consecutiveLowMemorySamples >= 2;
  }

  private isPressureSuspendable(session: BoundSession): boolean {
    if (!session.shouldRestore || session.status !== 'bound' || session.isWorking || session.queuedInputs?.length || session.modelProfileRequest
      || session.manualSuspendedAt || session.pressureSuspendedAt || session.conversationRef.startsWith('pending:')) {
      return false;
    }
    const responseMs = Date.parse(session.lastResponseAt ?? '');
    const updatedMs = Date.parse(session.updatedAt);
    if (!Number.isFinite(responseMs) || !Number.isFinite(updatedMs)) return false;
    const idleSinceMs = Math.max(this.sessionIdleTimestampMs(session), updatedMs);
    return Date.now() - idleSinceMs >= this.pressureSuspendIdleMs;
  }

  private async suspendPressureIdleSession(staleSession: BoundSession): Promise<boolean> {
    const threshold = this.pressureSuspendAvailableBytes;
    if (threshold === undefined) return false;
    const session = this.db.boundSessions.getById(staleSession.id);
    if (!session || !this.isPressureSuspendable(session)) return false;
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness === 'unknown') return false;
    if (liveness === 'alive') {
      if (await this.suspensionBlockReason(session, 'pressure')) return false;
    } else {
      // A finished session whose tmux process already exited must not be
      // relaunched by reconciliation while the host is under pressure.
      await this.runRecovery.refresh(session.id);
      if (this.providerTurnIsWorking(session.id) === true) return false;
    }
    const current = this.db.boundSessions.getById(session.id);
    const availableBeforeBytes = this.availableMemoryBytes();
    if (!current || !this.isPressureSuspendable(current) || availableBeforeBytes === undefined
      || availableBeforeBytes >= threshold) return false;
    if (this.hasActiveCoordinationAssignment(current)) return false;
    if (liveness === 'alive') {
      if (await this.tmuxClient.getOption(current.tmuxSessionName, '@agent_console_session_id').catch(() => undefined) !== current.id) return false;
      try {
        await this.tmuxClient.killSession(current.tmuxSessionName);
      } catch (error) {
        this.logger?.warn({ err: error, sessionId: current.id }, 'Failed to suspend idle session under memory pressure.');
        return false;
      }
    }
    if (await checkTmuxLiveness(this.tmuxClient, current.tmuxSessionName) !== 'dead') return false;
    this.stopWatching(current.id);
    this.runtimes.clearEphemeral(current.id);
    this.runRecovery.cancel(current.id);
    this.db.meta.set(peerWakeComposerKey(current.id), '');
    const suspended = this.db.boundSessions.setPressureSuspendedAt(current.id, nowIso());
    if (!suspended) return false;
    this.appendEvent(suspended, {
      type: 'status',
      text: 'Session suspended because available memory was low; it will restore on next use.',
      timestamp: nowIso(),
    });
    this.logger?.warn({
      sessionId: suspended.id,
      availableBeforeBytes,
      availableAfterBytes: this.availableMemoryBytes(),
      thresholdBytes: threshold,
    }, 'Suspended idle session under memory pressure.');
    this.eventBus.emit({ type: 'session.updated', session: suspended });
    return true;
  }

  private isWorkReleaseDue(session: BoundSession): boolean {
    if (!session.shouldRestore || session.isWorking || session.queuedInputs?.length || session.modelProfileRequest) return false;
    const idleSinceMs = this.sessionIdleTimestampMs(session);
    return idleSinceMs > 0 && Date.now() - idleSinceMs >= WORK_SESSION_RELEASE_MS;
  }

  private async hasReadableIndexedTranscript(session: BoundSession): Promise<boolean> {
    const indexed = this.db.conversationIndex.get(session.projectSlug, session.provider, session.conversationRef);
    if (indexed?.kind !== 'history' || !indexed.transcriptPath) return false;
    try {
      const stat = await fs.promises.stat(indexed.transcriptPath);
      if (!stat.isFile() || stat.size === 0) return false;
      await fs.promises.access(indexed.transcriptPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private isIdleSuspendable(session: BoundSession): boolean {
    if (session.isWorking || session.queuedInputs?.length || session.modelProfileRequest || session.conversationRef.startsWith('pending:')) {
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
    if (session.idleSuspendedAt) {
      return;
    }
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (liveness === 'unknown') {
      return;
    }
    if (liveness === 'alive') {
      const blocked = await this.suspensionBlockReason(session, 'idle');
      if (blocked) {
        // Retained live sessions still need their pipe/watchers after restart.
        // Ownership and unreadable-screen failures must not attach to a pane.
        if (blocked === 'busy') await this.refreshSessionState(session, { restoreMissing: false });
        return;
      }
      const latest = this.db.boundSessions.getById(session.id);
      if (!latest || !this.isIdleSuspendable(latest)) return;
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
    this.runRecovery.cancel(session.id);
    this.db.meta.set(peerWakeComposerKey(session.id), '');
    const suspended = this.db.boundSessions.setIdleSuspendedAt(session.id, nowIso());
    if (suspended) this.eventBus.emit({ type: 'session.updated', session: suspended });
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
    initialPrompt?: string,
  ): { cwd: string; argv: string[]; env: Record<string, string> } | undefined {
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    if (resumeConversationRef) {
      return provider.getLaunchCommand(project, resumeConversationRef, providerSettings, {
        initialPrompt,
        codexProfile: session.provider === 'codex' ? session.codexProfile : undefined,
        claudeProfile: session.provider === 'claude' ? session.claudeProfile : undefined,
        model: activeModelProfile(session) ? undefined : session.launchContext?.model,
        effort: activeModelProfile(session) ? undefined : session.launchContext?.effort,
        flags: session.launchContext?.flags,
        consoleIdentity: this.consoleIdentity(session.id),
        authorityContext: session.launchContext && this.launchAuthorityContext?.(session.launchContext),
      });
    }
    return undefined;
  }

  private consoleIdentity(sessionId: string) {
    return this.coordinationEnabled ? { sessionId, runtimeDir: this.runtimeDir,
      helperPath: fileURLToPath(new URL('../../../../scripts/agent-coord.mjs', import.meta.url)) } : undefined;
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
    const claimedRefs = new Set(this.db.boundSessions.list().filter(candidate => candidate.shouldRestore && candidate.id !== session.id
      && candidate.projectSlug === session.projectSlug && candidate.provider === session.provider).map(candidate => candidate.conversationRef));
    const matchedConversation = findPendingAdoptionMatch(pending, conversations, { claimedRefs });
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

  private async restoreSession(requestedSession: BoundSession, explicitResume = false, initialPrompt?: string, beforeStart?: () => void): Promise<BoundSession | undefined> {
    let session = this.getCurrentRestorableSession(requestedSession);
    if (!session) {
      return undefined;
    }
    if (!explicitResume && this.isFinishedLaunchedSession(session)) {
      await this.archiveFinishedExitedSession(session.id);
      return undefined;
    }
    // Restores do not move recency, so grant an explicit grace window before the
    // idle reaper may suspend this session again.
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
    const launch = this.buildRecoveryLaunchCommand(session, project, provider, providerSettings, initialPrompt);
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

    launch.env = { ...launch.env, AGENT_CONSOLE_SESSION_ID: session.id };
    beforeStart?.();
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
      this.runtimes.clearEphemeral(restoring.id);
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
      let resumed = rebound.manualSuspendedAt
        ? this.db.boundSessions.setManualSuspendedAt(rebound.id, undefined) ?? rebound
        : rebound;
      if (resumed.pressureSuspendedAt) {
        resumed = this.db.boundSessions.setPressureSuspendedAt(resumed.id, undefined) ?? resumed;
      }
      if (resumed.idleSuspendedAt) resumed = this.db.boundSessions.setIdleSuspendedAt(resumed.id, undefined) ?? resumed;
      this.appendEvent(resumed, { type: 'status', text: 'Restored bound session.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: resumed });
      this.watchSessionOutput(resumed);
      await this.emitScreenUpdate(resumed);
      return resumed;
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
    initialPromptIsHuman?: boolean;
    launchContext?: AgentLaunchContext;
    sessionId?: string;
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
      const sessionId = existing?.id ?? input.sessionId ?? randomUUID();
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

  /** Native registration supplies the real identity before any browser opens the conversation. */
  async adoptRegisteredSession(sessionId: string, providerId: ProviderId, nativeSessionId: string): Promise<void> {
    await this.runtimes.run(sessionId, 'adoptRegisteredSession', async () => {
      const session = this.db.boundSessions.getById(sessionId);
      if (!session?.shouldRestore || session.provider !== providerId || !this.recoveryDependencies) return;
      if (!session.conversationRef.startsWith('pending:') && session.conversationRef !== nativeSessionId) return;
      const project = await this.recoveryDependencies.projectService.getProjectBySlug(session.projectSlug);
      if (!project) return;
      const provider = this.recoveryDependencies.providerRegistry.get(providerId);
      const settings = this.recoveryDependencies.projectService.getMergedProviderSettings(project, providerId);
      const conversation = await provider.getConversation(project, nativeSessionId, settings);
      if (!conversation || (providerId === 'codex' && (conversation.summary.rawMetadata?.threadSource === 'subagent'
        || conversation.summary.rawMetadata?.forkedFromId))) return;
      const owner = this.db.boundSessions.getRestorableByConversation(project.slug, providerId, nativeSessionId);
      if (owner && owner.id !== session.id) return;
      // A launcher chose its session's title. A human-created chat's session title is only its
      // "New … conversation" placeholder, which must not mask the transcript's title once it has a first message.
      const hasFirstMessage = typeof conversation.summary.rawMetadata?.firstUserTextHash === 'string';
      const summary = session.title && (session.launchContext || !hasFirstMessage)
        ? { ...conversation.summary, title: session.title }
        : conversation.summary;
      this.db.conversationIndex.upsert(summary);
      if (session.launchContext && session.title) this.db.titleOverrides.set(project.slug, providerId, nativeSessionId, session.title, nowIso());
      const pending = this.db.pendingConversations.get(session.conversationRef);
      if (pending) {
        const adoption = adoptPendingConversation({ db: this.db, projectSlug: project.slug, providerId,
          pendingRef: pending.ref, matchedConversation: summary });
        if (adoption.reboundSession) this.eventBus.emit({ type: 'session.updated', session: adoption.reboundSession });
      } else if (session.conversationRef.startsWith('pending:')) {
        const adopted = { ...session, conversationRef: nativeSessionId, resumeConversationRef: nativeSessionId, updatedAt: nowIso() };
        this.db.boundSessions.upsert(adopted); this.eventBus.emit({ type: 'session.updated', session: adopted });
      }
      this.watchSessionOutput(this.mustGetSession(sessionId));
    });
  }

  /** An explicit granted restart starts one turn, independently of automatic recovery. */
  async restartGrantedSession(sessionId: string, prompt: string | undefined, authorized: () => boolean): Promise<BoundSession> {
    return this.runtimes.run(sessionId, 'restartGrantedSession', async () => {
      const session = this.mustGetSession(sessionId);
      if (!session.shouldRestore || session.status === 'ended' || session.manualSuspendedAt || session.pressureSuspendedAt || session.modelProfileRequest)
        throw new Error('This session is finished or paused.');
      const assignment = this.assignmentForSession(session);
      const requireRestartAuthority = () => {
        const latest = this.mustGetSession(sessionId);
        if (!authorized()) throw new Error('The grant no longer covers restarting this session.');
        if (this.stopped || this.getCurrentRestorableSession(latest)?.id !== sessionId
          || latest.manualSuspendedAt || latest.pressureSuspendedAt || latest.modelProfileRequest || latest.queuedInputs?.length
          || (assignment && peerWakePaused(this.db, assignment.id)))
          throw new SessionInputRejectedError('Restart is waiting for human input or a session pause to clear.');
      };
      requireRestartAuthority();
      const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
      if (liveness === 'unknown') throw new SessionInputRejectedError('Provider liveness could not be confirmed.');
      if (liveness === 'dead' && assignment && processStart(assignment.pid) === assignment.processStart)
        throw new SessionInputRejectedError('The original provider still has a live owner outside this binding.');
      if (liveness === 'alive') {
        if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id) throw new Error('Session ownership changed.');
        const screen = await this.captureSessionScreen(session, false);
        requireRestartAuthority();
        if (this.mustGetSession(sessionId).isWorking || this.providerTurnIsWorking(sessionId) === true || !screen.inputActive || screen.inputText.trim()
          || sessionScreenShowsWorking(screen) || screenShowsBackgroundWork(screen) || screenIsStartingUp(screen)
          || screenShowsInteractiveSelectionHint(screen) || screenShowsQueuedMessageHint(screen))
          throw new SessionInputRejectedError('Restart is waiting for the current work, draft or native choice to finish.');
        await this.tmuxClient.killSession(session.tmuxSessionName);
      }
      requireRestartAuthority();
      this.runRecovery.stopWatching(sessionId);
      this.db.boundSessions.setRunFailure(sessionId, undefined);
      this.db.meta.set(`run-recovery-budget:${sessionId}`, '');
      const restored = await this.restoreSession(session, true, prompt ?? GRANTED_RESTART_PROMPT, requireRestartAuthority);
      if (!restored) throw new Error('The original conversation could not be restored.');
      return restored;
    });
  }

  async closeGrantedSession(sessionId: string, launchedBy: string, authorized: () => boolean): Promise<void> {
    const pending = this.mustGetSession(sessionId);
    if (pending.launchContext?.launchedBy !== launchedBy || !authorized()) throw new Error('Session ownership or close authority changed.');
    if (pending.conversationRef.startsWith('pending:')) {
      const registered = this.assignmentForSession(pending);
      if (registered) await this.adoptRegisteredSession(sessionId, pending.provider, registered.nativeSessionId);
    }
    await this.runtimes.run(sessionId, 'closeGrantedSession', async () => {
      let session = this.mustGetSession(sessionId);
      if (session.launchContext?.launchedBy !== launchedBy) throw new Error('You can close only sessions your assignment launched.');
      if (!authorized()) throw new Error('The grant no longer covers closing this session.');
      if (!session.shouldRestore && session.status === 'ended') return;
      if (session.conversationRef.startsWith('pending:') && this.recoveryDependencies) {
        const project = await this.recoveryDependencies.projectService.getProjectBySlug(session.projectSlug);
        if (project) session = await this.tryResolvePendingResumeSession(session, project,
          this.recoveryDependencies.providerRegistry.get(session.provider),
          this.recoveryDependencies.projectService.getMergedProviderSettings(project, session.provider));
      }
      if (!(await this.hasReadableIndexedTranscript(session))) {
        throw new SessionInputRejectedError('Close is waiting for the native transcript to be indexed and readable.');
      }
      const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
      if (liveness === 'unknown') throw new SessionInputRejectedError('Provider liveness could not be confirmed.');
      if (liveness === 'alive' && await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== session.id) {
        throw new Error('Session ownership changed before close.');
      }
      const current = this.mustGetSession(sessionId);
      if (current.launchContext?.launchedBy !== launchedBy || current.projectSlug !== session.projectSlug || !authorized()) {
        throw new Error('Session ownership or close authority changed.');
      }
      this.pauseAutomaticInput(sessionId, 'owned_close', 'The launching assignment requested closing its helper.');
      this.runRecovery.cancel(sessionId);
      await this.releaseSessionInternal(sessionId);
    });
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
    initialPromptIsHuman?: boolean;
    launchContext?: AgentLaunchContext;
    sessionId?: string;
    codexProfile?: CodexCostProfileKey;
    claudeProfile?: ClaudeCostProfileKey;
    autoTrackedAt?: string;
  }, sessionId: string): Promise<SessionCommandResult> {
    const existing = this.db.boundSessions.getRestorableByConversation(input.project.slug, input.provider.id, input.conversationRef);
    if (existing) {
      const liveSession = await this.refreshSessionState(existing, { resumeIdle: true });
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
      { initialPrompt: input.initialPrompt, codexProfile: input.codexProfile, claudeProfile: input.claudeProfile,
        model: input.launchContext?.model, effort: input.launchContext?.effort, flags: input.launchContext?.flags,
        consoleIdentity: this.consoleIdentity(sessionId), authorityContext: input.launchContext && this.launchAuthorityContext?.(input.launchContext) },
    );
    const now = nowIso();
    const initialPrompt = input.initialPrompt?.trim();
    const session: BoundSession = {
      launchContext: input.launchContext,
      id: sessionId,
      provider: input.provider.id,
      codexProfile: input.provider.id === 'codex'
        ? input.codexProfile ?? (input.kind === 'pending' && !input.launchContext?.model && !input.launchContext?.effort ? 'medium' : undefined)
        : undefined,
      claudeProfile: input.provider.id === 'claude'
        ? input.claudeProfile ?? (input.kind === 'pending' && !input.launchContext?.model && !input.launchContext?.effort && !input.providerSettings.commands.newCommand.some((arg) =>
          arg === '--model' || arg.startsWith('--model=')) ? 'medium' : undefined)
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
    if (input.launchContext) this.db.boundSessions.setLaunchContext(sessionId, input.launchContext);
    launch.env = { ...launch.env, AGENT_CONSOLE_SESSION_ID: sessionId };

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
          this.appendEvent(boundSession, { type: input.initialPromptIsHuman === false ? 'agent-input' : 'user-input', text: initialPrompt, timestamp: inputAt }),
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
    this.inputQueue.invalidateNativeInput(sessionId);
    this.inputQueue.stage(sessionId, undefined);
    this.pauseAutomaticInput(sessionId, 'human_input', 'A human conversation input was requested.');
    this.runRecovery.cancel(sessionId);
    return await this.runtimes.run(sessionId, 'sendInput', () => this.sendInputInternal(sessionId, text));
  }

  private async sendInputInternal(sessionId: string, text: string): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session, { resumeIdle: true });
    if (!liveSession) {
      throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
    }
    if (liveSession.provider === 'claude') {
      const screen = await this.captureSessionScreen(liveSession);
      const prepared = await this.acceptClaudeFolderTrust(liveSession, screen);
      if (claudeFolderTrustSelection(screen) !== undefined && !screenLooksReadyForLiteralPrompt(prepared)) {
        throw new SessionKeystrokeRejectedError('Claude is waiting for another startup control. Answer it in the live session before sending input. The draft was not submitted.');
      }
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
    if (!payload.submissionId && (payload.text || payload.keys?.length)) this.inputQueue.invalidateNativeInput(sessionId);
    if (payload.text || payload.keys?.length) this.pauseAutomaticInput(sessionId,
      payload.keys?.includes('Escape') ? 'human_stop' : 'human_keys',
      payload.keys?.includes('Escape') ? 'A human requested Stop.' : 'A human requested native input.');
    if (payload.text || payload.keys?.length) this.runRecovery.cancel(sessionId);
    if (payload.keys?.some(key => key === 'Escape' || key === 'C-c')) this.cancelQueuedInputs(sessionId);
    if (!payload.submissionId && payload.keys?.length) this.inputQueue.stage(sessionId, undefined);
    if (payload.submissionId) {
      const run = this.runtimes.run(sessionId, 'queueInput', () => this.queueInputInternal(sessionId, payload));
      this.activeInputCommands.add(run);
      try { return await run; } finally { this.activeInputCommands.delete(run); }
    }
    return await this.runtimes.run(sessionId, 'sendKeystrokes', () => this.sendKeystrokesInternal(sessionId, payload));
  }

  private publishInputQueue(sessionId: string): BoundSession {
    const session = this.updateBoundSessionFields(sessionId, { updatedAt: nowIso() });
    this.eventBus.emit({ type: 'session.updated', session });
    return session;
  }

  private saveQueuedInput(sessionId: string, record: QueuedInputRecord): void {
    this.inputQueue.put(sessionId, record);
    this.publishInputQueue(sessionId);
  }

  private cancelQueuedInputs(sessionId: string): void {
    if (!this.db.isOpen()) return;
    const panePid = this.db.boundSessions.getById(sessionId)?.pid;
    for (const record of this.inputQueue.list(sessionId)) {
      // The human's own Stop key reaches the provider; clear our typed text
      // before the next queued message instead of racing a repeated Escape.
      const remnant = this.inputQueue.cancelledRemnant(sessionId, record, panePid);
      if (remnant) this.inputQueue.setRemnant(sessionId, { ...remnant, nativeRevision: this.inputQueue.revision(sessionId) });
      this.inputQueue.put(sessionId, record.state === 'submitting'
        ? { ...record, state: 'failed', reason: 'Stopped during submission. Check the conversation before sending again.' }
        : { ...record, state: 'cancelled' });
    }
    if (this.db.boundSessions.getById(sessionId)) this.publishInputQueue(sessionId);
  }

  async cancelQueuedInput(sessionId: string, requestId: string): Promise<SessionInputResponse> {
    // Invalidate before waiting on a slow capture or text transport.
    const record = this.inputQueue.get(sessionId, requestId);
    if (!record) throw new SessionInputRejectedError('Queued message not found.');
    if (record.state === 'submitting' || record.state === 'submitted') {
      throw new SessionInputRejectedError('Submission has already started. Check the conversation before sending again.');
    }
    this.saveQueuedInput(sessionId, { ...record, state: 'cancelled' });
    const remnant = this.inputQueue.cancelledRemnant(sessionId, record, this.mustGetSession(sessionId).pid);
    if (remnant) {
      this.inputQueue.setRemnant(sessionId, remnant);
      void this.runtimes.run(sessionId, 'clearCancelledInput', () => this.clearQueuedInputRemnantInternal(sessionId))
        .catch((error: unknown) => this.logger?.warn({ err: error, sessionId }, 'Cancelled message text was left in the native composer.'));
    }
    this.scheduleInputDrain(sessionId);
    return { session: this.mustGetSession(sessionId) };
  }

  /** Clears cancelled queue text only while it is the whole, unchanged, idle native draft. */
  private async clearQueuedInputRemnantInternal(sessionId: string): Promise<boolean> {
    const remnant = this.inputQueue.remnant(sessionId);
    const session = this.db.boundSessions.getById(sessionId);
    if (!remnant || !session || this.stopped) return false;
    if (session.pid !== remnant.panePid) {
      this.inputQueue.setRemnant(sessionId, undefined); return false;
    }
    if (session.status !== 'bound' || session.manualSuspendedAt || session.pressureSuspendedAt
      || this.getCurrentRestorableSession(session)?.id !== sessionId) return false;
    const revision = this.inputQueue.revision(sessionId);
    if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id') !== sessionId
      || await this.tmuxClient.getPanePid(session.tmuxSessionName) !== remnant.panePid) return false;
    const screen = await this.captureSessionScreen(session, false);
    // Claude's clear-input key interrupts a running turn. Cancellation may
    // now happen after human text was staged during that turn; leave it intact.
    if (revision !== this.inputQueue.revision(sessionId) || !screenLooksReadyForLiteralPrompt(screen)
      || (this.providerTurnIsWorking(sessionId) ?? this.mustGetSession(sessionId).isWorking)) return false;
    if (!screen.inputText.trim()) { this.inputQueue.setRemnant(sessionId, undefined); return true; }
    if (!screenInputMatchesText(screen, remnant.text)
      && !(remnant.nativeRevision === revision && screenInputMatchesPaste(screen, remnant.text, session.provider))) return false;
    // Journal before transport: an uncertain clear is never repeated, because
    // a second clear key on an empty composer can arm the provider's exit.
    this.inputQueue.setRemnant(sessionId, undefined);
    await this.runInputTmuxAction(session, () => revision === this.inputQueue.revision(sessionId)
      ? this.tmuxClient.sendKeys(session.tmuxSessionName, ['C-c']) : Promise.resolve());
    const cleared = await this.waitForScreenMatch(session, hashScreen(screen), combinedTextKeySettleWaitMs(remnant.text),
      candidate => screenLooksReadyForLiteralPrompt(candidate) && !candidate.inputText.trim());
    if (!cleared) return false;
    this.inputQueue.stage(sessionId, undefined);
    await this.emitScreenUpdate(this.mustGetSession(sessionId));
    return true;
  }

  private async queueInputInternal(sessionId: string, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const text = payload.submittedText?.trim();
    if (!text || payload.keys?.length !== 1 || payload.keys[0] !== 'Enter') {
      throw new SessionInputRejectedError('Queued submission requires a complete message and a single Enter.');
    }
    let record = this.inputQueue.get(sessionId, payload.submissionId!);
    if (record && record.text !== text) throw new SessionInputRejectedError('This submission ID already belongs to another message.');
    if (!record) {
      if (!session.shouldRestore || !['bound', 'starting'].includes(session.status)) {
        throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
      }
      record = { requestId: payload.submissionId!, text, initialText: payload.text?.trim() === text ? undefined : payload.text,
        requestedAt: nowIso(), state: 'queued', reason: 'Waiting for the session to accept the message.' };
      this.saveQueuedInput(sessionId, record);
    }
    await this.drainQueuedInputInternal(sessionId);
    record = this.inputQueue.get(sessionId, record.requestId)!;
    this.scheduleInputDrain(sessionId);
    const result = sessionCommandResult(this.mustGetSession(sessionId), record.recordedUserInput);
    if (record.state !== 'submitted' && record.state !== 'cancelled') result.queuedInput = queuedInputSummary(record);
    return result;
  }

  private scheduleInputDrain(sessionId: string): void {
    if (this.stopped || !this.db.isOpen() || this.inputDrainTimers.has(sessionId)) return;
    const first = this.inputQueue.list(sessionId)[0];
    if (!first || first.state === 'submitting' || first.state === 'failed') return;
    const timer = setTimeout(() => {
      const run = this.runtimes.run(sessionId, 'drainQueuedInput', () => this.drainQueuedInputInternal(sessionId));
      this.activeInputCommands.add(run);
      void run
        .catch((error: unknown) => {
          if (!this.stopped && this.db.isOpen()) this.logger?.warn({ err: error, sessionId }, 'Queued message delivery deferred.');
        }).finally(() => {
          this.activeInputCommands.delete(run);
          this.inputDrainTimers.delete(sessionId);
          this.scheduleInputDrain(sessionId);
        });
    }, 1_000);
    timer.unref?.();
    this.inputDrainTimers.set(sessionId, timer);
  }

  private async drainQueuedInputInternal(sessionId: string): Promise<void> {
    if (this.stopped || !this.db.isOpen()) return;
    const first = this.inputQueue.list(sessionId)[0];
    if (!first || ['submitting', 'failed'].includes(first.state)) return;
    let record: QueuedInputRecord = first;
    const attemptRevision = this.inputQueue.revision(sessionId);
    if (record.nativeRevision !== undefined && record.nativeRevision !== this.inputQueue.revision(sessionId)) {
      this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'The live draft was changed. Check it before sending again.' });
      return;
    }
    const defer = (reason: string) => {
      if (record.reason !== reason && this.inputQueue.get(sessionId, record.requestId)?.state === record.state) {
        record = { ...record, reason };
        this.saveQueuedInput(sessionId, record);
      }
    };
    let session = this.mustGetSession(sessionId);
    // The fast input poll may wake a bound sleeper once. Failed or incomplete
    // restores belong to reconciliation, rather than another one-second launch.
    if (session.idleSuspendedAt && session.status === 'bound') {
      const restored = await this.refreshSessionState(session, { resumeIdle: true });
      if (!restored) { defer('Waiting for the session to resume.'); return; }
      session = restored;
    }
    if (!session.shouldRestore || session.status !== 'bound' || this.getCurrentRestorableSession(session)?.id !== sessionId) {
      defer('Waiting for the original session to be available.'); return;
    }
    if (this.stopped || session.manualSuspendedAt || session.pressureSuspendedAt || session.modelProfileRequest?.state === 'applying') {
      defer('Waiting for the session to resume.'); return;
    }
    const stillOwned = async (): Promise<boolean> => {
      if (this.stopped || !this.db.isOpen()) return false;
      if (this.inputQueue.revision(sessionId) !== attemptRevision) return false;
      const current = this.db.boundSessions.getById(sessionId);
      if (!current || current.status !== 'bound' || current.manualSuspendedAt || current.pressureSuspendedAt
        || this.getCurrentRestorableSession(current)?.id !== sessionId
        || (record.nativeRevision !== undefined && record.nativeRevision !== this.inputQueue.revision(sessionId))
        || this.inputQueue.get(sessionId, record.requestId)?.state !== record.state) return false;
      if (await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) !== 'alive') return false;
      if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id').catch(() => undefined) !== sessionId) return false;
      const pid = await this.tmuxClient.getPanePid(session.tmuxSessionName);
      const latest = this.db.boundSessions.getById(sessionId);
      if (pid !== undefined && record.panePid !== undefined && pid !== record.panePid
        && this.inputQueue.get(sessionId, record.requestId)?.state === record.state
        && this.inputQueue.revision(sessionId) === attemptRevision) {
        this.saveQueuedInput(sessionId, { ...record, state: 'failed',
          reason: 'The native session changed after text entry. Check the conversation before sending again.' });
        return false;
      }
      return !this.stopped && latest?.status === 'bound' && !latest.manualSuspendedAt && !latest.pressureSuspendedAt
        && this.getCurrentRestorableSession(latest)?.id === sessionId
        && this.inputQueue.get(sessionId, record.requestId)?.state === record.state
        && this.inputQueue.revision(sessionId) === attemptRevision
        && (record.nativeRevision === undefined || record.nativeRevision === this.inputQueue.revision(sessionId))
        && pid !== undefined && pid === session.pid && (record.panePid === undefined || record.panePid === pid);
    };
    if (!await stillOwned()) { defer('Waiting to verify the original live session.'); return; }
    let screen = await this.captureSessionScreen(session, false);
    // Human Enter steers/queues within the native active turn. Working state
    // blocks automatic input, not an explicitly submitted human message.
    if (!screenAcceptsHumanPrompt(screen)) {
      defer(screenShowsInteractiveSelectionHint(screen)
        ? 'Waiting for you to finish the approval or menu.' : 'Waiting for the session to accept input.');
      return;
    }
    const noticeKey = peerWakeComposerKey(sessionId);
    const noticeText = this.db.meta.get(noticeKey);
    const notice = noticeText ? JSON.parse(noticeText) as PeerWakeComposer : undefined;
    if (notice?.status === 'retiring') {
      this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'Automatic notice removal was interrupted. Check the live draft before sending again.' });
      return;
    }
    const noticePrompt = notice?.notice === 'unattended' ? UNATTENDED_CONTINUATION_PROMPT : PEER_WAKE_PROMPT;
    if (record.state === 'queued' && session.provider === 'claude' && notice && ['pasting', 'staged'].includes(notice.status)
      && !noticePrompt.includes('\n')
      && notice.assignmentId === this.assignmentForSession(session)?.id
      && notice.pid === session.pid && notice.startedAt === session.startedAt
      && screenInputMatchesText(screen, noticePrompt)) {
      // Human input supersedes our own confirmed, single-line unsent notice.
      // Preserve foreign drafts and ambiguous Enter; never submit the notice
      // merely to make room for the human request.
      if (!await stillOwned()) return;
      screen = await this.captureSessionScreen(session, false);
      const canRetire = () => {
        const latest = this.db.boundSessions.getById(sessionId);
        return !this.stopped && latest?.status === 'bound' && !latest.manualSuspendedAt && !latest.pressureSuspendedAt
          && !(this.providerTurnIsWorking(sessionId) ?? latest.isWorking)
          && latest.pid === session.pid && latest.startedAt === session.startedAt
          && this.getCurrentRestorableSession(latest)?.id === sessionId
          && this.inputQueue.revision(sessionId) === attemptRevision
          && this.inputQueue.get(sessionId, record.requestId)?.state === 'queued';
      };
      if (!canRetire() || this.db.meta.get(noticeKey) !== noticeText || !screenLooksReadyForLiteralPrompt(screen)
        || !screenInputMatchesText(screen, noticePrompt)) return;
      // Journal before clear transport. A restart or uncertain clear must be
      // reviewed, rather than clearing whatever now occupies the composer.
      this.db.meta.set(noticeKey, JSON.stringify({ ...notice, status: 'retiring' } satisfies PeerWakeComposer));
      try {
        // Claude's idle clear-input control removes the entire composer;
        // line editing can leave earlier wrapped rows of this notice behind.
        await this.runInputTmuxAction(session, () => this.tmuxClient.sendKeys(session.tmuxSessionName, ['C-c']));
        const cleared = await this.waitForScreenMatch(session, hashScreen(screen), combinedTextKeySettleWaitMs(noticePrompt),
          candidate => screenLooksReadyForLiteralPrompt(candidate) && !candidate.inputText.trim());
        if (!cleared || !canRetire()) throw new Error('Automatic notice removal could not be confirmed.');
        this.db.meta.set(noticeKey, '');
        screen = cleared;
      } catch {
        if (this.inputQueue.get(sessionId, record.requestId)?.state === 'queued')
          this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'Automatic notice removal could not be confirmed. Check the live draft before sending again.' });
        return;
      }
    }
    if (record.state === 'queued' && screen.inputText.trim() && this.inputQueue.remnant(sessionId)
      && !this.queuedInputConfirmed(sessionId, record, screen, session.pid)) {
      if (!await stillOwned()) return;
      if (await this.clearQueuedInputRemnantInternal(sessionId)) screen = await this.captureSessionScreen(session, false);
    }
    let confirmed = this.queuedInputConfirmed(sessionId, record, screen, session.pid);
    if (record.state === 'queued' && !confirmed) {
      if (screen.inputText.trim()) {
        const delta = record.initialText?.trimEnd();
        const prefix = delta && record.text.endsWith(delta) ? record.text.slice(0, -delta.length).trim() : '';
        if (!prefix || !this.queuedInputConfirmed(sessionId, { ...record, text: prefix }, screen, session.pid)) {
          defer('Waiting for the existing terminal draft to be sent or cleared.'); return;
        }
      }
      if (!await stillOwned()) return;
      // Persist before transport: after a crash, observe this paste, never repeat it.
      record = { ...record, state: 'awaiting_input', baselineInput: screen.inputText, typedAt: nowIso(),
        panePid: session.pid ?? undefined, nativeRevision: this.inputQueue.revision(sessionId), reason: 'Waiting for the typed message to appear.' };
      this.saveQueuedInput(sessionId, record);
      const transportText = queuedTransportText(record);
      try {
        await this.runInputTmuxAction(session, () => shouldUseBracketedPasteTransport(transportText)
          ? this.tmuxClient.pasteText(session.tmuxSessionName, transportText)
          : this.sendLiteralTextToSession(session.tmuxSessionName, transportText));
      } catch {
        if (this.inputQueue.get(sessionId, record.requestId)?.state === 'awaiting_input') {
          this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'Text delivery could not be confirmed. Check the live draft before sending again.' });
        }
        return;
      }
      const settled = await this.waitForScreenMatch(session, hashScreen(screen), combinedTextKeySettleWaitMs(transportText),
        candidate => this.queuedInputConfirmed(sessionId, record, candidate, session.pid));
      screen = settled ?? screen;
      confirmed = this.queuedInputConfirmed(sessionId, record, screen, session.pid);
    } else if (record.state === 'awaiting_input') {
      confirmed ||= this.queuedInputConfirmed(sessionId, record, screen, session.pid);
      if (!confirmed && Date.now() - Date.parse(record.typedAt ?? record.requestedAt) >= QUEUED_PASTE_CONFIRMATION_MS) {
        this.saveQueuedInput(sessionId, { ...record, state: 'failed',
          reason: 'The typed message could not be confirmed within 30 seconds. Check the live draft before sending again.' });
        return;
      }
    }
    if (!confirmed || !screenAcceptsHumanPrompt(screen) || !await stillOwned()) return;
    screen = await this.captureSessionScreen(session, false);
    if (!screenAcceptsHumanPrompt(screen)
      || !this.queuedInputConfirmed(sessionId, record, screen, session.pid) || !await stillOwned()) return;
    const observedInput = record;
    record = { ...record, state: 'submitting', nativeRevision: this.inputQueue.revision(sessionId),
      reason: 'Sending the message.' };
    this.saveQueuedInput(sessionId, record);
    try {
      if (this.stopped || !await stillOwned()) {
        if (this.db.isOpen() && this.inputQueue.get(sessionId, record.requestId)?.state === 'submitting') {
          this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'Session ownership changed before submission. Check the live draft before sending again.' });
        }
        return;
      }
      // Ownership reads can yield while the native composer changes. Observe it
      // last, then perform synchronous queue/revision checks before sending Enter.
      const finalScreen = await this.captureSessionScreen(session, false);
      if (!screenAcceptsHumanPrompt(finalScreen)
        || !this.queuedInputConfirmed(sessionId, observedInput, finalScreen, session.pid)
        || this.inputQueue.revision(sessionId) !== attemptRevision
        || this.inputQueue.get(sessionId, record.requestId)?.state !== 'submitting') {
        if (this.inputQueue.get(sessionId, record.requestId)?.state === 'submitting') {
          this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'The live draft changed before submission. Check it before sending again.' });
        }
        return;
      }
      this.runtimeState(sessionId).submittedTurnAt = nowIso();
      await this.runInputTmuxAction(session, () => this.tmuxClient.sendKeys(session.tmuxSessionName, ['Enter']));
      const inputAt = nowIso();
      const updated = this.updateBoundSessionFields(sessionId, { updatedAt: inputAt, lastActivityAt: inputAt });
      if (updated.conversationRef.startsWith('pending:')) {
        recordPendingUserInput({ db: this.db, pendingRef: updated.conversationRef, boundSessionId: sessionId, text: record.text, inputAt });
      }
      const recordedUserInput = recordedUserInputFromEvent(this.appendEvent(updated, { type: 'user-input', text: record.text, timestamp: inputAt }));
      this.inputQueue.stage(sessionId, undefined);
      this.saveQueuedInput(sessionId, { ...record, state: 'submitted', initialText: undefined, baselineInput: undefined, recordedUserInput });
      await this.emitScreenUpdate(this.mustGetSession(sessionId));
    } catch {
      if (this.inputQueue.get(sessionId, record.requestId)?.state !== 'submitted') {
        this.saveQueuedInput(sessionId, { ...record, state: 'failed', reason: 'Submission could not be confirmed. Check the conversation before sending again.' });
      }
    }
  }

  private queuedPasteConfirmed(record: QueuedInputRecord, screen: SessionScreen, provider: ProviderId): boolean {
    if (record.state !== 'awaiting_input' || screen.inputText === record.baselineInput) return false;
    return screenInputMatchesPaste(screen, queuedTransportText(record), provider, record.baselineInput ?? '');
  }

  private queuedInputConfirmed(sessionId: string, record: QueuedInputRecord, screen: SessionScreen, pid: number | null | undefined): boolean {
    const provider = this.mustGetSession(sessionId).provider;
    if (screenInputMatchesText(screen, record.text) || this.queuedPasteConfirmed(record, screen, provider)) return true;
    const staged = this.inputQueue.staged(sessionId);
    if (!staged || staged.panePid !== pid || staged.text.trim() !== record.text.trim() || !staged.hasPaste) return false;
    return screenInputMatchesPaste(screen, staged.text.slice(staged.prefix.length), provider, staged.prefix);
  }

  private async sendKeystrokesInternal(sessionId: string, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session, { resumeIdle: true });
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
          || (plan.shouldProbeClaudeResumePrompt && (screenShowsClaudeResumeSessionChoice(preparedScreen)
            || claudeFolderTrustSelection(preparedScreen) !== undefined))
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
      const staged = this.inputQueue.staged(liveSession.id);
      const previousDraft = staged?.panePid === liveSession.pid ? staged : undefined;
      const draftBase = previousDraft?.text ?? (preparedScreen?.inputActive ? preparedScreen.inputText : undefined);
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

      if (draftBase !== undefined && liveSession.pid !== undefined && liveSession.pid !== null) {
        this.inputQueue.stage(liveSession.id, {
          text: draftBase + transportText,
          prefix: plan.useBracketedPasteTransport && !previousDraft?.hasPaste ? draftBase : previousDraft?.prefix ?? draftBase,
          hasPaste: plan.useBracketedPasteTransport || previousDraft?.hasPaste,
          panePid: liveSession.pid,
        });
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
      if ((plan.hasSpecialKeys || useBracketedPasteTransport) && (expectsVisibleInputChange || shouldPrepareClaudeResumePrompt
        || (liveSession.provider === 'claude' && claudeFolderTrustSelection(latestObservedScreen) !== undefined))) {
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
        this.assertInteractiveChatInputAllowed(liveSession, textEntryScreen, payload);
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
            this.logger?.warn({
              sessionId: liveSession.id,
              provider: liveSession.provider,
              textLength: transportText.length,
              keys: payload.keys,
              settleWaitMs: combinedTextKeySettleWaitMs(transportText),
              beforeInputLength: textEntryScreen.inputText.length,
              afterInputLength: latestObservedScreen.inputText.length,
              beforeScreenHash: hashScreen(textEntryScreen),
              afterScreenHash: hashScreen(latestObservedScreen),
            }, 'Live input rejected because typed text was not confirmed; session retained.');
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
        && submittedTextShouldCreateUserTurn(latestObservedScreen, submittedText ?? (shouldRecordTextAsUserInput ? payload.text : undefined))) {
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
    const submittedUserTurnText = !submittedDeferredSelection && submittedTextShouldCreateUserTurn(latestObservedScreen, submittedText)
      ? submittedText
      : undefined;
    const fallbackUserTurnText = submittedText === undefined
      && payload.keys?.includes('Enter')
      && shouldRecordTextAsUserInput
      && submittedTextShouldCreateUserTurn(latestObservedScreen, payload.text)
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
    if (session.idleSuspendedAt) {
      session = await this.refreshSessionState(session, { resumeIdle: true });
      if (!session) return;
      request = session.modelProfileRequest;
      if (!request || request.state === 'failed') return;
    }
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
    const pendingInputs = this.inputQueue.list(session.id);
    const stagedInput = this.inputQueue.staged(session.id);
    if (pendingInputs.some(input => input.state !== 'queued')
      || (pendingInputs.length && stagedInput && stagedInput.panePid === session.pid && stagedInput.text.trim())) {
      this.deferModelProfileRequest(session, request, 'unsent_input');
      return;
    }
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
      const launch = provider.getLaunchCommand(project, resumeRef, providerSettings, { ...launchModelProfile(starting.provider, request.profile), flags: starting.launchContext?.flags, consoleIdentity: this.consoleIdentity(starting.id), authorityContext: starting.launchContext && this.launchAuthorityContext?.(starting.launchContext) });
      launch.env = { ...launch.env, AGENT_CONSOLE_SESSION_ID: starting.id };
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
          const rollbackLaunch = provider.getLaunchCommand(project, resumeRef, providerSettings, { ...launchModelProfile(starting.provider, previousProfile), flags: starting.launchContext?.flags, consoleIdentity: this.consoleIdentity(starting.id), authorityContext: starting.launchContext && this.launchAuthorityContext?.(starting.launchContext) });
          rollbackLaunch.env = { ...rollbackLaunch.env, AGENT_CONSOLE_SESSION_ID: starting.id };
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
    this.cancelQueuedInputs(sessionId);
    this.pauseAutomaticInput(sessionId, 'release', 'The session was released.');
    this.runRecovery.cancel(sessionId);
    await this.runtimes.run(sessionId, 'releaseSession', () => this.releaseSessionInternal(sessionId));
  }

  private hasActiveCoordinationAssignment(session: BoundSession): boolean {
    const assignment = this.db.sqlite.prepare(`
      select status from coordination_assignments
      where provider = ? and native_session_id = ?
    `).get(session.provider, session.conversationRef) as { status: string } | undefined;
    // Turn-end hooks mark unfinished assignments waiting; provider readiness
    // checks below still protect work, drafts, and queued input.
    return assignment?.status === 'active';
  }

  private ownsUnsentAutomaticNotice(session: BoundSession, screen: SessionScreen): boolean {
    const value = this.db.meta.get(peerWakeComposerKey(session.id));
    if (!value || session.provider !== 'claude') return false;
    const notice = JSON.parse(value) as PeerWakeComposer;
    return ['pasting', 'staged'].includes(notice.status) && notice.pid === session.pid && notice.startedAt === session.startedAt
      && notice.assignmentId === this.assignmentForSession(session)?.id
      && screenInputMatchesText(screen, notice.notice === 'unattended' ? UNATTENDED_CONTINUATION_PROMPT : PEER_WAKE_PROMPT);
  }

  private async suspensionBlockReason(session: BoundSession, mode: 'manual' | 'idle' | 'pressure'): Promise<'assignment' | 'ownership' | 'screen' | 'busy' | undefined> {
    // An assignment can remain active after SessionStart without a running
    // turn. Ordinary idle sleep uses native activity. Manual suspension can
    // also pause a turn waiting at a native selection without answering it.
    if (await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) !== 'alive'
      || await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id').catch(() => undefined) !== session.id) {
      return 'ownership';
    }
    await this.runRecovery.refresh(session.id);
    const snapshot = await this.tmuxClient.capturePane(session.tmuxSessionName).catch(() => '');
    if (!snapshot.trim()) return 'screen';
    const screen = parseSessionScreenSnapshot(snapshot, nowIso());
    const current = this.db.boundSessions.getById(session.id);
    const idleResumeChoice = session.provider === 'claude' && claudeFullSessionResumeSelection(screen) !== undefined;
    const run = this.runRecovery.getRunState(session.id);
    const selectionLines = screen.content.split('\n').map(line => line.trim()).filter(Boolean).slice(-8);
    const knownClaudeSelection = session.provider === 'claude'
      && (idleResumeChoice || claudeFolderTrustSelection(screen) !== undefined);
    // An incomplete composer can contain menu-control text. Require actual
    // choices before treating the missing composer as a native input wait.
    const unparsedInput = !knownClaudeSelection
      && selectionLines.some(line => /^[❯›>]\s*(?!\d+\.\s)\S/u.test(line));
    const nativeSelection = knownClaudeSelection || (!unparsedInput
      && selectionLines.filter(line => /^(?:[❯›>]\s*)?\d+\.\s/u.test(line)).length >= 2);
    const manualInputWait = mode === 'manual' && !screen.inputActive && nativeSelection && screenShowsInteractiveSelectionHint(screen)
      && (!run || run.timestamp <= screen.capturedAt);
    const noticeValue = this.db.meta.get(peerWakeComposerKey(session.id));
    const notice = noticeValue ? JSON.parse(noticeValue) as PeerWakeComposer : undefined;
    if (notice && notice.pid === session.pid && notice.startedAt === session.startedAt
      && ['submitting', 'retiring'].includes(notice.status)) return 'busy';
    const ownedNotice = this.ownsUnsentAutomaticNotice(session, screen);
    const turnIsWorking = this.providerTurnIsWorking(session.id);
    // A ready composer/model is required for automatic sleep, not a human
    // pause. Native completion also permits pausing a still-repainting resume.
    const requireReadyPrompt = mode !== 'manual'
      || unparsedInput || (!manualInputWait && !screen.inputActive && turnIsWorking !== false);
    if (mode !== 'idle' && !manualInputWait && this.hasActiveCoordinationAssignment(session)) return 'assignment';
    if (!current || !current.shouldRestore || current.status !== 'bound' || (!manualInputWait && current.isWorking)
      || current.modelProfileRequest || (mode !== 'manual' && current.queuedInputs?.length) || current.manualSuspendedAt || current.pressureSuspendedAt
      || current.conversationRef.startsWith('pending:') || (!manualInputWait && turnIsWorking === true)
      || sessionScreenShowsWorking(screen) || (requireReadyPrompt && screenIsStartingUp(screen))
      || screenShowsBackgroundWork(screen)
      || (screen.inputText.trim() && !ownedNotice) || (requireReadyPrompt && !idleResumeChoice && (!screen.inputActive || screenShowsInteractiveSelectionHint(screen)))
      || screenShowsQueuedMessageHint(screen)
      || (requireReadyPrompt && (session.provider === 'codex' ? !screen.model : !idleResumeChoice && !screenLooksReadyForLiteralPrompt(screen)))) {
      return 'busy';
    }
    return undefined;
  }

  async suspendSession(sessionId: string): Promise<BoundSession> {
    this.pauseAutomaticInput(sessionId, 'manual_suspend', 'The session was manually suspended.');
    return await this.runtimes.run(sessionId, 'suspendSession', async () => {
      const session = this.mustGetSession(sessionId);
      if (session.manualSuspendedAt || session.pressureSuspendedAt) return session;
      if (session.idleSuspendedAt && await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) === 'dead') {
        this.db.boundSessions.setManualSuspendedAt(session.id, nowIso());
        const suspended = this.db.boundSessions.setIdleSuspendedAt(session.id, undefined)!;
        this.cancelQueuedInputs(session.id);
        this.eventBus.emit({ type: 'session.updated', session: suspended });
        return suspended;
      }
      if (!session.shouldRestore || session.status !== 'bound'
        || session.modelProfileRequest || session.conversationRef.startsWith('pending:')) {
        throw new SessionInputRejectedError('Only an idle, established session can be suspended.');
      }
      const blockReason = await this.suspensionBlockReason(session, 'manual');
      if (blockReason === 'assignment') {
        throw new SessionInputRejectedError('This session has an active coordination assignment.');
      }
      if (blockReason === 'ownership') {
        throw new SessionInputRejectedError('Session ownership or liveness could not be verified.');
      }
      if (blockReason === 'screen') throw new SessionInputRejectedError('Session screen could not be verified.');
      if (blockReason === 'busy') {
        throw new SessionInputRejectedError('The provider is busy or has an unsent draft or queued input.');
      }
      await this.tmuxClient.killSession(session.tmuxSessionName);
      if (await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName) !== 'dead') {
        throw new Error('Session did not stop cleanly.');
      }
      this.stopWatching(session.id);
      this.runtimes.clearEphemeral(session.id);
      this.runRecovery.cancel(session.id);
      this.db.meta.set(peerWakeComposerKey(session.id), '');
      let suspended = this.db.boundSessions.setManualSuspendedAt(session.id, nowIso());
      if (!suspended) throw new Error('Session disappeared while suspending.');
      if (suspended.idleSuspendedAt) suspended = this.db.boundSessions.setIdleSuspendedAt(session.id, undefined)!;
      this.cancelQueuedInputs(sessionId);
      suspended = this.mustGetSession(sessionId);
      this.appendEvent(suspended, { type: 'status', text: 'Session suspended; opening this conversation will resume it.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: suspended });
      return suspended;
    });
  }

  async resumeSession(sessionId: string): Promise<BoundSession> {
    return await this.runtimes.run(sessionId, 'resumeSession', async () => {
      const session = this.mustGetSession(sessionId);
      if (!session.shouldRestore || session.status === 'ended' || session.status === 'releasing') {
        throw new SessionInputRejectedError('This session can no longer be resumed.');
      }
      const restored = await this.refreshSessionState(session, { restoreMissing: true, resumeSuspension: true });
      if (!restored || restored.manualSuspendedAt || restored.pressureSuspendedAt) {
        throw new SessionInputRejectedError('The provider session could not be resumed.');
      }
      return restored;
    });
  }

  private async releaseSessionInternal(sessionId: string, removePendingConversation = false): Promise<void> {
    const session = this.mustGetSession(sessionId);
    if (!session.shouldRestore && session.status === 'ended') return;
    if (session.modelProfileRequest) this.db.boundSessions.replaceModelProfileRequest(sessionId, undefined, nowIso());
    const retainBindingAfterFailure = (text: string) => {
      const retained: BoundSession = { ...session, status: session.status === 'releasing' ? 'bound' : session.status,
        shouldRestore: session.status === 'releasing' ? true : session.shouldRestore, updatedAt: nowIso() };
      this.db.boundSessions.upsert(retained);
      this.appendEvent(retained, { type: 'status', text, timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: retained });
    };
    const releasing = {
      ...session,
      status: 'releasing' as const,
      shouldRestore: false,
      modelProfileRequest: undefined,
      updatedAt: nowIso(),
      isWorking: false,
    };
    this.db.boundSessions.upsert(releasing);
    this.eventBus.emit({ type: 'session.updated', session: releasing });
    this.appendEvent(releasing, { type: 'status', text: 'Releasing session.', timestamp: nowIso() });

    const initialLiveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    if (initialLiveness === 'unknown') {
      retainBindingAfterFailure('Failed to verify tmux session before release. The conversation remains available.');
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
      retainBindingAfterFailure(finalLiveness === 'unknown'
          ? 'Failed to verify tmux session release.'
          : 'Failed to release tmux session cleanly. The conversation remains available.');
      throw new Error(`Failed to release tmux session ${session.tmuxSessionName}`);
    }

    this.stopWatching(session.id);
    this.runtimes.clearEphemeral(session.id);
    let ended: BoundSession = { ...releasing, status: 'ended', updatedAt: nowIso(), isWorking: false, pid: undefined };
    this.db.boundSessions.upsert(ended);
    if (session.manualSuspendedAt) ended = this.db.boundSessions.setManualSuspendedAt(session.id, undefined) ?? ended;
    if (session.pressureSuspendedAt) ended = this.db.boundSessions.setPressureSuspendedAt(session.id, undefined) ?? ended;
    if (session.idleSuspendedAt) ended = this.db.boundSessions.setIdleSuspendedAt(session.id, undefined) ?? ended;
    if (session.conversationRef.startsWith('pending:')) {
      const pending = this.db.pendingConversations.get(session.conversationRef);
      if (removePendingConversation) {
        this.db.pendingConversations.delete(session.conversationRef);
      } else if (pending) {
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
    let session = this.mustGetSession(sessionId);
    if (session.manualSuspendedAt || session.pressureSuspendedAt || session.idleSuspendedAt) return undefined;
    if (session.conversationRef.startsWith('pending:')) {
      const registered = this.assignmentForSession(session);
      if (registered && (session.launchContext || this.hasRecordedPendingUserInput(session)))
        await this.adoptRegisteredSession(sessionId, session.provider, registered.nativeSessionId);
      session = this.mustGetSession(sessionId);
    }
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    const liveSession = liveness === 'dead'
      ? await this.runtimes.run(sessionId, 'restoreSessionForScreen', async () => {
          const current = this.mustGetSession(sessionId);
          if (current.status === 'error' || current.manualSuspendedAt || current.pressureSuspendedAt || current.idleSuspendedAt) {
            return undefined;
          }
          return await this.refreshSessionState(current, { restoreMissing: true });
        })
      : await this.refreshSessionState(session, { restoreMissing: false });
    if (!liveSession) {
      return undefined;
    }
    const snapshot = await this.tmuxClient.capturePane(liveSession.tmuxSessionName, options.startLine).catch(() => '');
    const rawScreen = parseSessionScreenSnapshot(snapshot, nowIso());
    this.confirmClaudeResponseFromScreen(this.mustGetSession(liveSession.id), rawScreen);
    const screen = this.decorateScreenForSession(liveSession, rawScreen);
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
    options: { restoreMissing?: boolean; resumeSuspension?: boolean; resumeIdle?: boolean } = {},
  ): Promise<BoundSession | undefined> {
    let session = this.db.boundSessions.getById(staleSession.id);
    if (!session || session.status === 'ended' || ((session.manualSuspendedAt || session.pressureSuspendedAt) && !options.resumeSuspension)
      || (session.idleSuspendedAt && !options.resumeSuspension && !options.resumeIdle)) {
      return undefined;
    }
    const restoreMissing = options.restoreMissing ?? true;
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
    session = this.db.boundSessions.getById(staleSession.id);
    if (!session || session.status === 'ended' || ((session.manualSuspendedAt || session.pressureSuspendedAt) && !options.resumeSuspension)
      || (session.idleSuspendedAt && !options.resumeSuspension && !options.resumeIdle)) {
      return undefined;
    }
    if (liveness === 'unknown') {
      return session;
    }
    if (liveness === 'dead') {
      if (!options.resumeSuspension && this.isFinishedLaunchedSession(session)) {
        await this.archiveFinishedExitedSession(session.id);
        return undefined;
      }
      if (restoreMissing && session.shouldRestore && this.unattendedAssignment(session)
        && (session.pid !== undefined || session.runFailure?.code === 'process_exited')
        && !session.idleSuspendedAt && session.status !== 'releasing') {
        // Unfinished unattended sessions use the durable backed-off controller.
        // Reconciliation and browser polling cannot launch them in a hot loop.
        await this.runRecovery.processExited(session.id);
        return undefined;
      }
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
        return await this.restoreSession(session, options.resumeSuspension === true);
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

    // A restart may land after tmux creation but before the restore commit.
    // An intentional wake can adopt that owned writer instead of staying asleep.
    if (session.idleSuspendedAt) {
      if (await this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id').catch(() => undefined) !== session.id) return undefined;
      const pid = await this.tmuxClient.getPanePid(session.tmuxSessionName).catch(() => undefined);
      if (pid === undefined) return undefined;
      this.updateBoundSessionFields(session.id, { pid, updatedAt: nowIso() });
      session = this.db.boundSessions.setIdleSuspendedAt(session.id, undefined)!;
      this.suspensionGraceUntilMs.set(session.id, Date.now() + this.restoreGraceMs);
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
    await this.tryEnsurePaneSize(refreshed);
    await this.verifyNativeProcessEpoch(refreshed);
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
      const assignment = this.assignmentForSession(session);
      if (assignment) setPeerWakePaused(this.db, assignment.id, false);
      this.db.meta.set(peerWakeComposerKey(session.id), '');
      this.db.meta.set(`human-input:${session.id}`, JSON.stringify({ id: messageId, text: event.text, timestamp: event.timestamp }));
      (this.runtimeState(session.id).lastUserInput ??= new LastUserInputCache(this.readLastUserInput)).record(session.eventLogPath, event.text);
      this.eventBus.emit({
        type: 'session.user-input',
        sessionId: session.id,
        projectSlug: session.projectSlug,
        provider: session.provider,
        conversationRef: session.conversationRef,
        messageId,
        ...imagePromptDisplay(event.text),
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

  private assertInteractiveChatInputAllowed(session: BoundSession, screen: SessionScreen, payload: KeystrokeSendPayload): void {
    const text = payload.submittedText?.trim() || payload.text?.trim();
    if (!payload.keys?.length || !text || screen.inputActive
      || !screenShowsInteractiveSelectionHint(screen)
      || (screenAllowsLiteralSelectionTokenWithoutInput(screen, text)
        && screenAllowsLiteralSelectionTokenWithoutInput(screen, payload.text))) return;

    this.logger?.warn({
      sessionId: session.id,
      provider: session.provider,
      textLength: text.length,
      keys: payload.keys,
      rejectionReason: 'interactive_input',
    }, 'Live chat input blocked by an interactive selection; session retained.');
    this.appendDebugTrace(session, {
      action: 'send-keystrokes-blocked-interactive',
      text,
      keys: payload.keys,
      before: screen,
      after: screen,
    });
    const providerLabel = session.provider === 'claude' ? 'Claude' : 'Codex';
    throw new SessionKeystrokeRejectedError(`${providerLabel} is waiting for an approval or menu selection. Answer it in the live session before resending your message. The draft was not submitted.`);
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
      `  before.tail=${JSON.stringify(input.before.content.split('\n').slice(-12))}`,
      `  after.input=${JSON.stringify(input.after.inputText)}`,
      `  after.status=${JSON.stringify(input.after.status)}`,
      `  after.tail=${JSON.stringify(input.after.content.split('\n').slice(-12))}`,
      '',
    ].join('\n');
    fs.appendFileSync(debugLogPath, lines);
  }

  private watchSessionOutput(session: BoundSession): void {
    if (!this.shouldWatchSession(session)) {
      return;
    }

    this.watchSessionTranscript(session);
    const state = this.runtimeState(session.id);
    void (state.lastUserInput ??= new LastUserInputCache(this.readLastUserInput)).read(session.eventLogPath);

    if (session.rawLogPath && !this.outputWatchers.has(session.id)) {
      const initialOffset = session.eventLogPath && fs.existsSync(session.eventLogPath) && fs.statSync(session.eventLogPath).size > 0 && fs.existsSync(session.rawLogPath)
        ? fs.statSync(session.rawLogPath).size
        : 0;
      this.outputWatchers.watch({
        sessionId: session.id,
        rawLogPath: session.rawLogPath,
        initialOffset,
        onChunk: (chunk) => { void this.flushPendingChunk(session.id, chunk); },
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
    const state = this.runtimeState(sessionId);
    state.rawOutputGeneration = (state.rawOutputGeneration ?? 0) + 1;
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
    try {
      const prior = this.mustGetSession(sessionId);
      const state = this.runtimeState(sessionId);
      const cache = state.lastUserInput ??= new LastUserInputCache(this.readLastUserInput);
      const cached = cache.current(prior.eventLogPath);
      const arrivedAt = nowIso();
      const shouldTrackOnArrival = this.shouldTrackRawOutputForRecency(prior);
      const generation = state.rawOutputGeneration ?? 0;
      const waited = Boolean(state.rawOutputFlush) || !cached;
      const flush = () => this.flushChunkInOrder(prior, state, cache, cached,
        chunk, arrivedAt, shouldTrackOnArrival, generation, waited);
      // Calling the first warm flush runs it synchronously. A cold flush keeps
      // subsequent batches in arrival order even if new input warms the cache.
      const next = state.rawOutputFlush ? state.rawOutputFlush.then(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await flush();
      }) : flush();
      state.rawOutputFlush = next;
      void next.finally(() => {
        if (state.rawOutputFlush === next) state.rawOutputFlush = undefined;
      }).catch(() => undefined);
    } catch {
      // A released session cannot consume output from its old watcher.
    }
  }

  private async flushChunkInOrder(
    prior: BoundSession,
    state: SessionRuntimeState,
    cache: LastUserInputCache,
    cached: { text?: string } | undefined,
    chunk: string,
    arrivedAt: string,
    shouldTrackOnArrival: boolean,
    generation: number,
    waited: boolean,
  ): Promise<void> {
    const sessionId = prior.id;
    try {
      const lastInput = cached ? cached.text : await cache.read(prior.eventLogPath);
      if (!this.runtimes.has(sessionId) || this.runtimeState(sessionId) !== state) return;
      if ((state.rawOutputGeneration ?? 0) !== generation) return;
      const session = this.mustGetSession(sessionId);
      if (session.eventLogPath !== prior.eventLogPath) return;
      // stop() deliberately flushes a warm watcher after marking the manager
      // stopped. Preserve that synchronous final append; only deferred work
      // needs to re-check lifecycle admission.
      if (waited && !this.shouldWatchSession(session)) return;
      const now = nowIso();
      const outputLines = normalizeRawOutputLines(chunk, lastInput);
      const hasMeaningfulOutput = outputLines.length > 0;
      const shouldTrackOutput = shouldTrackOnArrival && hasMeaningfulOutput && this.shouldTrackRawOutputForRecency(session);
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
        this.appendEvent(updated, { type: 'raw-output', text: chunk, timestamp: arrivedAt });
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
    const run = this.runRecovery.getRunState(session.id);
    if (session.provider === 'claude' && run?.status === 'completed') {
      void this.confirmClaudeResponse(session.id, run).catch((error: unknown) => {
        this.logger?.warn({ err: error, sessionId: session.id }, 'Failed to confirm Claude prompt readiness.');
      });
    }
    this.syncSessionWorkingState(this.mustGetSession(session.id), {
      screenShowsWorking: sessionScreenShowsWorking(screen), capturedAt: screen.capturedAt,
    });
    const currentSession = this.mustGetSession(session.id);
    this.queueClaudeFolderTrustAcceptance(currentSession, screen);
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

  private async resumeFullClaudeSessionForPeerWake(session: BoundSession, initialScreen: SessionScreen): Promise<SessionScreen> {
    const key = peerResumeAttemptKey(session);
    if (this.db.meta.get(key)) throw new Error('A previous automatic Claude resume confirmation was already attempted. Resume the original session explicitly.');
    const save = (status: PeerWakeAttempt['status'], reason?: string) => this.db.meta.set(key,
      JSON.stringify({ status, sessionId: session.id, timestamp: nowIso(), reason } satisfies PeerWakeAttempt));
    const verifyOwnership = async () => {
      const current = this.db.boundSessions.getById(session.id);
      const [owner, pid] = await Promise.all([
        this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id'),
        this.tmuxClient.getPanePid(session.tmuxSessionName),
      ]);
      if (this.stopped || !current || this.getCurrentRestorableSession(current)?.id !== session.id
        || current.manualSuspendedAt || current.pressureSuspendedAt || current.modelProfileRequest
        || !session.pid || current.pid !== session.pid || owner !== session.id || pid !== session.pid) {
        throw new Error('Session ownership or availability changed before confirming the original Claude session resume.');
      }
    };
    let screen = initialScreen;
    await verifyOwnership();
    screen = await this.captureSessionScreen(session, false);
    let selection = claudeFullSessionResumeSelection(screen);
    if (selection === undefined) return screen;
    // This control confirmation has its own durable attempt. A failed or
    // interrupted Enter must never later reach the conversation composer.
    try {
      if (selection !== 'full') {
        save('submitting');
        await this.tmuxClient.sendKeys(session.tmuxSessionName, [selection === 'summary' ? 'Down' : 'Up']);
        screen = await this.waitForScreenMatch(session, hashScreen(screen), TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS,
          (candidate) => claudeFullSessionResumeSelection(candidate) === 'full') ?? screen;
      }
      await verifyOwnership();
      screen = await this.captureSessionScreen(session, false);
      selection = claudeFullSessionResumeSelection(screen);
      if (selection !== 'full') throw new Error('Claude full-session resume could not be selected. No peer notice was submitted.');
      save('submitting');
      await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Enter']);
      save('submitted');
      screen = await this.waitForScreenMatch(session, hashScreen(screen), CLAUDE_RESUME_READY_WAIT_MS,
        (candidate) => claudeFullSessionResumeSelection(candidate) === undefined) ?? screen;
      this.appendEvent(session, { type: 'status', text: 'Resumed the full original Claude session for peer messages.', timestamp: nowIso() });
      this.publishScreenUpdate(session, screen);
      return screen;
    } catch (error) {
      if (this.db.meta.get(key)) save('failed', error instanceof Error ? error.message : 'Claude resume confirmation failed.');
      throw error;
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

    screen = await this.acceptClaudeFolderTrust(session, screen);

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

  private queueClaudeFolderTrustAcceptance(session: BoundSession, screen: SessionScreen): void {
    if (this.stopped || session.provider !== 'claude' || claudeFolderTrustSelection(screen) === undefined) return;
    const state = this.runtimeState(session.id);
    if (state.claudeFolderTrustPending) return;
    state.claudeFolderTrustPending = true;
    void this.runtimes.run(session.id, 'acceptClaudeFolderTrust', async () => {
      if (this.stopped || !this.db.isOpen()) return;
      const current = this.db.boundSessions.getById(session.id);
      if (!current || current.status !== 'bound' || current.manualSuspendedAt || current.pressureSuspendedAt) return;
      await this.acceptClaudeFolderTrust(current, await this.captureSessionScreen(current));
    }).catch((error: unknown) => {
      if (!this.stopped) this.logger?.warn({ err: error, sessionId: session.id }, 'Failed to accept Claude folder trust.');
    }).finally(() => { state.claudeFolderTrustPending = false; });
  }

  private async acceptClaudeFolderTrust(session: BoundSession, initialScreen: SessionScreen): Promise<SessionScreen> {
    if (session.provider !== 'claude' || claudeFolderTrustSelection(initialScreen) === undefined) return initialScreen;
    const verifyOwnership = async () => {
      const [owner, pid] = await Promise.all([
        this.tmuxClient.getOption(session.tmuxSessionName, '@agent_console_session_id'),
        this.tmuxClient.getPanePid(session.tmuxSessionName),
      ]);
      if (owner !== session.id || !session.pid || pid !== session.pid) {
        throw new SessionKeystrokeRejectedError('Session ownership changed before accepting Claude folder trust. The draft was not submitted.');
      }
    };
    await verifyOwnership();
    let screen = await this.captureSessionScreen(session);
    let selection = claudeFolderTrustSelection(screen);
    if (selection === undefined) return screen;
    if (selection === 'exit') {
      await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Down']);
      screen = await this.waitForScreenMatch(session, hashScreen(screen), TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS,
        (candidate) => claudeFolderTrustSelection(candidate) === 'accept') ?? screen;
    }
    await verifyOwnership();
    screen = await this.captureSessionScreen(session);
    selection = claudeFolderTrustSelection(screen);
    if (selection !== 'accept') {
      throw new SessionKeystrokeRejectedError('Claude folder trust could not be selected. The draft was not submitted.');
    }
    await this.tmuxClient.sendKeys(session.tmuxSessionName, ['Enter']);
    screen = await this.waitForScreenMatch(session, hashScreen(screen), CLAUDE_FOLDER_TRUST_WAIT_MS,
      (candidate) => screenLooksReadyForLiteralPrompt(candidate)
        || (claudeFolderTrustSelection(candidate) === undefined && screenShowsInteractiveSelectionHint(candidate))) ?? screen;
    if (!screenLooksReadyForLiteralPrompt(screen)
      && !(claudeFolderTrustSelection(screen) === undefined && screenShowsInteractiveSelectionHint(screen))) {
      throw new SessionKeystrokeRejectedError('Claude did not finish folder-trust startup. The draft was not submitted.');
    }
    this.appendEvent(session, { type: 'status', text: 'Accepted Claude folder trust for this Console project.', timestamp: nowIso() });
    this.publishScreenUpdate(session, screen);
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
    await this.verifyNativeProcessEpoch(session);
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
