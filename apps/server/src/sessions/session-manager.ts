import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BoundSession, ConversationSummary, ProviderId, RecordedUserInput, SessionInputResponse, SessionScreen } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { commandToShell } from '../lib/shell.js';
import { sleep } from '../lib/async.js';
import { AppDatabase } from '../db/database.js';
import type { ActiveProject } from '../projects/project-service.js';
import type { MergedProviderSettings } from '../config/service.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { TmuxClient } from './tmux-client.js';
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
  sessionScreenShowsWorking,
  shouldUseBracketedPasteTransport,
  submittedTextShouldCreateUserTurn,
  TMUX_LITERAL_TEXT_CHUNK_SIZE,
} from './screen-heuristics.js';
import { isRecentTimestamp, nextIdleExpiryDecision, nextScreenWorkingState } from './working-state.js';
import { OutputWatcherRegistry } from './output-watcher.js';
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
const SESSION_MODEL_LOG_TAIL_BYTES = 2 * 1024 * 1024;
interface SessionRecoveryDependencies {
  projectService: Pick<ProjectService, 'getProjectBySlug' | 'getMergedProviderSettings'>;
  providerRegistry: Pick<ProviderRegistry, 'get'>;
}

type SessionEventLogEntry = { type: 'user-input' | 'raw-output' | 'status'; text: string; timestamp: string };

interface AppendedSessionEvent {
  event: SessionEventLogEntry;
  messageId: string;
  offset: number;
}

export type SessionCommandResult = BoundSession & SessionInputResponse;

export class SessionKeystrokeRejectedError extends Error {
  readonly statusCode = 409;

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

export class SessionManager {
  private readonly outputWatchers = new OutputWatcherRegistry();
  private readonly runtimes: SessionRuntimeRegistry;
  private stopped = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly tmuxClient: TmuxClient,
    private readonly runtimeDir: string,
    private readonly eventBus: RealtimeEventBus,
    private readonly recoveryDependencies?: SessionRecoveryDependencies,
    private readonly logger?: SessionManagerLogger,
  ) {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.runtimes = new SessionRuntimeRegistry({
      onSlowCommand: ({ sessionId, label, elapsedMs }) => {
        this.logger?.warn(
          { sessionId, command: label, elapsedMs },
          'Session runtime command is still running.',
        );
      },
    });
  }

  private listRestorableSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter((session) => session.shouldRestore && session.status !== 'ended');
  }

  listActiveSessions(): BoundSession[] {
    return this.db.boundSessions.list().filter(isTreeVisibleBoundSession);
  }

  stop(): void {
    this.stopped = true;
    for (const sessionId of [...this.outputWatchers.keys()]) {
      this.stopWatching(sessionId);
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

  private runtimeState(sessionId: string): SessionRuntimeState {
    return this.runtimes.state(sessionId);
  }

  async observeSessions(): Promise<void> {
    for (const session of this.listRestorableSessions()) {
      await this.runtimes.run(session.id, 'observeSession', () => this.refreshSessionState(session, { restoreMissing: false }));
    }
  }

  private async sendLiteralTextToSession(sessionName: string, text: string): Promise<void> {
    for (const chunk of splitLiteralTextForTmux(text)) {
      await this.tmuxClient.sendLiteralText(sessionName, chunk);
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
      return provider.getLaunchCommand(project, resumeConversationRef, providerSettings);
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

    const conversations = await provider.listConversations(project, providerSettings);
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

  private async restoreSession(session: BoundSession): Promise<BoundSession | undefined> {
    if (!session.shouldRestore || session.status === 'releasing') {
      return undefined;
    }

    const dependencies = this.recoveryDependencies;
    if (!dependencies) {
      return undefined;
    }

    const project = await dependencies.projectService.getProjectBySlug(session.projectSlug);
    if (!project) {
      const failed = { ...session, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, { type: 'status', text: 'Failed to restore session: project not found.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      return undefined;
    }

    const provider = dependencies.providerRegistry.get(session.provider);
    const providerSettings = dependencies.projectService.getMergedProviderSettings(project, session.provider);
    if (!providerSettings.enabled) {
      const failed = { ...session, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, { type: 'status', text: 'Failed to restore session: provider is disabled.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      return undefined;
    }

    const resolvedSession = await this.tryResolvePendingResumeSession(session, project, provider, providerSettings);
    const launch = this.buildRecoveryLaunchCommand(resolvedSession, project, provider, providerSettings);
    if (!launch) {
      const pending = resolvedSession.conversationRef.startsWith('pending:')
        ? this.db.pendingConversations.get(resolvedSession.conversationRef)
        : undefined;
      const hasRecordedUserInput = this.hasRecordedPendingUserInput(resolvedSession);
      if (pending && !hasRecordedUserInput) {
        const ended = clearPendingConversationRestoreBinding({
          db: this.db,
          session: resolvedSession,
        });
        this.appendEvent(ended, {
          type: 'status',
          text: 'Pending session expired before its first prompt was submitted.',
          timestamp: ended.updatedAt,
        });
        this.eventBus.emit({ type: 'session.updated', session: ended });
        return undefined;
      }
      const failed = { ...resolvedSession, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      const shouldEmitFailure = resolvedSession.status !== 'error';
      this.db.boundSessions.upsert(failed);
      if (shouldEmitFailure) {
        this.appendEvent(failed, {
          type: 'status',
          text: 'Failed to restore session: no resumable conversation reference is available yet.',
          timestamp: nowIso(),
        });
        this.eventBus.emit({ type: 'session.updated', session: failed });
      }
      return undefined;
    }

    const prepared = this.ensureSessionLogPaths(resolvedSession);
    const restoring = {
      ...prepared,
      status: 'starting' as const,
      updatedAt: nowIso(),
      isWorking: false,
      pid: undefined,
    };
    this.db.boundSessions.upsert(restoring);
    this.eventBus.emit({ type: 'session.updated', session: restoring });
    this.appendEvent(restoring, { type: 'status', text: 'Restoring bound session.', timestamp: nowIso() });

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
      const rebound: BoundSession = {
        ...restoring,
        status: 'bound',
        updatedAt: nowIso(),
        pid,
      };
      this.db.boundSessions.upsert(rebound);
      this.appendEvent(rebound, { type: 'status', text: 'Restored bound session.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: rebound });
      this.watchSessionOutput(rebound);
      await this.waitForStartupOutput(rebound);
      await this.emitScreenUpdate(rebound);
      return rebound;
    } catch (error) {
      if (tmuxCreated) {
        try {
          await this.tmuxClient.killSession(restoring.tmuxSessionName);
        } catch (cleanupError) {
          void cleanupError;
        }
      }
      const failed = {
        ...restoring,
        status: 'error' as const,
        updatedAt: nowIso(),
        isWorking: false,
      };
      this.db.boundSessions.upsert(failed);
      this.appendEvent(failed, {
        type: 'status',
        text: `Failed to restore session: ${error instanceof Error ? error.message : 'Unknown error.'}`,
        timestamp: nowIso(),
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
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
  }): Promise<BoundSession> {
    const existing = this.db.boundSessions.getRestorableByConversation(input.project.slug, input.provider.id, input.conversationRef);
    const sessionId = existing?.id ?? randomUUID();
    const result = await this.runtimes.run(sessionId, 'bind', () => this.bindConversationInternal(input, sessionId));
    return result.session;
  }

  private async bindConversationInternal(input: {
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    conversationRef: string;
    title: string;
    kind: ConversationSummary['kind'];
    initialPrompt?: string;
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
      { initialPrompt: input.initialPrompt },
    );
    const now = nowIso();
    const initialPrompt = input.initialPrompt?.trim();
    const session: BoundSession = {
      id: sessionId,
      provider: input.provider.id,
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
      await this.waitForStartupOutput(boundSession);
      await this.emitScreenUpdate(boundSession);
      return sessionCommandResult(boundSession, recordedInitialUserInput);
    } catch (error) {
      if (tmuxCreated) {
        try {
          await this.tmuxClient.killSession(tmuxSessionName);
        } catch (cleanupError) {
          void cleanupError;
        }
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
    return await this.runtimes.run(sessionId, 'sendInput', () => this.sendInputInternal(sessionId, text));
  }

  private async sendInputInternal(sessionId: string, text: string): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new Error('Session is no longer running.');
    }
    await this.submitTextToSession(liveSession.tmuxSessionName, text);
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
    return await this.runtimes.run(sessionId, 'sendKeystrokes', () => this.sendKeystrokesInternal(sessionId, payload));
  }

  private async sendKeystrokesInternal(sessionId: string, payload: KeystrokeSendPayload): Promise<SessionCommandResult> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new Error('Session is no longer running.');
    }

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
          preparedScreen = await this.prepareScreenForCombinedTextSubmit(liveSession, preparedScreen);
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
      if (plan.useBracketedPasteTransport) {
        await this.tmuxClient.pasteText(liveSession.tmuxSessionName, plan.transportText);
      } else {
        await this.sendLiteralTextToSession(liveSession.tmuxSessionName, plan.transportText);
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
        latestObservedScreen = await this.prepareScreenForCombinedTextSubmit(liveSession, latestObservedScreen);
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
          await this.tmuxClient.pasteText(liveSession.tmuxSessionName, transportText);
        } else {
          await this.sendLiteralTextToSession(liveSession.tmuxSessionName, transportText);
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
      await this.tmuxClient.sendKeys(liveSession.tmuxSessionName, payload.keys ?? []);
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
    }, randomUUID());
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.runtimes.run(sessionId, 'releaseSession', () => this.releaseSessionInternal(sessionId));
  }

  private async releaseSessionInternal(sessionId: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
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
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      return undefined;
    }
    const snapshot = await this.tmuxClient.capturePane(liveSession.tmuxSessionName, options.startLine).catch(() => '');
    const screen = this.decorateScreenForSession(liveSession, parseSessionScreenSnapshot(snapshot, nowIso()));
    this.syncSessionScreenState(this.mustGetSession(liveSession.id), screen);
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
    session: BoundSession,
    options: { restoreMissing?: boolean } = {},
  ): Promise<BoundSession | undefined> {
    const restoreMissing = options.restoreMissing ?? true;
    const liveness = await checkTmuxLiveness(this.tmuxClient, session.tmuxSessionName);
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
      return undefined;
    }

    const nextStatus = session.status === 'starting' || session.status === 'error' ? 'bound' : session.status;
    const refreshed: BoundSession = nextStatus === session.status
      ? session
      : {
          ...session,
          status: nextStatus,
          updatedAt: nowIso(),
        };
    if (refreshed !== session) {
      this.db.boundSessions.upsert(refreshed);
      this.eventBus.emit({ type: 'session.updated', session: refreshed });
    }
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
    if (!session.rawLogPath) return;
    if (this.outputWatchers.has(session.id)) return;

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

  private stopWatching(sessionId: string): void {
    this.outputWatchers.stop(sessionId, { flush: true }, (chunk) => this.flushPendingChunk(sessionId, chunk));
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
            isWorking: true,
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
    this.syncSessionScreenState(this.mustGetSession(session.id), screen);
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

  private async captureSessionScreen(session: BoundSession): Promise<SessionScreen> {
    const snapshot = await this.tmuxClient.capturePane(session.tmuxSessionName).catch(() => '');
    return this.decorateScreenForSession(session, parseSessionScreenSnapshot(snapshot, nowIso()));
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

  private syncSessionScreenState(
    session: BoundSession,
    screen: SessionScreen,
  ): void {
    const next = nextScreenWorkingState(session, {
      screenShowsWorking: sessionScreenShowsWorking(screen),
      capturedAt: screen.capturedAt,
      idleMs: SESSION_COMPLETION_IDLE_MS,
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
