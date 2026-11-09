import { assignmentTask, dispatchEligible } from '../coordination/tasks.js';
import fs from 'node:fs';
import { imagePromptDisplay, imagePromptFiles } from '../images/prompt.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_ROUTED_PROMPTS, PROVIDER_NAMES, PROVIDERS, visibleModelMatchesTarget, type AgentLaunchContext, type AutoDecision, type AutoRoute, type BoundSession, type ConversationSummary, type ModelTarget, type ModelProfileDeferredReason, type ModelProfileKey, type ModelProfileRequest, type PendingRequestSummary, type ProviderId, type RecordedUserInput, type SessionEvent, type SessionInputResponse, type SessionModelProfileResponse, type SessionRequestResponse, type SessionScreen } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { ModelProfileService, ModelProfilesUnavailableError, ROUTE_TASK_MAX_CHARS, composeRerouteTask, fallbackDecision, peekSessionModelTarget, rowProfile, sessionModelTarget } from '../model-profiles/service.js';
import { AppDatabase } from '../db/database.js';
import type { ActiveProject } from '../projects/project-service.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { ProviderRunState } from '../providers/types.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { TransportPluginRegistry } from '../providers/transport/registry.js';
import { NotSentError, PreviousTurnActiveError, SendRejectedError, type LineTransportFactory, type PluginContext, type ProviderFailure } from '../providers/transport/types.js';
import { terminateHost } from '../providers/transport/line-transport.js';
import {
  StructuredBusyError,
  StructuredRequestNotPendingError,
  StructuredSessionService,
  StructuredUnavailableError,
  StructuredUnsupportedError,
  structuredStatusReason,
  type StructuredSessionsConfig,
  type StructuredSessionState,
  type StructuredTerminalStatus,
} from './structured/structured-session-service.js';
import { StructuredRunMonitor } from './structured/structured-run-monitor.js';
import { STRUCTURED_REQUESTS_KEY_PREFIX, type StructuredQuestionNotice } from './structured/pending-requests.js';
import {
  adoptPendingConversation,
  clearPendingRestoreBinding as clearPendingConversationRestoreBinding,
} from './pending-adoption.js';
import { nextIdleExpiryDecision, nextWorkingState } from './working-state.js';
import { RecoverySubmitDeferredError, RecoverySubmitRejectedError, RunRecovery } from './run-recovery.js';
import { TranscriptWatcherRegistry } from './transcript-watcher.js';
import { SessionRuntimeRegistry, type SessionRuntimeState } from './session-runtime.js';
import { InputQueue, queuedInputSummary, type QueuedInputRecord } from './input-queue.js';
import { endTmuxSession } from './tmux-row-conversion.js';
import type { ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import { PEER_WAKE_PROMPT, UNATTENDED_CONTINUATION_PROMPT, GRANTED_RESTART_PROMPT, peerWakeAttemptKey, peerWakeFollowupKey, peerWakePaused, setPeerWakePaused, peerWakeRestoreKey, peerWakePauseDetailsKey, type PeerWakeAttempt, type WakeBlock, type AutomaticInputPause } from '../coordination/wake.js';
import { expireMessages, messagePolicy, migrateMessagePolicies } from '../coordination/inbox-policy.js';
import { alertOverdueAwait, continuationControl, CONTINUATION_DELAYS_MS, pendingContinuation, prepareContinuation, saveContinuation, setContinuation, signalContinuation } from '../coordination/continuation.js';

const SESSION_COMPLETION_IDLE_MS = 60_000;
/** A queued message that the transport keeps refusing before it writes anything fails after this long. */
const STRUCTURED_NOT_SENT_LIMIT_MS = 10 * 60_000;
/** A provider process that runs but does not answer a survivor lookup this many times in a row is reported on the conversation. */
const SURVIVOR_BUSY_REPORT_AFTER = 3;
/** A session host that keeps not answering for this long is taken as lost: its row settles the way a dead connection settles it. */
const SURVIVOR_BUSY_LIMIT_MS = 10 * 60_000;

function activeModelProfile(session: BoundSession): ModelProfileKey | undefined {
  return rowProfile(session);
}

/** The target a profile switch applies, in the words the status lines use. */
interface AppliedModel extends ModelTarget {
  label?: string;
}

export function profilePatch(provider: ProviderId, profile: ModelProfileKey | undefined) {
  if (provider === 'codex') return { codexProfile: profile };
  if (provider === 'grok') return { grokProfile: profile };
  if (provider === 'vibe') return { vibeProfile: profile };
  return { claudeProfile: profile };
}

/** The profile a bind asked for, from the field that belongs to the provider. */
function requestedProfileOf(providerId: ProviderId, input: { codexProfile?: ModelProfileKey; claudeProfile?: ModelProfileKey; grokProfile?: ModelProfileKey; vibeProfile?: ModelProfileKey }): ModelProfileKey | undefined {
  if (providerId === 'codex') return input.codexProfile;
  if (providerId === 'grok') return input.grokProfile;
  if (providerId === 'vibe') return input.vibeProfile;
  return input.claudeProfile;
}

/** The status line that records an Auto choice made when a chat was started. */
function autoChoiceText(decision: AutoDecision): string {
  if (decision.source === 'fallback') return decision.warning ?? 'Auto fell back to the default model.';
  const model = decision.label ? `${decision.label}, ${decision.effort ?? 'default effort'}` : 'no model change yet';
  return `Auto chose ${model}${decision.reason ? `: ${decision.reason}` : '.'}`;
}

/**
 * The Auto state a routing leaves on the row. `routed` counts the prompts routed since A was selected, this one included. The
 * prompt after the first is always checked once more, with the conversation so far; after that the choice is final unless it is
 * still provisional, and three routed prompts in all end it whatever the answer. A choice the person asked for in their message (a
 * level or a thinking level) is final at once, so a later check cannot quietly undo it.
 */
function autoRouteFor(decision: AutoDecision, prompt: string, routed: number): AutoRoute {
  const asked = decision.level !== undefined || decision.requestedEffort !== undefined;
  const more = !asked && routed < MAX_ROUTED_PROMPTS && (routed === 1 || decision.provisional === true);
  if (!more) return { routePending: false, decision: decision.provisional === true ? { ...decision, provisional: false } : decision };
  return { routePending: true, decision, routedPrompts: routed, previousPrompt: prompt.slice(0, ROUTE_TASK_MAX_CHARS) };
}

function describeAppliedModel(applied: AppliedModel | undefined): string {
  return applied ? `${applied.label ?? applied.model}, ${applied.effort}` : 'no model change yet';
}
const SESSION_RECONCILIATION_INTERVAL_MS = 30_000;
const SESSION_RECONCILIATION_INITIAL_DELAY_MS = 5_000;
const AUTO_TRACK_CONCURRENCY = 2;
// Restoring a session does not move recency, so a freshly restored idle session
// gets this long before the reaper may suspend it again.
const DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS = 60 * 60 * 1000;
// Purple starts after 48 hours; retain that state for seven full days before release.
const WORK_SESSION_RELEASE_MS = (48 + 7 * 24) * 60 * 60 * 1000;
const SESSION_NOT_RUNNING_INPUT_MESSAGE = 'Session is no longer running. Rebind or restore the conversation before sending input.';
const RESTORE_FAILURE_STATUS_TAIL_BYTES = 64 * 1024;
// A message that is only a command word ("/model", "/compact"). A sentence that starts with a path ("/tmp is full") is ordinary text.
const STRUCTURED_SLASH_COMMAND = /^\/[A-Za-z][\w:-]*$/;
interface SessionRecoveryDependencies {
  projectService: Pick<ProjectService, 'getProjectBySlug' | 'getMergedProviderSettings'>;
  providerRegistry: Pick<ProviderRegistry, 'get'>;
}

interface SessionManagerOptions {
  /** Reads the Ultra/High/Medium/Low profiles and asks the Auto router. Omitted: a service on the configured `wo` path. */
  modelProfiles?: ModelProfileService;
  coordinationEnabled?: boolean;
  restoreGraceMs?: number;
  pressureSuspendAvailableBytes?: number;
  pressureSuspendIdleMs?: number;
  readMemInfo?: () => string;
  hasActiveLaunchAuthority?: (session: BoundSession) => boolean;
  launchAuthorityContext?: (context: AgentLaunchContext) => string | undefined;
  /** Transport plugins for provider sessions; none are registered by default. */
  transportPlugins?: TransportPluginRegistry;
  /** Per-provider structured-session settings. A provider without an enabled entry cannot bind conversations. */
  structuredSessions?: StructuredSessionsConfig;
  /** Environment every provider process gets (coordination runtime and config path); the provider's own `env` wins. */
  structuredEnv?: Record<string, string>;
  /** Opens line channels to provider processes (session hosts that outlive the backend). Without it a plugin runs its child directly over stdio. */
  lineTransport?: LineTransportFactory;
  /** Called when an agent asks a question, so the person can be told even with the browser closed. */
  notifyStructuredQuestion?: (notice: StructuredQuestionNotice) => void | Promise<unknown>;
  /**
   * The directory pasted images are stored in. A message attaches only files that sit directly in it; without it no message can
   * carry an image.
   */
  imageStoreDir?: string;
  /**
   * Ends the hidden tmux session of a row an earlier build left on the tmux transport (the startup conversion). Tests replace it so
   * that no real tmux server is touched.
   */
  endTmuxSession?: (sessionName: string) => void;
}

/** A `/keys` request: a complete message with Enter (queued when it has a submission id), or Escape alone for Stop. */
export interface KeystrokeSendPayload {
  submissionId?: string;
  text?: string;
  keys?: string[];
  submittedText?: string;
}

type SessionEventLogEntry = { type: 'user-input' | 'agent-input' | 'status'; text: string; timestamp: string };

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

/** The request id is not waiting for an answer on this session (answered, withdrawn or unknown). Routes answer 404. */
export class StructuredRequestNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = 'That request is no longer waiting for an answer.') {
    super(message);
    this.name = 'StructuredRequestNotFoundError';
  }
}

/**
 * The stored image files a prompt names, as a transport takes them; none when the prompt has no images. Only files directly in
 * the image store count, so a path typed into a message cannot become an attachment.
 */
function structuredImages(text: string, storeDir: string | undefined): Array<{ path: string; mimeType: string }> | undefined {
  const files = storeDir ? imagePromptFiles(text, storeDir) : [];
  return files.length ? files : undefined;
}

/** A bind was requested for a provider whose lane is off (`structuredSessions.<provider>.enabled`). Routes answer 400. */
export class StructuredSessionDisabledError extends Error {
  readonly statusCode = 400;

  constructor(provider: ProviderId) {
    super(`Conversations are not enabled for ${provider}: structuredSessions.${provider}.enabled is off.`);
    this.name = 'StructuredSessionDisabledError';
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

interface SessionManagerLogger {
  warn(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
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

/**
 * Owns every bound conversation. Each one runs on the structured transport: a provider protocol (Codex app-server, Claude
 * headless stream-json) behind a transport plugin, driven through `StructuredSessionService`. The manager keeps the row's
 * lifecycle (bind, restore, sleep, release), its input journal, recency, recovery and coordination wakes.
 */

export class SessionManager {
  private readonly transcriptWatchers = new TranscriptWatcherRegistry();
  private readonly runRecovery: RunRecovery;
  private readonly unsubscribeRealtimeEvents: () => void;
  private readonly runtimes: SessionRuntimeRegistry;
  private readonly structured: StructuredSessionService;
  private readonly structuredMonitors = new Map<string, StructuredRunMonitor>();
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
  private readonly autoRoutings = new Map<string, Promise<void>>();
  private readonly autoTrackLaunchQueue: Array<() => void> = [];
  private readonly restoreGraceMs: number;
  private readonly pressureSuspendAvailableBytes?: number;
  private readonly pressureSuspendIdleMs: number;
  private readonly readMemInfo: () => string;
  private consecutiveLowMemorySamples = 0;
  private autoTrackActiveLaunches = 0;
  private reconciliationRun?: Promise<void>;
  private assignmentWakeRun?: Promise<void>;
  private wakeRequested = false;
  private readonly coordinationEnabled: boolean;
  /** Set once coordination exists. A provider with no session-start hook (Vibe) calls it after its process is up. */
  private conversationRegistrar?: PluginContext['registerConversation'];
  private readonly hasActiveLaunchAuthority?: (session: BoundSession) => boolean;
  private readonly notifyStructuredQuestion?: (notice: StructuredQuestionNotice) => void | Promise<unknown>;
  /** The model list shared with the web routes and granted launches: profiles come from here, never from a table in this repo. */
  readonly modelProfiles: ModelProfileService;
  private readonly imageStoreDir?: string;
  private stopped = false;
  /** Set once the startup pass has looked for provider processes that outlived the previous backend. */
  private survivorsReattached = false;
  /** Rows whose last survivor lookups found a session host that runs but did not answer in time: when the run began and how many lookups it spans. */
  private readonly survivorBusyRuns = new Map<string, { since: number; attempts: number }>();

  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeDir: string,
    private readonly eventBus: RealtimeEventBus,
    private readonly recoveryDependencies?: SessionRecoveryDependencies,
    private readonly logger?: SessionManagerLogger,
    options: SessionManagerOptions = {},
  ) {
    this.coordinationEnabled = options.coordinationEnabled ?? false;
    if (this.coordinationEnabled) migrateMessagePolicies(db);
    this.hasActiveLaunchAuthority = options.hasActiveLaunchAuthority;
    this.notifyStructuredQuestion = options.notifyStructuredQuestion;
    this.modelProfiles = options.modelProfiles ?? new ModelProfileService({}, undefined, logger);
    this.imageStoreDir = options.imageStoreDir;
    this.restoreGraceMs = options.restoreGraceMs ?? DEFAULT_SESSION_IDLE_RESTORE_GRACE_MS;
    this.pressureSuspendAvailableBytes = options.pressureSuspendAvailableBytes;
    this.pressureSuspendIdleMs = options.pressureSuspendIdleMs ?? 60 * 60 * 1000;
    this.readMemInfo = options.readMemInfo ?? (() => fs.readFileSync('/proc/meminfo', 'utf8'));
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
    // A question waits on a provider connection, and every connection of an earlier backend process is gone.
    db.sqlite.prepare('delete from meta where key like ?').run(`${STRUCTURED_REQUESTS_KEY_PREFIX}%`);
    const structuredMeta: PluginContext['meta'] = {
      get: (key) => this.db.meta.get(key) || undefined,
      set: (key, value) => this.db.meta.set(key, value),
      delete: (key) => { this.db.sqlite.prepare('delete from meta where key = ?').run(key); },
    };
    const hosts = {
      runtimeDir: this.runtimeDir,
      log: { info: (bindings: object, message: string) => this.logger?.info?.(bindings, message), warn: (bindings: object, message: string) => this.logger?.warn(bindings, message) },
    };
    this.structured = new StructuredSessionService({
      registry: options.transportPlugins ?? new TransportPluginRegistry(),
      targets: {
        resolve: (session) => sessionModelTarget(this.modelProfiles, session),
        peek: (session) => peekSessionModelTarget(this.modelProfiles, session),
      },
      config: options.structuredSessions ?? {},
      hostEnv: options.structuredEnv,
      authorityContext: options.launchAuthorityContext,
      meta: structuredMeta,
      logger: this.logger ? { warn: (bindings, message) => this.logger?.warn(bindings, message) } : undefined,
      hosts,
      createContext: (pluginId) => {
        const pluginRuntimeDir = path.join(this.runtimeDir, 'structured', pluginId);
        fs.mkdirSync(pluginRuntimeDir, { recursive: true });
        return {
          runtimeDir: pluginRuntimeDir,
          // The Console's coordination runtime and helper. A shared process serves every thread, so the identity has no session
          // id here; a per-session plugin gets its conversation's id with `OpenOptions.consoleIdentity`.
          ...(this.coordinationEnabled ? { coordination: { runtimeDir: this.runtimeDir, helperPath: this.coordinationHelperPath() } } : {}),
          ...(this.coordinationEnabled ? { registerConversation: (input) => this.conversationRegistrar?.(input) ?? Promise.resolve() } : {}),
          log: {
            info: (bindings, message) => this.logger?.info?.(bindings, message),
            warn: (bindings, message) => this.logger?.warn(bindings, message),
          },
          meta: structuredMeta,
          ...(options.lineTransport ? { lineTransport: options.lineTransport, endHost: (hostId, graces) => terminateHost(hosts.runtimeDir, hostId, hosts.log, graces) } : {}),
        };
      },
      callbacks: {
        onTurnStarted: (sessionId, turnId, origin, replay, adopted) => this.handleStructuredTurnStarted(sessionId, turnId, origin, replay, adopted),
        onItemCompleted: (sessionId, at, replay) => this.handleStructuredItemCompleted(sessionId, at, replay),
        onTurnTerminal: (sessionId, turnId, status, failure, replay) => this.handleStructuredTurnTerminal(sessionId, turnId, status, failure, replay),
        onRequest: (sessionId, kind, summary) => this.appendStructuredStatus(sessionId, kind === 'question'
          // A question that cannot be shown can hold something secret, and a question's text stays out of the log; the server log has the details.
          ? 'Declined a question the Console cannot show' : `Declined a provider request: ${summary}`),
        onQuestion: (sessionId, request, options) => this.handleStructuredQuestion(sessionId, request, options),
        onRequestsChanged: (sessionId) => this.publishStructuredRequests(sessionId),
        onSessionState: (sessionId, state, failure) => this.handleStructuredSessionState(sessionId, state, failure),
        appendStatus: (sessionId, text) => this.appendStructuredStatus(sessionId, text),
      },
    });
    this.runRecovery = new RunRecovery({
      db: this.db,
      runExclusive: (id, fn) => this.runtimes.run(id, 'runRecovery', fn),
      mayRecover: (session) => this.hasUnattendedWork(session),
      canRetry: async (session) => {
        if (this.stopped || this.getCurrentRestorableSession(session)?.id !== session.id
          || (session.status !== 'bound' && !(session.status === 'error' && session.runFailure?.code === 'process_exited'))) return 'This session no longer owns the conversation.';
        if (!this.hasUnattendedWork(session)) return 'Unattended recovery requires unfinished work.';
        const assignment = this.db.sqlite.prepare('select status from coordination_assignments where provider=? and native_session_id=?')
          .get(session.provider, session.conversationRef) as { status: string } | undefined;
        if (assignment?.status === 'finished') return 'This assignment is finished.';
        if (session.manualSuspendedAt || session.pressureSuspendedAt || session.idleSuspendedAt || session.queuedInputs?.length || session.modelProfileRequest) return 'This session is paused or has a pending model change.';
        const available = this.availableMemoryBytes();
        if (this.pressureSuspendAvailableBytes !== undefined
          && (available === undefined || available < this.pressureSuspendAvailableBytes)) return 'Recovery is stopped while available memory is below the configured threshold.';
        const project = await this.recoveryDependencies?.projectService.getProjectBySlug(session.projectSlug);
        if (!project || !this.recoveryDependencies?.projectService.getMergedProviderSettings(project, session.provider).enabled) return 'This provider or project is no longer enabled.';
        // The conversation must be loaded on a live connection with no turn running; reload it after an exit.
        if (!this.structured.alive(session) && !await this.restoreSession(session)) return 'The original provider conversation could not be restored.';
        if (this.structured.turnRunning(session)) return 'The provider is running a turn.';
        return this.hasUnattendedWork(session) ? undefined : 'Unattended recovery requires unfinished work.';
      },
      submit: async (session, text, isCurrent) => {
        const ownsRecovery = () => {
          const current = this.db.boundSessions.getById(session.id);
          const assignment = this.db.sqlite.prepare('select status from coordination_assignments where provider=? and native_session_id=?')
            .get(session.provider, session.conversationRef) as { status: string } | undefined;
          const available = this.pressureSuspendAvailableBytes === undefined ? undefined : this.availableMemoryBytes();
          return isCurrent() && !this.stopped && this.getCurrentRestorableSession(session)?.id === session.id
            && this.hasUnattendedWork(session)
            && current?.status === 'bound' && !current.manualSuspendedAt && !current.pressureSuspendedAt && !current.idleSuspendedAt && !current.modelProfileRequest && !current.queuedInputs?.length
            && assignment?.status !== 'finished'
            && (this.pressureSuspendAvailableBytes === undefined || (available !== undefined && available >= this.pressureSuspendAvailableBytes));
        };
        if (!ownsRecovery()) throw new Error('Recovery was cancelled or conversation ownership changed before submission.');
        const delivery = await this.structured.deliverAutomatic(this.mustGetSession(session.id), text);
        // Deferred means nothing was sent (not loaded, a turn running, or the transport's NotSentError): not an uncertain outcome.
        if (delivery.status === 'deferred') throw new RecoverySubmitDeferredError(delivery.reason);
        // Rejected also sent nothing, but trying again fails the same way: the conversation says why, whatever the stop that follows says.
        if (delivery.status === 'rejected') {
          const reason = `Automatic recovery was not sent, and sending it again would fail the same way: ${delivery.reason}`;
          this.appendStructuredStatus(session.id, reason);
          throw new RecoverySubmitRejectedError(reason);
        }
        if (delivery.status !== 'submitted') throw new Error(delivery.reason ?? 'The session did not accept the recovery prompt.');
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
        // A cleared failure no longer holds the working state down, and nothing else would notice.
        if (session.status === 'bound') this.syncSessionWorkingState(session, { capturedAt: nowIso() });
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
          if (run.status === 'completed') this.recordProviderResponse(session, run);
          else this.syncSessionWorkingState(session, { capturedAt: nowIso() });
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
    // Before anything reads the rows: a row an earlier build left on the tmux transport would otherwise be resumed beside its
    // still-running tmux process.
    this.convertTmuxRows(options.endTmuxSession ?? endTmuxSession);
    for (const session of this.db.boundSessions.list()) {
      for (const record of this.inputQueue.list(session.id)) {
        // Anything between queued and failed was in flight when the backend stopped.
        if (record.state !== 'queued' && record.state !== 'failed') this.inputQueue.put(session.id, { ...record, state: 'failed',
          reason: 'The server restarted during submission. Check the conversation before sending again.' });
      }
      this.scheduleInputDrain(session.id);
    }
  }

  /**
   * Startup only. Every conversation runs on the structured transport, and a row an earlier build left on tmux moves over before
   * anything reads it, the way the old migration moved a row whose tmux session had ended: its hidden tmux session is ended (best
   * effort, so the old provider process cannot keep writing to the conversation), the plugin is told the conversation has history,
   * and the row becomes a sleeping structured row whose next message resumes the same native conversation. Identity, title and
   * recency do not change. A message that was being typed into the tmux composer is failed: whether it arrived is not known.
   */
  private convertTmuxRows(endSession: (sessionName: string) => void): void {
    for (const { session, tmuxSessionName } of this.db.boundSessions.listTmuxRows()) {
      endSession(tmuxSessionName);
      try {
        this.structured.noteConversationHistory(session);
      } catch (error) {
        // The first reconcile pass writes the record again for every row with a response.
        this.logger?.warn({ err: error, sessionId: session.id }, 'Recording that a converted tmux conversation has history failed.');
      }
      for (const record of this.inputQueue.list(session.id)) {
        if (record.state !== 'queued' && record.state !== 'failed') this.inputQueue.put(session.id, { ...record, state: 'failed',
          reason: 'The conversation moved to the structured transport while this message was being typed. Check the conversation before sending again.' });
      }
      const at = nowIso();
      const converted = this.db.boundSessions.convertTmuxRow(session.id, {
        // A manual or pressure suspension already keeps the row asleep; every other row sleeps until its next message.
        ...(session.manualSuspendedAt || session.pressureSuspendedAt ? {} : { idleSuspendedAt: at }),
        updatedAt: at,
      });
      if (!converted) continue;
      this.appendEvent(converted, { type: 'status', text: 'Moved to the structured transport; the next message resumes this conversation.', timestamp: at });
      this.logger?.info?.({ sessionId: converted.id, provider: converted.provider, projectSlug: converted.projectSlug, tmuxSessionName },
        'Converted a tmux conversation to the structured transport.');
      this.eventBus.emit({ type: 'session.updated', session: converted });
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

  private isFinishedSession(session: BoundSession): boolean {
    return this.assignmentForSession(session)?.status === 'finished';
  }

  private retainFinishedInbox(session: BoundSession): void {
    const current = this.db.boundSessions.getById(session.id);
    const assignment = current && this.assignmentForSession(current);
    if (!current?.shouldRestore || current.status === 'ended' || current.pid !== session.pid || current.startedAt !== session.startedAt
      || assignment?.status !== 'finished'
      // A conversation runs only while it is loaded.
      || this.structured.alive(current)) return;
    this.stopWatching(current.id);
    this.runtimes.clearEphemeral(current.id);
    this.runRecovery.cancel(current.id);
    if (!current.idleSuspendedAt || current.pid !== undefined || current.isWorking)
      this.db.boundSessions.setIdleSuspendedAt(current.id, current.idleSuspendedAt ?? nowIso());
  }

  private unattendedAssignment(session: BoundSession): { id: string; status: string } | undefined {
    if (session.launchContext && this.hasActiveLaunchAuthority && !this.hasActiveLaunchAuthority(session)) return undefined;
    const assignment = this.coordinationEnabled && this.assignmentForSession(session);
    return assignment && assignment.status !== 'finished' && continuationControl(this.db, assignment.id).continuation === 'unattended' ? assignment : undefined;
  }

  private hasUnattendedWork(session: BoundSession): boolean {
    const assignment = this.unattendedAssignment(session);
    return !!assignment && assignmentTask(this.db, assignment.id)?.state !== 'done';
  }

  private pauseAutomaticInput(sessionId: string, code: AutomaticInputPause['code'], reason: string): void {
    const session = this.db.boundSessions.getById(sessionId);
    const assignment = session && this.assignmentForSession(session);
    if (assignment) {
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
    expireMessages(this.db);
    const restorableSessions = this.listRestorableSessions();
    const recipients = this.db.sqlite.prepare(`select distinct a.id, a.provider, a.native_session_id as nativeSessionId,
      a.pid, a.process_start as processStart from coordination_assignments a
      where a.status!='finished' or exists(select 1 from coordination_messages m where m.recipient_id=a.id and m.acknowledged_at is null)`).all() as Array<{
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
          expireMessages(this.db);
          const state = this.db.boundSessions.getById(session.id);
          const retryable = (attempt: PeerWakeAttempt) => attempt.sessionId === state?.id
            && attempt.status === 'deferred' && !!attempt.nextAttemptAt && Date.now() >= Date.parse(attempt.nextAttemptAt);
          const messages = this.db.sqlite.prepare(`select id, supplied_at as suppliedAt from coordination_messages
            where recipient_id=? and acknowledged_at is null order by created_at, id`).all(recipient.id) as Array<{ id: string; suppliedAt: string | null }>;
          const eligible = messages.filter(message => messagePolicy(this.db,message.id).priority === 'P1'
            || (!message.suppliedAt && dispatchEligible(this.db, message.id))).flatMap((message) => {
            const initialKey = peerWakeAttemptKey(message.id), stored = this.db.meta.get(initialKey);
            if (!stored) return [{ id: message.id, key: initialKey }];
            const initial = JSON.parse(stored) as PeerWakeAttempt, key = peerWakeFollowupKey(message.id);
            if (retryable(initial)) return [{ id: message.id, key: initialKey }];
            if (messagePolicy(this.db, message.id).origin === 'dispatch') return []; // Explicit dispatch starts at most one turn.
            const followupText = this.db.meta.get(key);
            if (initial.status === 'submitted' && followupText) {
              return retryable(JSON.parse(followupText) as PeerWakeAttempt) ? [{ id: message.id, key }] : [];
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
          return eligible;
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
        const peerResponse = pending().length > 0;
        if (!peerResponse && ['done', 'blocked'].includes(assignmentTask(this.db, recipient.id)?.state ?? '')) return;
        // Inbox turns do not advance the work budget while delivering the result.
        // Preserve uncertain work submissions as blocked even on an inbox turn.
        const preserveWorkBudget = peerResponse && priorControl.recovery?.status !== 'submitting';
        let control = preserveWorkBudget ? priorControl
          : prepareContinuation(this.db, recipient.id, current.lastResponseAt ?? current.lastActivityAt);
        if (control.recovery?.status === 'stalled' && control.supervisorId) {
          const signalled = signalContinuation(this.db, control.supervisorId, {
            key: `worker-stalled:${recipient.id}:${control.revision}:${control.recovery.startedAt}`,
            source: recipient.id, timestamp: nowIso(), reason: `Supervised worker ${recipient.id} exhausted its continuation budget; inspect its unfinished work.`,
          });
          if (signalled) this.requestAssignmentWake();
        }
        const workResponse = !peerResponse;
        if ((workResponse && !pendingContinuation(control)) || this.stopped) return;
        const revision = control.revision;
        const allowed = () => !this.stopped && !peerWakePaused(this.db, recipient.id)
          && (!workResponse || !continuationControl(this.db, recipient.id).awaiting)
          && (!workResponse || continuationControl(this.db, recipient.id).continuation === 'unattended')
          && (!workResponse || continuationControl(this.db, recipient.id).revision === revision);
        const project = await this.recoveryDependencies?.projectService.getProjectBySlug(current.projectSlug);
        if (!project) return;
        if (!this.recoveryDependencies!.projectService.getMergedProviderSettings(project, current.provider).enabled) return;
        const available = this.availableMemoryBytes();
        if (this.pressureSuspendAvailableBytes !== undefined
          && (available === undefined || available < this.pressureSuspendAvailableBytes)) return;
        // The loaded conversation is the only writer of its native conversation, so there is no outside owner to defer to.
        if (!this.structured.alive(current)) {
          if (!allowed()) return;
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
        if (!allowed()) return;
        await this.runRecovery.refresh(current.id);
        if (this.stopped) return;
        current = this.db.boundSessions.getById(current.id);
        const assignment = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(recipient.id) as { status: string } | undefined;
        const prompt = workResponse ? UNATTENDED_CONTINUATION_PROMPT : PEER_WAKE_PROMPT;
        if (!allowed() || !current || this.getCurrentRestorableSession(current)?.id !== current.id
          || !assignment || (workResponse && assignment.status === 'finished') || current.status !== 'bound'
          || current.isWorking || this.providerTurnIsWorking(current.id)
          || current.modelProfileRequest || current.queuedInputs?.length || current.manualSuspendedAt || current.pressureSuspendedAt
          || !this.structured.alive(current) || this.structured.turnRunning(current)) return;
        const submissionBlock = (): WakeBlock | undefined => {
          const latest = this.db.boundSessions.getById(session.id);
          expireMessages(this.db);
          if (!workResponse && !messages.some(m => !!this.db.sqlite.prepare('select 1 from coordination_messages where id=? and acknowledged_at is null').get(m.id)
            && (messagePolicy(this.db, m.id).priority === 'P1' || dispatchEligible(this.db, m.id))))
            return {code:'inbox_settled',reason:'All wake messages expired, were acknowledged or lost dispatch eligibility before submission.'};
          if (this.stopped) return { code: 'shutdown', reason: 'The Console backend is stopping.' };
          if (peerWakePaused(this.db, recipient.id)) {
            const details = this.db.meta.get(peerWakePauseDetailsKey(recipient.id));
            const pause = details ? JSON.parse(details) as AutomaticInputPause : undefined;
            return { code: pause?.code ?? 'paused_without_reason', reason: pause?.reason ?? 'Automatic input is paused; the existing record predates pause-reason capture.' };
          }
          const permission = continuationControl(this.db, recipient.id);
          if (workResponse && (permission.awaiting || permission.continuation !== 'unattended' || permission.revision !== revision
            || ['done', 'blocked'].includes(assignmentTask(this.db, recipient.id)?.state ?? '')))
            return { code: 'permission_changed', reason: 'The unattended work permission changed during submission.' };
          const state = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(recipient.id) as { status: string } | undefined;
          if (!state || (workResponse && state.status === 'finished')) return { code: 'assignment_finished', reason: 'The assignment finished during submission.' };
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
        if ((peerResponse && !messages.length) || (workResponse && !pendingContinuation(control))) return;
        const timestamp = nowIso();
        const restoreRecord = this.db.meta.get(peerWakeRestoreKey(current.id));
        const restore = restoreRecord ? JSON.parse(restoreRecord) as { pid: number; restoredAt: string } : undefined;
        const restoration: PeerWakeAttempt['restoration'] = restore && typeof current.pid === 'number' && restore.pid === current.pid
          && (!current.lastResponseAt || current.lastResponseAt < restore.restoredAt) ? 'restored' : 'already_loaded';
        // Persist before sending. An interrupted or ambiguous submission is never automatically repeated, including after a
        // backend restart.
        const saveAttempt = (status: PeerWakeAttempt['status'], reason?: string, block?: WakeBlock) => {
          for (const message of messages) this.db.meta.set(message.key,
            JSON.stringify({ status, sessionId: current!.id, timestamp, reason, restoration, block,
              ...(status === 'deferred' ? { nextAttemptAt: new Date(Date.now() + 15_000).toISOString() } : {}) } satisfies PeerWakeAttempt));
        };
        saveAttempt('submitting');
        const consumedSignals = new Set(control.signals.map(signal => signal.key));
        if (workResponse) {
          const attempts = (control.recovery?.attempts ?? 0) + 1;
          control.recovery = { status: 'submitting', attempts,
            reason: control.signals.slice(-3).map(signal => signal.reason).join(' ') || control.recovery!.reason,
            startedAt: timestamp,
            nextAttemptAt: new Date(Date.now() + CONTINUATION_DELAYS_MS[Math.min(attempts, 2)]!).toISOString() };
          saveContinuation(this.db, recipient.id, control);
        }
        const runtime = this.runtimeState(current.id);
        const previousSubmittedTurnAt = runtime.submittedTurnAt;
        runtime.submittedTurnAt = timestamp;
        let submissionInvoked = false;
        let block: WakeBlock | undefined;
        /** Why the transport refused the notice for good: nothing was sent, and sending it again fails the same way. */
        let rejection: string | undefined;
        try {
          block = submissionBlock();
          if (block) throw new Error(block.reason);
          // The transport reports whether the notice was sent: only a refusal before sending may be retried.
          submissionInvoked = true;
          const delivery = await this.structured.deliverAutomatic(current, prompt);
          if (delivery.status === 'deferred') {
            submissionInvoked = false;
            throw new Error(delivery.reason ?? 'The session is busy.');
          }
          if (delivery.status === 'rejected') {
            submissionInvoked = false;
            rejection = delivery.reason ?? 'The session refused the notice.';
            throw new Error(rejection);
          }
          if (delivery.status === 'failed') throw new Error(delivery.reason ?? 'The session did not accept the notice.');
          saveAttempt('submitted');
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
          const deferred = !rejection && !submissionInvoked;
          const reason = error instanceof Error ? error.message : 'Provider input failed.';
          saveAttempt(deferred ? 'deferred' : 'failed', reason, block);
          this.appendEvent(current, { type: 'status', timestamp: nowIso(), text: rejection
            ? `Automatic ${peerResponse ? 'inbox' : 'work'} input was not sent, and sending it again would fail the same way: ${reason}`
            : `Automatic ${peerResponse ? 'inbox' : 'work'} input ${deferred ? 'deferred before submission' : 'failed with uncertain delivery'}: ${reason}` });
          if (workResponse && allowed()) {
            control = continuationControl(this.db, recipient.id);
            control.recovery = { ...control.recovery!, status: deferred ? 'scheduled' : 'blocked',
              reason: deferred ? `Continuation deferred before submission: ${reason}`
                : rejection ? `Continuation was not sent and cannot be: ${reason}`
                : 'Continuation delivery is uncertain. Review the conversation before enabling unattended work again.' };
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
    await this.structured.shutdown();
    this.structuredMonitors.clear();
    this.survivorBusyRuns.clear();
    for (const sessionId of [...this.transcriptWatchers.keys()]) {
      this.transcriptWatchers.stop(sessionId);
    }
    for (const sessionId of [...this.runtimes.keys()]) {
      const state = this.runtimeState(sessionId);
      if (state.workingIdleTimer) {
        clearTimeout(state.workingIdleTimer);
        state.workingIdleTimer = undefined;
      }
    }
    this.runtimes.clear();
  }

  private runtimeState(sessionId: string): SessionRuntimeState {
    return this.runtimes.state(sessionId);
  }

  private async verifyNativeProcessEpoch(session: BoundSession): Promise<void> {
    // The epoch is when the conversation was last loaded on the current connection; older runs cannot own it.
    const epoch = this.structured.epoch(session.id);
    if (session.pid && epoch) this.runtimeState(session.id).nativeProcess = { pid: session.pid, startedAt: epoch };
  }

  private runPredatesNativeProcess(session: BoundSession, run: ProviderRunState): boolean {
    const native = this.runtimeState(session.id).nativeProcess;
    return native !== undefined && native.pid === session.pid && run.timestamp < native.startedAt;
  }

  private providerTurnIsWorking(sessionId: string): boolean {
    // A turn can only run while its conversation is loaded, so the transport's own state is authoritative. A conversation
    // that is not loaded runs nothing, whatever its transcript last said: an unfinished turn after a restart must not read as
    // working (it would block wakes and show a busy row that nothing is driving). A turn the transport found running but
    // could not name yet counts: clearing "working" under it would lose it.
    return this.structured.alive({ id: sessionId }) && this.structured.turnRunning({ id: sessionId });
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
    this.syncSessionWorkingState(updated, { capturedAt: nowIso() });
    if (!session.isWorking && updated !== session) this.eventBus.emit({ type: 'session.updated', session: updated });
    if (session.provider === 'claude') this.scheduleModelProfileDrain(session.id);
    this.requestAssignmentWake();
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
    // The first pass adopts surviving provider processes before any idle or pressure decision looks at the rows.
    await this.reattachStructuredSurvivors();
    const pressureActive = this.observeLowAvailableMemory();
    const sessions = this.listRestorableSessions();
    if (pressureActive) {
      sessions.sort((a, b) => this.sessionIdleTimestampMs(a) - this.sessionIdleTimestampMs(b));
    }
    let pressureSuspended = false;
    for (const session of sessions) {
      // A user suspension survives reconciliation and backend restarts until
      // that conversation is explicitly opened again.
      if (session.manualSuspendedAt) continue;
      if (this.isFinishedSession(session) && !this.structured.alive(session)) {
        this.retainFinishedInbox(session);
        continue;
      }
      if (this.isWorkReleaseDue(session)) {
        try {
          await this.runtimes.run(session.id, 'releaseExpiredWorkSession', async () => {
            const current = this.db.boundSessions.getById(session.id);
            if (!current || !this.isWorkReleaseDue(current)) return;
            if (!current.conversationRef.startsWith('pending:') && !(await this.hasReadableIndexedTranscript(current))) return;
            if (this.structured.turnRunning(current)) return;
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
      // A conversation loads on first use, not at boot: only its lost-turn bookkeeping runs here. A failed restore is retried,
      // and so is one a crash cut off half way (the row stays `starting`).
      await this.runtimes.run(session.id, 'reconcileSession', () => this.refreshSessionState(session,
        { restoreMissing: session.status === 'error' || session.status === 'starting', resumeIdle: true }));
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
    // A shared process cannot be suspended per conversation, so memory pressure leaves those rows alone. A per-session process
    // is this conversation's alone: ending it frees its memory.
    if (this.structured.processModel(session.provider) !== 'per-session' || !session.shouldRestore || session.status !== 'bound' || session.isWorking || session.queuedInputs?.length || session.modelProfileRequest
      || session.manualSuspendedAt || session.pressureSuspendedAt || session.conversationRef.startsWith('pending:')) {
      return false;
    }
    const responseMs = Date.parse(session.lastResponseAt ?? '');
    const updatedMs = Date.parse(session.updatedAt);
    if (!Number.isFinite(responseMs) || !Number.isFinite(updatedMs)) return false;
    const idleSinceMs = Math.max(this.sessionIdleTimestampMs(session), updatedMs);
    return Date.now() - idleSinceMs >= this.pressureSuspendIdleMs;
  }

  /** End an idle conversation's own process under memory pressure and mark the row; selecting the conversation restores it. */
  private async suspendPressureIdleSession(staleSession: BoundSession): Promise<boolean> {
    const threshold = this.pressureSuspendAvailableBytes;
    if (threshold === undefined) return false;
    const session = this.db.boundSessions.getById(staleSession.id);
    // A conversation that is not loaded holds no memory, and nothing restores it on its own.
    if (!session || !this.isPressureSuspendable(session) || !this.structured.alive(session)) return false;
    if (await this.suspensionBlockReason(session, 'pressure')) return false;
    const current = this.db.boundSessions.getById(session.id);
    const availableBeforeBytes = this.availableMemoryBytes();
    if (!current || !this.isPressureSuspendable(current) || availableBeforeBytes === undefined || availableBeforeBytes >= threshold) return false;
    if (!this.structured.alive(current) || this.structured.turnRunning(current)) return false;
    await this.structured.unload(current);
    this.stopWatching(current.id);
    this.runtimes.clearEphemeral(current.id);
    this.runRecovery.cancel(current.id);
    const suspended = this.db.boundSessions.setPressureSuspendedAt(current.id, nowIso());
    if (!suspended) return false;
    this.appendEvent(suspended, { type: 'status', text: 'Session suspended because available memory was low; it will restore on next use.', timestamp: nowIso() });
    this.logger?.warn({ sessionId: suspended.id, availableBeforeBytes, availableAfterBytes: this.availableMemoryBytes(), thresholdBytes: threshold },
      'Suspended idle session under memory pressure.');
    this.publishStructuredScreen(suspended.id); // now reads "asleep"
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
    const windowMs = this.structured.configFor(session.provider).idleUnloadMinutes * 60_000;
    return idleSinceMs > 0 && Date.now() - idleSinceMs >= windowMs;
  }

  private async suspendIdleSession(staleSession: BoundSession): Promise<void> {
    // The idle decision was made before this callback reached the front of the
    // session's operation queue; inputs, binds, or restores may have run since.
    // Re-read the row and re-check so fresh activity or a new restore grace is
    // never followed by a stale unload.
    const session = this.db.boundSessions.getById(staleSession.id);
    if (!session || !session.shouldRestore || !this.isIdleSuspendable(session) || session.idleSuspendedAt) {
      return;
    }
    if (await this.suspensionBlockReason(session, 'idle')) return;
    const latest = this.db.boundSessions.getById(session.id);
    if (!latest || !this.isIdleSuspendable(latest)) return;
    if (this.structured.alive(latest)) {
      await this.structured.unload(latest);
      this.appendEvent(latest, { type: 'status', text: 'Session suspended after extended idle; it will restore on next use.', timestamp: nowIso() });
      this.publishStructuredScreen(latest.id); // now reads "asleep"
    } else {
      // Not loaded here, but a provider process nobody adopted may still run for it: asleep means no process.
      await this.structured.unload(latest);
    }
    this.stopWatching(latest.id);
    this.runtimes.clearEphemeral(latest.id);
    this.runRecovery.cancel(latest.id);
    const suspended = this.db.boundSessions.setIdleSuspendedAt(latest.id, nowIso());
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

  private ensureSessionLogPaths(session: BoundSession): BoundSession {
    const sessionDir = path.join(this.runtimeDir, session.id);
    const eventLogPath = session.eventLogPath ?? path.join(sessionDir, 'events.jsonl');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(eventLogPath, '', { flag: 'a' });
    if (eventLogPath === session.eventLogPath) {
      return session;
    }
    const updated = { ...session, eventLogPath };
    this.db.boundSessions.upsert(updated);
    return updated;
  }

  private coordinationHelperPath(): string {
    return fileURLToPath(new URL('../../../../scripts/agent-coord.mjs', import.meta.url));
  }

  /**
   * Set once coordination exists. A provider with no session-start hook (Mistral Vibe) registers the live process here.
   * Later `createContext` calls see it; a call before this resolves and the session still starts.
   */
  setConversationRegistrar(registrar: NonNullable<PluginContext['registerConversation']>): void {
    this.conversationRegistrar = registrar;
  }

  private async restoreSession(requestedSession: BoundSession, explicitResume = false, initialPrompt?: string, beforeStart?: () => void): Promise<BoundSession | undefined> {
    const session = this.getCurrentRestorableSession(requestedSession);
    if (!session) {
      return undefined;
    }
    if (!explicitResume && this.isFinishedSession(session)) {
      const assignment = this.assignmentForSession(session)!;
      if (!this.db.sqlite.prepare('select 1 from coordination_messages where recipient_id=? and acknowledged_at is null limit 1').get(assignment.id)) return undefined;
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

    if (!dependencies.projectService.getMergedProviderSettings(project, session.provider).enabled) {
      this.recordRestoreFailureIfOwned(session, 'Failed to restore session: provider is disabled.');
      return undefined;
    }

    return await this.restoreStructuredSession(session, initialPrompt, beforeStart);
  }

  async bindConversation(input: {
    project: ActiveProject;
    provider: ProviderAdapter;
    conversationRef: string;
    title: string;
    kind: ConversationSummary['kind'];
    initialPrompt?: string;
    initialPromptIsHuman?: boolean;
    launchContext?: AgentLaunchContext;
    sessionId?: string;
    /** The profile to start on. Omitted: Medium for a new conversation that names no model. */
    codexProfile?: ModelProfileKey;
    claudeProfile?: ModelProfileKey;
    grokProfile?: ModelProfileKey;
    vibeProfile?: ModelProfileKey;
    /**
     * A structured chat started with a routing already made (the provider-neutral Start): the session starts on this Auto decision,
     * runs on its model from the first turn, and the initial prompt is not routed again. Needs the provider's `auto` profile.
     */
    autoDecision?: AutoDecision;
    /** A status line recorded on a new structured chat (Start tells the person it fell back to its default). */
    startNotice?: string;
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
      // A grant never stops work in progress: a human's running turn must finish first.
      if (this.structured.turnRunning(session)) throw new SessionInputRejectedError('Restart is waiting for the current work to finish.');
      // Drop the conversation so the reload below starts a fresh epoch, and forget the old turns' run state.
      await this.structured.unload(session);
      this.structuredMonitors.get(session.id)?.reset();
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
    const requested = this.mustGetSession(sessionId);
    if (requested.launchContext?.launchedBy !== launchedBy || !authorized()) throw new Error('Session ownership or close authority changed.');
    await this.runtimes.run(sessionId, 'closeGrantedSession', async () => {
      const session = this.mustGetSession(sessionId);
      if (session.launchContext?.launchedBy !== launchedBy) throw new Error('You can close only sessions your assignment launched.');
      if (!authorized()) throw new Error('The grant no longer covers closing this session.');
      if (!session.shouldRestore && session.status === 'ended') return;
      if (!(await this.hasReadableIndexedTranscript(session))) {
        throw new SessionInputRejectedError('Close is waiting for the native transcript to be indexed and readable.');
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
          if (!dependencies.projectService.getMergedProviderSettings(project, conversation.provider).enabled) {
            throw new Error('Provider is disabled.');
          }
          tracked.push(await this.runWithAutoTrackLaunchSlot(() => this.bindConversation({
            project,
            provider,
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

  /**
   * Bind a conversation to a provider session. A new chat gets its native id when the provider starts it, so its pending alias
   * is adopted immediately. A conversation that is already bound is restored instead.
   */
  private async bindConversationInternal(input: BindConversationInput, sessionId: string): Promise<SessionCommandResult> {
    const existing = this.db.boundSessions.getRestorableByConversation(input.project.slug, input.provider.id, input.conversationRef);
    if (existing) {
      const liveSession = await this.refreshSessionState(existing, { resumeIdle: true });
      if (liveSession) {
        return sessionCommandResult(liveSession);
      }
      throw new Error(`Conversation ${input.conversationRef} is still bound but could not be restored.`);
    }
    const providerId = input.provider.id;
    if (!this.structured.isEnabled(providerId)) throw new StructuredSessionDisabledError(providerId);
    const pendingRef = input.kind === 'pending' ? input.conversationRef : undefined;
    if (pendingRef) {
      const pending = this.db.pendingConversations.get(pendingRef);
      if (!pending) throw new Error(`Pending conversation ${pendingRef} must exist before a session can adopt it.`);
      const adopted = pending.rawMetadata?.adoptedConversationRef;
      if (typeof adopted === 'string') {
        // A retried bind finds the alias already adopted: return the session that owns the thread.
        const owner = this.db.boundSessions.getRestorableByConversation(input.project.slug, providerId, adopted);
        if (!owner) throw new Error(`Pending conversation ${pendingRef} was adopted by a session that is no longer bound.`);
        const live = await this.refreshSessionState(owner, { resumeIdle: true });
        if (!live) throw new Error(`Conversation ${adopted} is still bound but could not be restored.`);
        return sessionCommandResult(live);
      }
    }

    const now = nowIso();
    const sessionDir = path.join(this.runtimeDir, sessionId);
    const eventLogPath = path.join(sessionDir, 'events.jsonl');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(eventLogPath, '', { flag: 'a' });
    const initialPrompt = input.initialPrompt?.trim();
    const defaultProfile = input.kind === 'pending' && !input.launchContext?.model && !input.launchContext?.effort;
    const requestedProfile = input.autoDecision ? 'auto' : requestedProfileOf(providerId, input);
    const startProfile = requestedProfile ?? (defaultProfile ? 'medium' : undefined);
    // A session that starts on Auto has no model until its first message is routed, unless the routing was already made for that message.
    const startRoute: AutoRoute | undefined = startProfile !== 'auto' ? undefined
      : input.autoDecision ? autoRouteFor(input.autoDecision, initialPrompt ?? '', 1) : { routePending: true };
    const session: BoundSession = {
      launchContext: input.launchContext,
      id: sessionId,
      provider: providerId,
      ...profilePatch(providerId, startProfile),
      ...(startRoute ? { autoRoute: startRoute } : {}),
      projectSlug: input.project.slug,
      conversationRef: input.conversationRef,
      resumeConversationRef: input.kind === 'history' ? input.conversationRef : undefined,
      status: 'starting',
      shouldRestore: true,
      title: input.title,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: initialPrompt ? now : undefined,
      autoTrackedAt: input.autoTrackedAt,
      isWorking: false,
      eventLogPath,
    };
    this.db.boundSessions.upsert(session);
    if (!pendingRef) {
      const previousEffort = this.db.boundSessions.getLastThinkingEffort(input.project.slug, providerId, input.conversationRef);
      if (previousEffort) this.db.meta.set(`session-thinking:${sessionId}`, previousEffort);
    }
    if (input.launchContext) this.db.boundSessions.setLaunchContext(sessionId, input.launchContext);
    if (startRoute) this.db.boundSessions.setAutoRoute(sessionId, startRoute, now);

    try {
      let nativeRef = input.conversationRef;
      let started: { transcriptPath?: string; pid?: number };
      if (pendingRef) {
        const created = await this.structured.start({
          sessionId,
          provider: providerId,
          cwd: input.project.path,
          target: await sessionModelTarget(this.modelProfiles, session),
          model: input.launchContext?.model,
          effort: input.launchContext?.effort,
          launchContext: input.launchContext,
        });
        nativeRef = created.nativeSessionId;
        started = created;
      } else {
        started = await this.structured.resume(session, input.project.path);
      }
      // The row as it is now: loading the thread may have stored a default cost profile on it.
      const bound: BoundSession = { ...(this.db.boundSessions.getById(sessionId) ?? session), status: 'bound', updatedAt: nowIso(), pid: started.pid };
      this.db.boundSessions.upsert(bound);
      await this.verifyNativeProcessEpoch(bound);
      let current = bound;
      if (pendingRef) {
        const adoption = adoptPendingConversation({
          db: this.db,
          projectSlug: input.project.slug,
          providerId,
          pendingRef,
          matchedConversation: {
            ref: nativeRef,
            kind: 'history',
            projectSlug: input.project.slug,
            provider: providerId,
            title: input.title,
            createdAt: now,
            updatedAt: now,
            ...(started.transcriptPath ? { transcriptPath: started.transcriptPath } : {}),
            providerConversationId: nativeRef,
            isBound: true,
            boundSessionId: sessionId,
            degraded: false,
          },
        });
        if (!adoption.adopted) throw new Error(`The new ${providerId} thread ${nativeRef} could not be adopted by ${pendingRef}.`);
        current = adoption.reboundSession ?? this.mustGetSession(sessionId);
      }
      let recordedInitialUserInput: RecordedUserInput | undefined;
      // Recorded before the first message, where the status line of an ordinary Auto routing falls.
      if (input.autoDecision) this.appendEvent(current, { type: 'status', text: autoChoiceText(input.autoDecision), timestamp: nowIso() });
      if (input.startNotice) this.appendEvent(current, { type: 'status', text: input.startNotice, timestamp: nowIso() });
      if (initialPrompt) {
        if (input.initialPromptIsHuman !== false && !input.autoDecision) await this.routeAutoBeforeTurn(current, initialPrompt);
        await this.structured.submitHuman(current, { requestId: randomUUID(), text: initialPrompt });
        recordedInitialUserInput = recordedUserInputFromEvent(this.appendEvent(current, {
          type: input.initialPromptIsHuman === false ? 'agent-input' : 'user-input',
          text: initialPrompt,
          timestamp: nowIso(),
        }));
      }
      current = this.mustGetSession(sessionId);
      this.appendEvent(current, { type: 'status', text: `Bound ${providerId} session in ${input.project.displayName}.`, timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: current });
      this.watchSessionOutput(current);
      this.publishStructuredScreen(sessionId);
      return sessionCommandResult(current, recordedInitialUserInput);
    } catch (error) {
      await this.structured.release(session).catch(() => undefined);
      this.structuredMonitors.delete(sessionId);
      const latest = this.db.boundSessions.getById(sessionId) ?? session;
      const failed: BoundSession = { ...latest, status: 'error', shouldRestore: false, updatedAt: nowIso(), isWorking: false, pid: undefined };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, {
        type: 'status',
        text: `Failed to bind session: ${structuredStatusReason(error)}`,
        timestamp: nowIso(),
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw error;
    }
  }

  async sendInput(sessionId: string, text: string): Promise<SessionCommandResult> {
    this.assertAdmissibleText(sessionId, text);
    this.inputQueue.advanceRevision(sessionId);
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
    return await this.submitStructuredText(liveSession, text);
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

  async sendKeystrokes(sessionId: string, payload: KeystrokeSendPayload,
    revision = this.inputQueue.revision(sessionId)): Promise<SessionCommandResult> {
    // Reject unsupported input before it pauses automatic work or cancels recovery.
    this.assertStructuredKeystrokes(payload);
    if (payload.keys?.[0] === 'Enter') this.assertAdmissibleText(sessionId, payload.submittedText ?? payload.text);
    const stop = payload.keys?.[0] === 'Escape';
    const cancelledBeforeAdmission = revision !== this.inputQueue.revision(sessionId) && !stop;
    if (cancelledBeforeAdmission && !payload.submissionId) {
      throw new SessionInputRejectedError('This input was cancelled by a later Stop or message.');
    }
    // A queued send that a later Stop overtook still belongs to the captured revision; stale input must not pause new work.
    if (!cancelledBeforeAdmission) {
      if (!payload.submissionId) this.inputQueue.advanceRevision(sessionId);
      this.pauseAutomaticInput(sessionId, stop ? 'human_stop' : 'human_keys',
        stop ? 'A human requested Stop.' : 'A human sent a message.');
      this.runRecovery.cancel(sessionId);
      if (stop) this.cancelQueuedInputs(sessionId, true);
    }
    if (payload.submissionId) {
      const run = this.runtimes.run(sessionId, 'queueInput', () => this.queueInputInternal(sessionId, payload, revision));
      this.activeInputCommands.add(run);
      try { return await run; } finally { this.activeInputCommands.delete(run); }
    }
    return await this.runtimes.run(sessionId, 'sendKeystrokes', () => this.sendStructuredKeystrokes(this.mustGetSession(sessionId), payload));
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

  private cancelQueuedInputs(sessionId: string, cancelUncertain = false): void {
    if (!this.db.isOpen()) return;
    for (const record of this.inputQueue.list(sessionId)) {
      this.inputQueue.put(sessionId, record.state === 'submitting' && !cancelUncertain
        ? { ...record, state: 'failed', reason: 'Stopped during submission. Check the conversation before sending again.' }
        : { ...record, state: 'cancelled', reason: record.state === 'submitting'
          ? 'Stopped during submission. It may already have arrived and will not be retried.' : record.reason });
    }
    if (this.db.boundSessions.getById(sessionId)) this.publishInputQueue(sessionId);
  }

  async cancelQueuedInput(sessionId: string, requestId: string): Promise<SessionInputResponse> {
    const record = this.inputQueue.get(sessionId, requestId);
    if (!record) throw new SessionInputRejectedError('Queued message not found.');
    if (record.state === 'submitting' || record.state === 'submitted') {
      throw new SessionInputRejectedError('Submission has already started. Check the conversation before sending again.');
    }
    this.saveQueuedInput(sessionId, { ...record, state: 'cancelled' });
    this.scheduleInputDrain(sessionId);
    return { session: this.mustGetSession(sessionId) };
  }

  private async queueInputInternal(sessionId: string, payload: KeystrokeSendPayload, revision: number): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const text = payload.submittedText?.trim();
    if (!text || payload.keys?.length !== 1 || payload.keys[0] !== 'Enter') {
      throw new SessionInputRejectedError('Queued submission requires a complete message and a single Enter.');
    }
    let record = this.inputQueue.get(sessionId, payload.submissionId!);
    if (record && record.text !== text) throw new SessionInputRejectedError('This submission ID already belongs to another message.');
    const interrupted = revision !== this.inputQueue.revision(sessionId);
    if (!record) {
      if (!session.shouldRestore || !['bound', 'starting'].includes(session.status)) {
        throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
      }
      record = { requestId: payload.submissionId!, text,
        requestedAt: nowIso(), state: interrupted ? 'cancelled' : 'queued',
        reason: interrupted ? 'Stopped before submission.' : 'Waiting for the session to accept the message.' };
      this.saveQueuedInput(sessionId, record);
    }
    if (interrupted) throw new SessionInputRejectedError('This send was cancelled by a later Stop or message. It was not sent.');
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
    const defer = (reason: string) => {
      // A wait for the session itself (asleep, suspended, not loadable) is not a run of refusals by the transport, so the
      // clock that fails a message after 10 of them starts again once the session is back.
      if ((record.reason !== reason || record.notSentSince !== undefined) && this.inputQueue.get(sessionId, record.requestId)?.state === record.state) {
        record = { ...record, reason, notSentSince: undefined };
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
    await this.drainStructuredQueuedInput(session, record, attemptRevision, defer);
  }

  /** The model a profile switch applies: the target an Auto decision carries, or the catalog's entry for a fixed level. */
  private async requestTarget(provider: ProviderId, request: Pick<ModelProfileRequest, 'profile' | 'target' | 'autoRoute'>): Promise<AppliedModel | undefined> {
    if (request.target) return { ...request.target, label: request.autoRoute?.decision?.label };
    if (request.profile === 'auto') return undefined;
    const entry = await this.modelProfiles.entry(provider, request.profile);
    return { model: entry.launchName, effort: entry.effort, label: entry.label };
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
        throw new SessionInputRejectedError(`${PROVIDER_NAMES[session.provider]} is disabled for this project.`);
      }
      let target: AppliedModel | undefined;
      try {
        target = await this.requestTarget(session.provider, { profile });
      } catch (error) {
        if (error instanceof ModelProfilesUnavailableError) throw new SessionInputRejectedError(error.message);
        throw error;
      }
      if (profile === 'auto' && activeModelProfile(session) === 'auto') {
        // Pressing A again keeps the model the session runs on and routes its next message afresh.
        const updatedAt = nowIso();
        if (session.modelProfileRequest) this.db.boundSessions.replaceModelProfileRequest(session.id, undefined, updatedAt);
        const route: AutoRoute = { routePending: true, ...(session.autoRoute?.decision ? { decision: session.autoRoute.decision } : {}) };
        const updated = this.db.boundSessions.setAutoRoute(session.id, route, updatedAt);
        if (!updated) throw new SessionInputRejectedError('Session not found.');
        this.appendEvent(updated, { type: 'status', text: 'Auto will route your next message.', timestamp: updatedAt });
        this.eventBus.emit({ type: 'session.updated', session: updated });
        return { session: updated };
      }
      const visibleModel = profile !== 'auto' && activeModelProfile(session) === profile
        ? this.structured.screen(session).model
        : undefined;
      if (profile !== 'auto' && activeModelProfile(session) === profile
        && target && visibleModelMatchesTarget(session.provider, target, visibleModel) !== false) {
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
        ...(profile === 'auto' ? { autoRoute: { routePending: true } } : {}),
      };
      const updated = this.db.boundSessions.replaceModelProfileRequest(session.id, request, requestedAt);
      if (!updated) throw new SessionInputRejectedError('Session not found.');
      this.appendEvent(updated, {
        type: 'status',
        text: profile === 'auto'
          ? `Queued the Auto ${session.provider} profile (the router picks a model when you send your next message).`
          : `Queued ${profile} ${session.provider} profile (${describeAppliedModel(target)}).`,
        timestamp: requestedAt,
      });
      this.eventBus.emit({ type: 'session.updated', session: updated });
      return { session: updated };
    });
    this.scheduleModelProfileDrain(sessionId);
    return response;
  }

  async setThinkingEffort(sessionId: string, effort: string): Promise<SessionModelProfileResponse> {
    return await this.runtimes.run(sessionId, 'setThinkingEffort', async () => {
      const session = this.mustGetSession(sessionId);
      if (!session.shouldRestore || !['starting', 'bound'].includes(session.status) || !this.getCurrentRestorableSession(session)) {
        throw new SessionInputRejectedError('This session no longer owns the conversation.');
      }
      try {
        await this.structured.setThinkingEffort(session, effort);
      } catch (error) {
        throw new SessionInputRejectedError(`Could not change thinking level: ${structuredStatusReason(error)}`);
      }
      this.db.meta.set(`session-thinking:${sessionId}`, effort);
      const updated = this.mustGetSession(sessionId);
      this.eventBus.emit({ type: 'session.updated', session: updated });
      return { session: updated };
    });
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

  private async drainModelProfileRequestInternal(sessionId: string): Promise<void> {
    const session = this.db.boundSessions.getById(sessionId);
    const request = session?.modelProfileRequest;
    if (!session || !request || request.state === 'failed') return;
    // A sleeping session keeps its choice in the row; the next load reads it.
    if (request.state === 'applying') {
      // There is nothing to relaunch: an interrupted switch only needs its recorded choice completed.
      await this.completeStructuredModelProfile(session, request);
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
    if (!dependencies.projectService.getMergedProviderSettings(project, session.provider).enabled) {
      this.failModelProfileRequest(session, request, `${session.provider} is disabled or unavailable for this project.`);
      return;
    }
    const current = this.mustGetSession(session.id);
    const queued = current.modelProfileRequest;
    if (!queued || queued.state !== 'queued') return;
    if (this.inputQueue.list(current.id).some(input => input.state !== 'queued')) {
      this.deferModelProfileRequest(current, queued, 'unsent_input');
      return;
    }
    await this.applyStructuredModelProfile(current, queued);
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
    // checks below still protect a running turn and queued input.
    return assignment?.status === 'active';
  }

  private async suspensionBlockReason(session: BoundSession, mode: 'manual' | 'idle' | 'pressure'): Promise<'assignment' | 'busy' | 'turn_running' | 'queued_input' | 'background_work' | undefined> {
    const current = this.db.boundSessions.getById(session.id);
    if (!current || !current.shouldRestore || current.status !== 'bound' || current.modelProfileRequest
      || current.manualSuspendedAt || current.pressureSuspendedAt || current.conversationRef.startsWith('pending:')) return 'busy';
    // An assignment can remain active after SessionStart without a running turn. Ordinary idle sleep goes by the turn alone.
    if (mode !== 'idle' && this.hasActiveCoordinationAssignment(session)) return 'assignment';
    if (this.structured.turnRunning(session)) return 'turn_running';
    // A process that reports shell commands or subagents it left running keeps them: ending the process would kill them.
    if (this.structured.hasBackgroundWork(session)) return 'background_work';
    // Manual suspension cancels queued input itself; sleeping on its own must not strand it.
    if (mode !== 'manual' && current.queuedInputs?.length) return 'queued_input';
    return undefined;
  }

  async suspendSession(sessionId: string): Promise<BoundSession> {
    this.pauseAutomaticInput(sessionId, 'manual_suspend', 'The session was manually suspended.');
    return await this.runtimes.run(sessionId, 'suspendSession', async () => {
      const session = this.mustGetSession(sessionId);
      if (session.manualSuspendedAt || session.pressureSuspendedAt) return session;
      if (session.idleSuspendedAt && !this.structured.alive(session)) {
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
      if (blockReason === 'busy') {
        throw new SessionInputRejectedError('The provider is busy or has queued input.');
      }
      if (blockReason === 'turn_running') throw new SessionInputRejectedError('A turn is running. Stop it or wait for it to finish before suspending.');
      if (blockReason === 'queued_input') throw new SessionInputRejectedError('A message is queued for this session.');
      if (blockReason === 'background_work') throw new SessionInputRejectedError('The session is running background work. Wait for it to finish before suspending.');
      await this.structured.unload(session);
      this.structuredMonitors.delete(session.id);
      this.publishStructuredScreen(session.id); // now reads "asleep"
      this.stopWatching(session.id);
      this.runtimes.clearEphemeral(session.id);
      this.runRecovery.cancel(session.id);
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

    try {
      if (this.structured.turnRunning(session)) await this.structured.interrupt(session).catch(() => undefined);
      await this.structured.release(session);
    } catch (error) {
      retainBindingAfterFailure('Failed to release the session cleanly. The conversation remains available.');
      throw error;
    }

    this.stopWatching(session.id);
    this.runtimes.clearEphemeral(session.id);
    this.structuredMonitors.delete(session.id);
    this.survivorBusyRuns.delete(session.id);
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

  async ensureSession(sessionId: string): Promise<BoundSession | undefined> {
    return await this.runtimes.run(sessionId, 'ensureSession', () => this.ensureSessionInternal(sessionId));
  }

  private async ensureSessionInternal(sessionId: string): Promise<BoundSession | undefined> {
    const session = this.mustGetSession(sessionId);
    return await this.refreshSessionState(session);
  }

  /** The synthesized status of a conversation that is not asleep, loading it first when it is not loaded. */
  async getSessionScreen(sessionId: string): Promise<{ session: BoundSession; screen: SessionScreen } | undefined> {
    const session = this.mustGetSession(sessionId);
    if (session.manualSuspendedAt || session.pressureSuspendedAt || session.idleSuspendedAt) return undefined;
    let current = session;
    if (!this.structured.alive(session)) {
      const live = await this.runtimes.run(sessionId, 'restoreSessionForScreen', async () => {
        const latest = this.mustGetSession(sessionId);
        if (latest.status === 'error' || latest.manualSuspendedAt || latest.pressureSuspendedAt || latest.idleSuspendedAt) return undefined;
        return await this.refreshSessionState(latest, { restoreMissing: true });
      });
      if (!live) return undefined;
      current = live;
    }
    const latest = this.mustGetSession(current.id);
    return { session: latest, screen: this.structured.screen(latest) };
  }

  /** The providers whose structured lane is on (enabled in config, with a transport plugin registered). */
  enabledStructuredProviders(): ProviderId[] {
    return PROVIDERS.filter(provider => this.structured.isEnabled(provider));
  }

  private structuredEventsLive(): boolean {
    return !this.stopped && this.db.isOpen();
  }

  /** The row for a structured event, or undefined when the session ended, is releasing or never was structured. */
  private structuredRow(sessionId: string): BoundSession | undefined {
    if (!this.structuredEventsLive()) return undefined;
    const session = this.db.boundSessions.getById(sessionId);
    return session?.shouldRestore && session.status !== 'ended' && session.status !== 'releasing'
      ? session : undefined;
  }

  private structuredMonitor(sessionId: string): StructuredRunMonitor {
    let monitor = this.structuredMonitors.get(sessionId);
    if (!monitor) {
      monitor = new StructuredRunMonitor();
      this.structuredMonitors.set(sessionId, monitor);
    }
    return monitor;
  }

  private attachStructuredRunMonitor(session: BoundSession): StructuredRunMonitor {
    const monitor = this.structuredMonitor(session.id);
    this.runRecovery.watch(session.id, `structured:${session.id}`, () => monitor);
    return monitor;
  }

  private publishStructuredScreen(sessionId: string): void {
    const session = this.structuredRow(sessionId);
    if (!session) return;
    const screen = this.structured.screen(session);
    this.eventBus.emit({
      type: 'session.screen-updated',
      sessionId: session.id,
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      screen,
      timestamp: screen.capturedAt,
    });
  }

  /**
   * A row whose provider process may have outlived the last backend and is worth adopting. A per-session process (one Claude CLI
   * per conversation) is worth adopting whatever it is doing, so idle sleep, memory pressure and release can end it. A shared
   * process (the Codex app-server) keeps serving every thread, and resuming a thread loads it into that process, so only a thread
   * that may be running a turn is adopted: a row still marked working, whose turn the process may still be running.
   */
  private isSurvivorCandidate(row: BoundSession | undefined): row is BoundSession {
    if (!row || !row.shouldRestore || row.status !== 'bound'
      || row.manualSuspendedAt || row.pressureSuspendedAt || row.idleSuspendedAt) return false;
    const model = this.structured.processModel(row.provider);
    if (model === 'per-session') return true;
    return model === 'shared' && row.isWorking === true;
  }

  /**
   * Adopts the provider process that survived for one row (the caller holds the row's command lock) and says what it found:
   * `loaded` (the row is loaded afterwards), `absent` (no process answers for it), `busy` (a session host runs but did not
   * answer in time) or `unanswered` (it has not answered for `SURVIVOR_BUSY_LIMIT_MS`). A turn the process is running becomes
   * the row's turn (working, recency untouched); one that ended while no backend listened is reported by the plugin as the
   * terminal it was. Nothing is started and nothing ends a process here. A `busy` row is left exactly as it is: its turn may well
   * be running, so it is not declared lost, and the next load asks again. `unanswered` ends that patience: the caller settles the
   * row as lost, because a host that never answers is indistinguishable from a dead one, and Stop could not reach it either.
   */
  private async adoptStructuredSurvivor(row: BoundSession): Promise<'loaded' | 'absent' | 'busy' | 'unanswered'> {
    const projects = this.recoveryDependencies?.projectService;
    if (!projects || this.stopped) return 'absent';
    const current = this.db.boundSessions.getById(row.id);
    if (!this.isSurvivorCandidate(current)) return 'absent';
    const project = await projects.getProjectBySlug(current.projectSlug);
    if (!project || this.stopped) return 'absent';
    const [adopted] = await this.structured.reattachSurvivors([{ session: current, cwd: project.path }]);
    if (!adopted) {
      if (!this.structured.survivorBusy(row.id)) {
        this.survivorBusyRuns.delete(row.id);
        return 'absent';
      }
      const run = this.survivorBusyRuns.get(row.id) ?? { since: Date.now(), attempts: 0 };
      run.attempts += 1;
      this.survivorBusyRuns.set(row.id, run);
      if (Date.now() - run.since >= SURVIVOR_BUSY_LIMIT_MS) {
        // The run stays until the row is settled (see `refreshStructuredSessionState`), so a lookup whose caller cannot settle it
        // (the startup sweep) does not start another ten minutes.
        this.logger?.warn({ sessionId: row.id, attempts: run.attempts, busyForMs: Date.now() - run.since }, 'The provider process of a conversation did not answer for too long; its turn is taken as lost.');
        return 'unanswered';
      }
      this.logger?.warn({ sessionId: row.id, attempts: run.attempts }, 'The provider process of a conversation did not answer in time; it was left alone.');
      if (run.attempts === SURVIVOR_BUSY_REPORT_AFTER) this.appendStructuredStatus(row.id, 'The agent process is running but is slow to answer. The Console keeps trying.');
      return 'busy';
    }
    this.survivorBusyRuns.delete(row.id);
    let session = this.updateBoundSessionFields(row.id, { pid: this.structured.loadedPid(row.id) });
    await this.verifyNativeProcessEpoch(session);
    // The plugin's first events (an adopted turn, a terminal it found) are handled within this turn of the event loop.
    await new Promise<void>((resolve) => setImmediate(resolve));
    session = this.mustGetSession(row.id);
    if (session.isWorking && !this.structured.turnActive(session)) {
      if (this.structured.processModel(session.provider) === 'per-session' || this.structured.turnUnidentified(session)) {
        // The turn the row says is running may have ended while no backend was listening, and nothing announces that. The
        // working-state expiry clears the flag after an idle window unless the process reports a turn by then. A shared
        // process can be in the same position: its thread is running a turn it could not name yet, which its first event
        // will (the plugin says so with `turnUnidentified`, and the expiry keeps the row working until it does); only a
        // thread with no turn at all is lost.
        this.scheduleWorkingExpiry(session.id, nowIso());
      } else {
        // The shared process was asked about the thread and has no turn for it: the turn is lost the way a dead connection loses it.
        await this.settleLostStructuredTurn(session);
        session = this.mustGetSession(row.id);
      }
    }
    this.watchSessionOutput(session);
    session = this.mustGetSession(row.id);
    this.eventBus.emit({ type: 'session.updated', session });
    this.publishStructuredScreen(session.id);
    return 'loaded';
  }

  /**
   * First reconcile pass only. A provider process can outlive a backend restart behind its session host, and nothing owns it until
   * its conversation is used: idle sleep, memory pressure and release could not end it, and a turn it is running would be declared
   * lost. This ends the hosts no conversation owns any more, then asks the plugin to adopt each candidate row's process (see
   * `isSurvivorCandidate`). A row with no survivor stays unloaded and resumes on its next use; nothing is started here.
   */
  private async reattachStructuredSurvivors(): Promise<void> {
    const projects = this.recoveryDependencies?.projectService;
    // Without project paths there is no working directory to hand the plugin; the next pass tries again.
    if (this.survivorsReattached || !projects) return;
    this.survivorsReattached = true;
    const restorable = this.listRestorableSessions();
    this.noteStructuredConversationHistory(restorable);
    try {
      // Asked again for each host, against the database as it is then: a conversation bound while the sweep runs owns its host.
      const ended = await this.structured.sweepOrphanHosts(id => {
        const row = this.db.boundSessions.getById(id);
        return !!row && row.shouldRestore === true && row.status !== 'ended';
      });
      if (ended.length > 0) this.logger?.info?.({ hosts: ended }, 'Ended provider session hosts that no conversation owns.');
    } catch (error) {
      this.logger?.warn({ err: error }, 'Sweeping provider session hosts that no conversation owns failed.');
    }
    let adoptedAny = false;
    for (const row of restorable) {
      if (this.stopped) return;
      if (!this.isSurvivorCandidate(row)) continue;
      try {
        await this.runtimes.run(row.id, 'reattachSurvivor', async () => {
          if (await this.adoptStructuredSurvivor(row) === 'loaded') adoptedAny = true;
        });
      } catch (error) {
        this.logger?.warn({ err: error, sessionId: row.id }, 'Reattaching a surviving provider process failed.');
      }
    }
    // The process sends what it still has open (a snapshot of its background tasks) right behind the reply to the repeated
    // initialize. Let the event loop read it before the pass decides which idle conversations to put to sleep.
    if (adoptedAny) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /**
   * A row that has had a response ran turns before the plugin kept its record of having history (an earlier build, or a row the
   * tmux transport ran before Phase B). Writing it now keeps a transcript the CLI deletes later from being taken for an empty
   * chat. The write is idempotent, so every boot may repeat it. A failure on one row never stops the others.
   */
  private noteStructuredConversationHistory(rows: BoundSession[]): void {
    for (const row of rows) {
      if (!row.lastResponseAt) continue;
      try {
        this.structured.noteConversationHistory(row);
      } catch (error) {
        this.logger?.warn({ err: error, sessionId: row.id }, 'Recording that a structured conversation has history failed.');
      }
    }
  }

  private appendStructuredStatus(sessionId: string, text: string): void {
    const session = this.structuredRow(sessionId);
    if (session) this.appendEvent(session, { type: 'status', text, timestamp: nowIso() });
  }

  /**
   * A question is waiting: show it on the row, note it in the log (without its text) and push it to the browser. One that was
   * already announced (an earlier backend told the person) is shown again without the status line and the push.
   */
  private handleStructuredQuestion(sessionId: string, request: PendingRequestSummary, options: { announced: boolean }): void {
    const session = this.structuredRow(sessionId);
    if (!session) return;
    if (!options.announced) this.appendStructuredStatus(sessionId, 'The agent asked a question');
    this.publishStructuredRequests(sessionId);
    const notify = this.notifyStructuredQuestion;
    if (!notify || options.announced) return;
    const notice: StructuredQuestionNotice = {
      sessionId, projectSlug: session.projectSlug, provider: session.provider, conversationRef: session.conversationRef,
      requestId: request.requestId, summary: request.summary,
    };
    void Promise.resolve().then(() => notify(notice)).catch((error: unknown) => {
      if (this.structuredEventsLive()) this.logger?.warn({ err: error, sessionId }, 'Notifying about a structured question failed.');
    });
  }

  /** The row's open questions changed. Moving the row version makes a poll that raced this event adopt the new list. */
  private publishStructuredRequests(sessionId: string): void {
    if (!this.structuredRow(sessionId)) return;
    this.eventBus.emit({ type: 'session.updated', session: this.updateBoundSessionFields(sessionId, { updatedAt: nowIso() }) });
  }

  /**
   * The person's answer to a question a session is holding open. Runs under the session's command
   * lock; the service lets exactly one answer through, and an answer for a withdrawn or unknown request is a 404.
   */
  async answerStructuredRequest(sessionId: string, requestId: string, response: SessionRequestResponse): Promise<BoundSession> {
    return await this.runtimes.run(sessionId, 'answerStructuredRequest', async () => {
      const session = this.mustGetSession(sessionId);
      let sent: { message?: string };
      try {
        sent = await this.structured.respond(session, requestId, response.decision === 'answer'
          ? { decision: 'answer', answers: response.answers, ...(response.text ? { text: response.text } : {}) }
          : { decision: 'decline' });
      } catch (error) {
        if (error instanceof StructuredRequestNotPendingError) throw new StructuredRequestNotFoundError(error.message);
        throw this.structuredInputError(error);
      }
      // A question the agent asked in a message is answered with a message of the person's: it counts as their input.
      if (sent.message) this.recordStructuredHumanInput(session, sent.message);
      return this.mustGetSession(sessionId);
    });
  }

  /**
   * Refuses a message the session cannot take, before anything else happens for it: a refused message must not pause automatic
   * work, cancel recovery or move the input revision, and is never journaled (it would only sit there failed).
   */
  private assertAdmissibleText(sessionId: string, text: string | undefined): void {
    const provider = this.db.boundSessions.getById(sessionId)?.provider;
    const rejection = provider && text?.trim() ? this.structuredTextRejection(text.trim(), provider) : undefined;
    if (rejection) throw new SessionKeystrokeRejectedError(rejection);
  }

  private structuredTextRejection(text: string, provider: ProviderId): string | undefined {
    // A caption is judged without the image envelope after it.
    if (STRUCTURED_SLASH_COMMAND.test(imagePromptDisplay(text).text.trim())) {
      return 'Slash commands are not supported here. To change the model level, open Session controls and choose Auto, Ultra, High, Medium or Low. To ask for a specific model or thinking level, select Auto and request it in plain English. Nothing was sent.';
    }
    const files = structuredImages(text, this.imageStoreDir);
    if (files && !this.structured.supportsImages(provider)) {
      return 'Image attachments are not available for this provider. Nothing was sent.';
    }
    // An envelope that names images the store does not hold would reach the model as text pointing at files it cannot open.
    if (!files && imagePromptDisplay(text).images?.length) {
      return 'The attached image is not in the image store. Paste it again. Nothing was sent.';
    }
    return undefined;
  }

  /** A session accepts complete messages and Stop. Everything else is a terminal control it does not have. */
  private assertStructuredKeystrokes(payload: KeystrokeSendPayload): void {
    const keys = payload.keys ?? [];
    const stop = keys.length === 1 && keys[0] === 'Escape' && !payload.text;
    const message = keys.length === 1 && keys[0] === 'Enter' && Boolean((payload.submittedText ?? payload.text)?.trim());
    if (stop || message) return;
    throw new SessionKeystrokeRejectedError('This session takes complete messages and Stop (Escape) only. Terminal keys, per-keystroke text and selection input are not available. Nothing was sent.');
  }

  private structuredInputError(error: unknown): unknown {
    if (error instanceof StructuredBusyError || error instanceof PreviousTurnActiveError || error instanceof NotSentError
      || error instanceof StructuredUnavailableError || error instanceof StructuredUnsupportedError || error instanceof SendRejectedError) {
      return new SessionInputRejectedError(`${error.message} Nothing was sent.`);
    }
    return error;
  }

  private async submitStructuredText(session: BoundSession, text: string): Promise<SessionCommandResult> {
    await this.routeAutoBeforeTurn(session, text);
    try {
      await this.structured.submitHuman(session, { requestId: randomUUID(), text }, structuredImages(text, this.imageStoreDir));
    } catch (error) {
      throw this.structuredInputError(error);
    }
    return this.recordStructuredHumanInput(session, text);
  }

  /** A message the person sent reached the provider: it is their activity, and the conversation log records it. */
  private recordStructuredHumanInput(session: BoundSession, text: string): SessionCommandResult {
    const inputAt = nowIso();
    const updated = this.updateBoundSessionFields(session.id, { updatedAt: inputAt, lastActivityAt: inputAt });
    const recordedUserInput = recordedUserInputFromEvent(this.appendEvent(updated, { type: 'user-input', text, timestamp: inputAt }));
    return sessionCommandResult(updated, recordedUserInput);
  }

  private async sendStructuredKeystrokes(session: BoundSession, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    if (payload.keys?.[0] === 'Escape') {
      let stopped: Awaited<ReturnType<StructuredSessionService['interrupt']>>;
      try {
        stopped = await this.structured.interrupt(session);
      } catch (error) {
        throw new SessionInputRejectedError(`Stop could not be delivered: ${error instanceof Error ? error.message : 'unknown error'}.`);
      }
      // No loaded session: Stop reached nobody. A row that reads "working" would stay so for ever (a host that does not answer, a
      // process not adopted yet), so it is cleared and the person is told the agent may still be running.
      if (stopped.outcome === 'notLoaded') this.settleUnreachableStop(session.id);
      this.markCancelledSteers(session, stopped.cancelledSteerIds);
      const activityAt = nowIso();
      return sessionCommandResult(this.updateBoundSessionFields(session.id, { updatedAt: activityAt, lastActivityAt: activityAt }));
    }
    const live = await this.refreshSessionState(session, { resumeIdle: true });
    if (!live) throw new SessionInputRejectedError(SESSION_NOT_RUNNING_INPUT_MESSAGE);
    return await this.submitStructuredText(live, (payload.submittedText ?? payload.text)!.trim());
  }

  /**
   * Stop on a conversation that is marked working but has no loaded session. The agent was not reached and may still be
   * running; the next successful lookup of its process adopts a turn it is still running. No unattended recovery is started,
   * because the person asked for the stop.
   */
  private settleUnreachableStop(sessionId: string): void {
    const current = this.db.boundSessions.getById(sessionId);
    if (!current?.isWorking) return;
    this.clearWorkingExpiry(sessionId);
    this.structuredMonitor(sessionId).reset();
    this.survivorBusyRuns.delete(sessionId);
    const stopped = this.updateBoundSessionFields(sessionId, { isWorking: false, updatedAt: nowIso() });
    this.appendEvent(stopped, { type: 'status', text: 'Stop could not reach the agent process, which may still be running. The conversation is marked idle; the Console picks the process up again when it answers.', timestamp: nowIso() });
    this.eventBus.emit({ type: 'session.updated', session: stopped });
    this.publishStructuredScreen(sessionId);
  }

  /**
   * Stop made the provider drop messages that were queued behind the running turn (steers that had not been folded in yet). The
   * journal still says `submitted`, so each one is marked as not delivered, and the person is told once if one had no journal entry.
   */
  private markCancelledSteers(session: BoundSession, requestIds: string[]): void {
    let untracked = 0;
    for (const requestId of requestIds) {
      const record = this.inputQueue.get(session.id, requestId);
      if (!record) {
        untracked += 1;
        continue;
      }
      this.saveQueuedInput(session.id, { ...record, state: 'failed', reason: 'cancelled by Stop' });
    }
    if (untracked > 0) this.appendStructuredStatus(session.id, 'A message sent while the turn ran was cancelled by Stop and was not delivered.');
  }

  /** The journal replaces the terminal's paste-and-confirm steps: queued, submitting (request sent), submitted. */
  private async drainStructuredQueuedInput(
    staleSession: BoundSession,
    record: QueuedInputRecord,
    attemptRevision: number,
    defer: (reason: string) => void,
  ): Promise<void> {
    const sessionId = staleSession.id;
    let session = staleSession;
    if (!this.structured.alive(session)) {
      const loaded = await this.refreshSessionState(session, { resumeIdle: true });
      if (!loaded || !this.structured.alive(loaded)) { defer('Waiting for the session to resume.'); return; }
      session = loaded;
    }
    const stillOwned = (): boolean => {
      if (this.stopped || !this.db.isOpen() || this.inputQueue.revision(sessionId) !== attemptRevision) return false;
      const current = this.db.boundSessions.getById(sessionId);
      return !!current && current.status === 'bound' && !current.manualSuspendedAt && !current.pressureSuspendedAt
        && this.getCurrentRestorableSession(current)?.id === sessionId
        && this.inputQueue.get(sessionId, record.requestId)?.state === record.state;
    };
    if (!stillOwned()) { defer('Waiting to verify the original live session.'); return; }
    const sending: QueuedInputRecord = { ...record, state: 'submitting', reason: 'Sending the message.' };
    this.saveQueuedInput(sessionId, sending);
    try {
      await this.routeAutoBeforeTurn(session, record.text);
      const sent = await this.structured.submitHuman(session, record, structuredImages(record.text, this.imageStoreDir));
      const inputAt = nowIso();
      const updated = this.updateBoundSessionFields(sessionId, { updatedAt: inputAt, lastActivityAt: inputAt });
      const recordedUserInput = recordedUserInputFromEvent(this.appendEvent(updated, { type: 'user-input', text: record.text, timestamp: inputAt }));
      this.saveQueuedInput(sessionId, { ...sending, state: 'submitted', turnId: sent.turnId, deliveryMode: sent.mode, recordedUserInput, notSentSince: undefined });
    } catch (error) {
      if (this.inputQueue.get(sessionId, record.requestId)?.state !== 'submitting') return;
      if (error instanceof StructuredBusyError || error instanceof PreviousTurnActiveError) {
        // Keep the message durable before interrupting a Grok turn that cannot take a native steer.
        const stopsForReply = session.provider === 'grok' || session.provider === 'vibe';
        this.saveQueuedInput(sessionId, { ...record, notSentSince: undefined, reason: error instanceof StructuredBusyError
          ? stopsForReply ? 'Stopping the current turn to deliver your reply.' : 'Waiting for the running turn to finish.'
          : 'Waiting for the session to accept the message.' });
        if (error instanceof StructuredBusyError && stopsForReply) {
          try {
            await this.structured.interruptForQueuedReply(session);
          } catch (interruptError) {
            // The reply was not sent and remains queued. An interrupt failure must not return a false send failure to
            // the browser, which could restore and resubmit the same draft while this durable copy is still pending.
            this.logger?.warn({ err: interruptError, sessionId }, session.provider === 'grok'
              ? 'Grok interruption for a queued reply will be retried.'
              : 'Mistral Vibe interruption for a queued reply will be retried.');
            this.saveQueuedInput(sessionId, { ...record, notSentSince: undefined,
              reason: 'Could not stop the current turn yet. Your reply is saved and will be retried.' });
          }
        }
        return;
      }
      if (error instanceof NotSentError || error instanceof StructuredUnavailableError) {
        // The transport refused before sending anything (the connection was lost, or a request to the provider timed out), so
        // the message can wait for the next attempt. It cannot wait for ever: a run of refusals that lasts too long fails it.
        const since = record.notSentSince ?? nowIso();
        if (Date.now() - Date.parse(since) >= STRUCTURED_NOT_SENT_LIMIT_MS) {
          this.saveQueuedInput(sessionId, { ...sending, state: 'failed', notSentSince: since,
            reason: `The message could not be sent for ${STRUCTURED_NOT_SENT_LIMIT_MS / 60_000} minutes (${structuredStatusReason(error)}). Nothing was sent.` });
          return;
        }
        this.saveQueuedInput(sessionId, { ...record, notSentSince: since, reason: 'Waiting for the session to accept the message.' });
        return;
      }
      if (error instanceof SendRejectedError) {
        // Nothing was written and a retry would fail the same way (a refused model, an image that cannot be read): the person decides.
        this.saveQueuedInput(sessionId, { ...sending, state: 'failed', reason: error.message });
        return;
      }
      this.saveQueuedInput(sessionId, { ...sending, state: 'failed', reason: error instanceof StructuredUnsupportedError
        ? error.message : 'Submission could not be confirmed. Check the conversation before sending again.' });
    }
  }

  private async ensureStructuredLoaded(session: BoundSession): Promise<{ loaded: boolean; reason?: string }> {
    const project = await this.recoveryDependencies?.projectService.getProjectBySlug(session.projectSlug);
    if (!project) return { loaded: false, reason: 'The project is not available.' };
    return await this.structured.ensureLoaded(session, project.path) === 'loaded'
      ? { loaded: true }
      : { loaded: false, reason: this.structured.unavailableReason(session.id) };
  }

  /** The structured counterpart of restoreSession: reload the thread, then clear the sleep markers a reload ends. */
  private async restoreStructuredSession(
    session: BoundSession,
    initialPrompt?: string,
    beforeStart?: () => void,
  ): Promise<BoundSession | undefined> {
    beforeStart?.();
    const prepared = this.ensureSessionLogPaths(session);
    const shouldEmitRestoreAttempt = prepared.status !== 'error';
    const restoring: BoundSession = { ...prepared, status: 'starting', updatedAt: nowIso(), isWorking: false, pid: undefined };
    if (shouldEmitRestoreAttempt) {
      this.db.boundSessions.upsert(restoring);
      this.eventBus.emit({ type: 'session.updated', session: restoring });
      this.appendEvent(restoring, { type: 'status', text: 'Restoring bound session.', timestamp: nowIso() });
    }
    try {
      const loaded = await this.ensureStructuredLoaded(restoring);
      if (!loaded.loaded) throw new Error(loaded.reason ?? 'The provider session could not be resumed.');
      const current = this.getCurrentRestorableSession(restoring);
      if (!current) throw new Error('Session restore was superseded during startup.');
      this.db.boundSessions.upsert({ ...current, status: 'bound', updatedAt: nowIso(), pid: this.structured.loadedPid(current.id) });
      let resumed = this.mustGetSession(current.id);
      if (resumed.manualSuspendedAt) resumed = this.db.boundSessions.setManualSuspendedAt(resumed.id, undefined) ?? resumed;
      if (resumed.pressureSuspendedAt) resumed = this.db.boundSessions.setPressureSuspendedAt(resumed.id, undefined) ?? resumed;
      if (resumed.idleSuspendedAt) resumed = this.db.boundSessions.setIdleSuspendedAt(resumed.id, undefined) ?? resumed;
      await this.verifyNativeProcessEpoch(resumed);
      if (initialPrompt) {
        const delivery = await this.structured.deliverAutomatic(resumed, initialPrompt);
        if (delivery.status !== 'submitted') throw new Error(delivery.reason ?? 'The restored session did not accept its opening prompt.');
      }
      resumed = this.mustGetSession(resumed.id);
      this.appendEvent(resumed, { type: 'status', text: 'Restored bound session.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: resumed });
      this.watchSessionOutput(resumed);
      this.publishStructuredScreen(resumed.id);
      return resumed;
    } catch (error) {
      this.recordRestoreFailureIfOwned(restoring, `Failed to restore session: ${structuredStatusReason(error)}`);
      return undefined;
    }
  }

  private async refreshStructuredSessionState(
    session: BoundSession,
    options: { restoreMissing?: boolean; resumeSuspension?: boolean; resumeIdle?: boolean },
  ): Promise<BoundSession | undefined> {
    if (!this.getCurrentRestorableSession(session)) return undefined;
    if (session.conversationRef.startsWith('pending:') && !session.resumeConversationRef) {
      // A bind that never reached thread start (a crash): there is no native session to reattach.
      const ended = clearPendingConversationRestoreBinding({ db: this.db, session });
      this.eventBus.emit({ type: 'session.updated', session: ended });
      return undefined;
    }
    let alive = this.structured.alive(session);
    let lostReason: string | undefined;
    if (!alive && session.isWorking && this.isSurvivorCandidate(session)) {
      // The backend restarted under this row's turn. Its provider process may still be running it, and a load of the row (the
      // screen poll, a queued message, a wake) can come before the first reconcile looks for survivors: ask before declaring
      // the turn lost, on every path that loads the row.
      try {
        const outcome = await this.adoptStructuredSurvivor(session);
        // A process that runs but is slow to answer may still be running the turn: leave the row as it is and ask again on the next load.
        if (outcome === 'busy') return undefined;
        alive = outcome === 'loaded';
        if (outcome === 'unanswered') {
          this.survivorBusyRuns.delete(session.id);
          lostReason = `the agent process did not answer for ${SURVIVOR_BUSY_LIMIT_MS / 60_000} minutes`;
        }
      } catch (error) {
        this.logger?.warn({ err: error, sessionId: session.id }, 'Reattaching a surviving provider process failed.');
      }
      session = this.db.boundSessions.getById(session.id) ?? session;
    }
    if (!alive) {
      await this.settleLostStructuredTurn(session, lostReason);
      const current = this.db.boundSessions.getById(session.id);
      if (!current || current.status === 'releasing') return undefined;
      // Finished work keeps its restorable inbox; only an explicit selection or the guarded inbox wake reloads it.
      if (!options.resumeSuspension && this.isFinishedSession(current)) {
        this.retainFinishedInbox(current);
        return this.db.boundSessions.getById(current.id);
      }
      // A conversation that is not loaded can still owe a scheduled recovery or unfinished unattended work. Watch the
      // row so RunRecovery re-arms from the persisted budget and the transcript; without a watcher nothing would ever
      // wake the retry until a human opened the conversation.
      if (current.runFailure || this.hasUnattendedWork(current)) this.watchSessionOutput(current);
      if (!(options.restoreMissing ?? true) && !options.resumeSuspension) return undefined;
      return await this.restoreSession(current, options.resumeSuspension === true);
    }
    let loaded = session;
    if (options.resumeSuspension) {
      if (loaded.manualSuspendedAt) loaded = this.db.boundSessions.setManualSuspendedAt(loaded.id, undefined) ?? loaded;
      if (loaded.pressureSuspendedAt) loaded = this.db.boundSessions.setPressureSuspendedAt(loaded.id, undefined) ?? loaded;
    }
    if ((options.resumeSuspension || options.resumeIdle) && loaded.idleSuspendedAt) {
      loaded = this.db.boundSessions.setIdleSuspendedAt(loaded.id, undefined) ?? loaded;
      this.suspensionGraceUntilMs.set(loaded.id, Date.now() + this.restoreGraceMs);
    }
    if (loaded.status !== 'bound') {
      loaded = { ...loaded, status: 'bound', updatedAt: nowIso() };
      this.db.boundSessions.upsert(loaded);
      this.eventBus.emit({ type: 'session.updated', session: loaded });
    }
    this.watchSessionOutput(loaded);
    return loaded;
  }

  /** Nothing runs without a loaded thread: a row still marked working lost its turn with the connection. */
  private async settleLostStructuredTurn(session: BoundSession, reason = 'the previous connection ended while a turn was running'): Promise<void> {
    if (session.isWorking) await this.handleStructuredConnectionLoss(session, reason);
  }

  private async handleStructuredConnectionLoss(session: BoundSession, reason?: string): Promise<void> {
    const wasWorking = session.isWorking;
    this.clearWorkingExpiry(session.id);
    this.structuredMonitor(session.id).reset();
    const lost = this.updateBoundSessionFields(session.id, { isWorking: false, updatedAt: nowIso() });
    this.appendEvent(lost, { type: 'status', text: `The provider connection ended${reason ? ` (${reason})` : ''}. The session reconnects on next use.`, timestamp: nowIso() });
    this.eventBus.emit({ type: 'session.updated', session: lost });
    this.publishStructuredScreen(session.id);
    // Unfinished unattended work recovers through the backed-off controller, as after any lost provider process.
    if (wasWorking && this.unattendedAssignment(lost)) await this.runRecovery.processExited(session.id);
  }

  private async applyStructuredModelProfile(session: BoundSession, request: Extract<ModelProfileRequest, { state: 'queued' }>): Promise<void> {
    if (this.structured.turnRunning(session)) {
      this.deferModelProfileRequest(session, request, 'turn_running');
      return;
    }
    const startedAt = nowIso();
    const applying: Extract<ModelProfileRequest, { state: 'applying' }> = {
      ...request,
      state: 'applying',
      startedAt,
      previousProfile: activeModelProfile(session),
      resumeConversationRef: session.resumeConversationRef ?? session.conversationRef,
    };
    const transitioned = this.db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id, requestId: request.requestId, expectedState: 'queued', next: applying, updatedAt: startedAt,
    });
    if (!transitioned) return;
    await this.completeStructuredModelProfile(transitioned, applying);
  }

  /** No restart: the profile rides on the next turn, so a switch completes as soon as no turn is running. */
  private async completeStructuredModelProfile(session: BoundSession, request: Extract<ModelProfileRequest, { state: 'applying' }>): Promise<void> {
    let selected: AppliedModel | undefined;
    try {
      selected = await this.requestTarget(session.provider, request);
    } catch (error) {
      if (!(error instanceof ModelProfilesUnavailableError)) throw error;
      this.failModelProfileRequest(session, request, error.message);
      return;
    }
    if (await this.structured.setTarget(session, selected && { model: selected.model, effort: selected.effort }) === 'deferred') {
      // A turn started after the check; the next terminal re-runs this switch.
      this.db.boundSessions.compareAndSetModelProfileRequest({
        id: session.id,
        requestId: request.requestId,
        expectedState: 'applying',
        next: {
          requestId: request.requestId,
          profile: request.profile,
          requestedAt: request.requestedAt,
          state: 'queued',
          deferredReason: 'turn_running',
          ...(request.autoRoute ? { autoRoute: request.autoRoute } : {}),
          ...(request.target ? { target: request.target } : {}),
        },
        updatedAt: nowIso(),
      });
      return;
    }
    const completed = this.db.boundSessions.completeModelProfileRequest({
      id: session.id, requestId: request.requestId, profile: request.profile, updatedAt: nowIso(),
    });
    if (!completed) return;
    const decision = request.autoRoute?.decision;
    const text = request.profile === 'auto'
      ? decision?.source === 'fallback' ? (decision.warning ?? 'Auto fell back to Medium.')
        : decision ? `Auto chose ${describeAppliedModel(selected)}${decision.reason ? `: ${decision.reason}` : '.'}`
        : 'Auto selected. The router picks a model when you send your next message.'
      : `${session.provider} session now uses ${request.profile} (${describeAppliedModel(selected)}).`;
    this.appendEvent(completed, { type: 'status', text, timestamp: completed.updatedAt });
    this.eventBus.emit({ type: 'session.updated', session: completed });
    this.publishStructuredScreen(completed.id);
  }

  /**
   * Auto: before a person's message starts a turn, ask the router for a model once per selection of A and apply it through the
   * same switch the level buttons use. The session then stays on that model, so later messages keep their prompt cache.
   * A failed or slow router applies Medium and says so; the message is never held back for longer than the router's timeout.
   * Runs under the session's command lock, so two messages cannot route twice.
   */
  private async routeAutoBeforeTurn(staleSession: BoundSession, text: string): Promise<void> {
    // The caller's copy of the row may be older than a switch made while the message waited.
    const session = this.db.boundSessions.getById(staleSession.id) ?? staleSession;
    if (activeModelProfile(session) !== 'auto' || !session.autoRoute?.routePending) return;
    // A switch the person asked for wins over a routing (a failed one does not), and a running turn keeps its model: the
    // message waits for the next turn.
    if (this.hasLiveModelProfileRequest(session) || this.structured.turnRunning(session)) return;
    // One routing per selection of A, even when two messages arrive together.
    const running = this.autoRoutings.get(session.id);
    if (running) return await running;
    const run = this.routeAutoNow(session, text).finally(() => { this.autoRoutings.delete(session.id); });
    this.autoRoutings.set(session.id, run);
    return await run;
  }

  private hasLiveModelProfileRequest(session: BoundSession): boolean {
    return !!session.modelProfileRequest && session.modelProfileRequest.state !== 'failed';
  }

  private async routeAutoNow(session: BoundSession, text: string): Promise<void> {
    try {
      // The prompt after the first is checked again from the conversation so far, and so is every later prompt while the choice is
      // provisional (the classifier could not tell the kind of task). Pressing A again starts afresh: it keeps the decision but not
      // the notes of the run (`routedPrompts`, `previousPrompt`), so the next prompt counts as the first.
      const previous = session.autoRoute;
      const rerouting = previous?.decision !== undefined && previous.routedPrompts !== undefined && previous.previousPrompt !== undefined;
      const task = rerouting
        ? composeRerouteTask({ prompt: text, assistantReply: await this.lastAssistantReplyStart(session), previousPrompt: previous?.previousPrompt })
        : text;
      // The newest message alone is also sent, so the router can see an explicit level or thinking level the person asked for.
      const outcome = await this.modelProfiles.route(session.provider, task, { latestMessage: text });
      const latest = this.db.boundSessions.getById(session.id);
      // The row may have changed while the router ran (released, or a different profile chosen).
      if (!latest || activeModelProfile(latest) !== 'auto' || !latest.autoRoute?.routePending || this.hasLiveModelProfileRequest(latest)) return;
      if (rerouting && latest.autoRoute.decision) {
        await this.applyReroute(latest, outcome, text, previous?.routedPrompts ?? 1);
        return;
      }
      const medium = outcome.ok ? undefined : await this.modelProfiles.entry(session.provider, 'medium').catch(() => undefined);
      const decision = outcome.ok ? outcome.decision : fallbackDecision(outcome.reason, medium);
      await this.applyAutoDecision(latest, decision, autoRouteFor(decision, text, 1));
    } catch (error) {
      // Never block the message: it runs on the model the session already has.
      this.logger?.warn({ err: error, sessionId: session.id }, 'Auto routing failed; the message runs on the current model.');
    }
  }

  /** Applies a decision through the same switch the level buttons use, and commits `route` as the row's Auto state with it. */
  private async applyAutoDecision(latest: BoundSession, decision: AutoDecision, route: AutoRoute): Promise<void> {
    const target = decision.launchName && decision.effort ? { model: decision.launchName, effort: decision.effort } : undefined;
    const startedAt = nowIso();
    const applying: Extract<ModelProfileRequest, { state: 'applying' }> = {
      requestId: randomUUID(),
      profile: 'auto',
      requestedAt: startedAt,
      state: 'applying',
      startedAt,
      previousProfile: 'auto',
      resumeConversationRef: latest.resumeConversationRef ?? latest.conversationRef,
      autoRoute: route,
      ...(target ? { target } : {}),
    };
    const stored = this.db.boundSessions.replaceModelProfileRequest(latest.id, applying, startedAt);
    if (!stored) return;
    await this.completeStructuredModelProfile(stored, applying);
  }

  /**
   * A prompt after the first on a session whose Auto state still asks for a check: the second prompt always, later ones while the
   * choice is provisional (see {@link autoRouteFor}). A router failure keeps the choice, because a first guess is better than
   * dropping to Medium, and counts as a routed prompt. A changed model or effort is applied through the ordinary profile switch;
   * the same model only updates the row.
   */
  private async applyReroute(latest: BoundSession, outcome: Awaited<ReturnType<ModelProfileService['route']>>, text: string, priorRoutes: number): Promise<void> {
    const kept = latest.autoRoute!.decision!;
    const routed = priorRoutes + 1;
    const decision = outcome.ok ? outcome.decision : kept;
    const route = autoRouteFor(decision, text, routed);
    const changed = outcome.ok && (decision.launchName !== kept.launchName || decision.effort !== kept.effort);
    if (changed) {
      await this.applyAutoDecision(latest, decision, route);
      return;
    }
    const now = nowIso();
    const updated = this.db.boundSessions.setAutoRoute(latest.id, route, now);
    if (!updated) return;
    if (!outcome.ok) {
      const keeping = kept.launchName && kept.effort ? describeAppliedModel({ model: kept.launchName, effort: kept.effort, label: kept.label }) : 'the model the session has';
      this.appendEvent(updated, { type: 'status', text: `Auto could not re-route (${outcome.reason.replace(/[.\s]+$/, '')}). Keeping ${keeping}.`, timestamp: now });
    }
    this.eventBus.emit({ type: 'session.updated', session: updated });
  }

  /** The start of the last assistant reply in the conversation, read from the provider's transcript. Best effort: undefined when it cannot be read. */
  private async lastAssistantReplyStart(session: BoundSession): Promise<string | undefined> {
    const dependencies = this.recoveryDependencies;
    const ref = session.resumeConversationRef ?? session.conversationRef;
    if (!dependencies || ref.startsWith('pending:')) return undefined;
    try {
      const project = await dependencies.projectService.getProjectBySlug(session.projectSlug);
      if (!project) return undefined;
      const settings = dependencies.projectService.getMergedProviderSettings(project, session.provider);
      const conversation = await dependencies.providerRegistry.get(session.provider).getConversation(project, ref, settings);
      const reply = [...(conversation?.messages ?? [])].reverse().find(message => message.role === 'assistant' && message.text.trim());
      return reply?.text.trim();
    } catch (error) {
      this.logger?.warn({ err: error, sessionId: session.id }, 'The last assistant reply could not be read for re-routing.');
      return undefined;
    }
  }

  private handleStructuredTurnStarted(sessionId: string, turnId: string, origin: 'user' | 'provider', replay = false, adopted = false): void {
    const session = replay ? undefined : this.structuredRow(sessionId);
    if (!session) return;
    const at = nowIso();
    this.structuredMonitor(sessionId).turnStarted(turnId, at);
    // A turn the provider began on its own is agent activity; one Console submitted already moved recency. A turn found running
    // when the session attached (a backend restart left it behind) is neither: the row is working again, and recency stays.
    const current = origin === 'provider' && !adopted ? this.updateBoundSessionFields(sessionId, { lastActivityAt: at, updatedAt: at }) : session;
    this.syncSessionWorkingState(current, { capturedAt: at });
    this.runRecovery.changed(sessionId);
    this.publishStructuredScreen(sessionId);
  }

  private handleStructuredItemCompleted(sessionId: string, at: string, replay = false): void {
    const session = replay ? undefined : this.structuredRow(sessionId);
    if (!session) return;
    this.structuredMonitor(sessionId).itemCompleted(at);
    // Output from a failed turn that is stopped does not move recency, as with terminal output.
    if (!(session.runFailure && session.runFailure.status !== 'retrying')) {
      this.updateBoundSessionFields(sessionId, {
        updatedAt: at, lastActivityAt: at, lastOutputAt: at, isWorking: this.structured.turnRunning(session),
      });
      this.scheduleWorkingExpiry(sessionId, at);
    }
    if (session.runFailure) this.runRecovery.changed(sessionId);
  }

  private handleStructuredTurnTerminal(
    sessionId: string,
    turnId: string,
    status: StructuredTerminalStatus,
    failure?: ProviderFailure,
    replay = false,
  ): void {
    const session = replay ? undefined : this.structuredRow(sessionId);
    if (!session) return;
    const at = nowIso();
    this.structuredMonitor(sessionId).turnTerminal(turnId, status, failure, at);
    // Only a completed turn is provider-confirmed output; a Stop or failure is not a response.
    if (status === 'completed') this.updateBoundSessionFields(sessionId, { lastResponseAt: at, updatedAt: at });
    this.syncSessionWorkingState(this.mustGetSession(sessionId), { capturedAt: at });
    this.eventBus.emit({ type: 'session.updated', session: this.mustGetSession(sessionId) });
    void this.fillStructuredTranscriptPath(sessionId).catch((error: unknown) => {
      if (this.structuredEventsLive()) this.logger?.warn({ err: error, sessionId }, 'Indexing the structured transcript failed.');
    });
    // RunRecovery turns a failed terminal into the persisted RunFailure and its retry schedule.
    this.runRecovery.changed(sessionId);
    this.scheduleModelProfileDrain(sessionId);
    this.requestAssignmentWake();
    this.publishStructuredScreen(sessionId);
  }

  private handleStructuredSessionState(sessionId: string, state: StructuredSessionState, failure?: ProviderFailure): void {
    if (state !== 'error' || !this.structuredEventsLive()) return;
    void this.runtimes.run(sessionId, 'structuredConnectionLost', async () => {
      const session = this.structuredRow(sessionId);
      if (session) await this.handleStructuredConnectionLoss(session, failure?.message);
    }).catch((error: unknown) => {
      if (this.structuredEventsLive()) this.logger?.warn({ err: error, sessionId }, 'Structured connection loss handling failed.');
    });
  }

  /** Index the transcript once the provider reports it, so search and the transcript watcher can find the thread. */
  private async fillStructuredTranscriptPath(sessionId: string): Promise<void> {
    let session = this.structuredRow(sessionId);
    if (!session || session.conversationRef.startsWith('pending:')) return;
    if (this.db.conversationIndex.get(session.projectSlug, session.provider, session.conversationRef)?.transcriptPath) return;
    const transcriptPath = this.structured.transcriptPath(sessionId) ?? await this.structured.refreshTranscriptPath(sessionId);
    session = this.structuredRow(sessionId);
    if (!session || !transcriptPath) return;
    const indexed = this.db.conversationIndex.get(session.projectSlug, session.provider, session.conversationRef);
    if (indexed?.transcriptPath) return;
    try {
      if (!fs.statSync(transcriptPath).isFile()) return;
    } catch {
      return;
    }
    const now = nowIso();
    this.db.conversationIndex.upsert({
      ref: session.conversationRef,
      kind: 'history',
      projectSlug: session.projectSlug,
      provider: session.provider,
      title: session.title ?? 'Live session',
      createdAt: session.startedAt,
      updatedAt: now,
      providerConversationId: session.conversationRef,
      isBound: true,
      boundSessionId: session.id,
      degraded: false,
      ...indexed,
      transcriptPath,
    });
    this.eventBus.emit({
      type: 'conversation.index-updated',
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      timestamp: now,
    });
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
    const session = this.db.boundSessions.getById(staleSession.id);
    if (!session || session.status === 'ended' || ((session.manualSuspendedAt || session.pressureSuspendedAt) && !options.resumeSuspension)
      || (session.idleSuspendedAt && !options.resumeSuspension && !options.resumeIdle)) {
      return undefined;
    }
    return await this.refreshStructuredSessionState(session, options);
  }

  private appendEvent(session: BoundSession, event: SessionEventLogEntry): AppendedSessionEvent | undefined {
    if (!session.eventLogPath) return undefined;
    const offset = fs.existsSync(session.eventLogPath) ? fs.statSync(session.eventLogPath).size : 0;
    const messageId = liveMessageId(session.id, offset);
    fs.appendFileSync(session.eventLogPath, `${JSON.stringify(event)}\n`);
    if (event.type === 'user-input') {
      this.db.boundSessions.markHumanReplied(session.id, event.timestamp);
      const assignment = this.assignmentForSession(session);
      if (assignment) setPeerWakePaused(this.db, assignment.id, false);
      this.db.meta.set(`human-input:${session.id}`, JSON.stringify({ id: messageId, text: event.text, timestamp: event.timestamp }));
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
    return { event, messageId, offset };
  }

  private watchSessionOutput(session: BoundSession): void {
    if (!this.shouldWatchSession(session)) {
      return;
    }
    this.watchSessionTranscript(session);
  }

  /** RunRecovery watches one stable key per session; the transcript monitor joins it once the transcript path is known. */
  private watchSessionTranscript(session: BoundSession): void {
    const structuredMonitor = this.attachStructuredRunMonitor(session);
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
    if (structuredMonitor.attachTranscript(transcriptPath, provider?.createRunMonitor?.bind(provider))) this.runRecovery.changed(session.id);

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
    this.transcriptWatchers.stop(sessionId);
    this.clearWorkingExpiry(sessionId);
  }

  private clearWorkingExpiry(sessionId: string): void {
    const state = this.runtimeState(sessionId);
    const timer = state.workingIdleTimer;
    if (timer) {
      clearTimeout(timer);
      state.workingIdleTimer = undefined;
    }
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
        // A named turn ends with its terminal event; an unnamed one may end without one (see the input's doc), so it is watched.
        turnUnidentified: this.structured.turnUnidentified({ id: sessionId }) && !this.structured.turnActive({ id: sessionId }),
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

  private syncSessionWorkingState(session: BoundSession, input: { capturedAt: string }): void {
    const next = nextWorkingState(session, {
      capturedAt: input.capturedAt,
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
}

type BindConversationInput = Parameters<SessionManager['bindConversation']>[0];

