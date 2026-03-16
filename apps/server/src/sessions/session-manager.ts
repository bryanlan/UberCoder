import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BoundSession, ConversationSummary, ProviderId, SessionScreen } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { commandToShell } from '../lib/shell.js';
import { sleep } from '../lib/async.js';
import { normalizeComparableText, normalizeWhitespace, stableTextHash, truncate } from '../lib/text.js';
import { AppDatabase } from '../db/database.js';
import type { ActiveProject } from '../projects/project-service.js';
import type { MergedProviderSettings } from '../config/service.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { TmuxClient } from './tmux-client.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { normalizeRawOutputLines } from './live-output.js';
import { isWorkingStatusLine, parseSessionScreenSnapshot } from './session-screen.js';

interface WatchState {
  offset: number;
  watcher?: fs.FSWatcher;
  processing: boolean;
  queued: boolean;
  pendingChunk: string;
  flushTimer?: NodeJS.Timeout;
}

const WORKING_PULSE_GRACE_MS = 4_000;
const MIN_COMBINED_TEXT_KEY_SETTLE_WAIT_MS = 700;
const MAX_COMBINED_TEXT_KEY_SETTLE_WAIT_MS = 3_000;
const TEXT_ENTRY_STARTUP_SETTLE_WAIT_MS = 1_800;
const QUEUED_MESSAGE_COMPOSER_WAIT_MS = 1_200;

export class SessionKeystrokeRejectedError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionKeystrokeRejectedError';
  }
}

function sessionScreenShowsWorking(screen: SessionScreen): boolean {
  return [screen.status, screen.statusAnsi ?? '', ...screen.content.split('\n').slice(-8)]
    .flatMap((block) => block.split('\n'))
    .map((line) => normalizeWhitespace(line))
    .some((line) => isWorkingStatusLine(line));
}

function screenInputChanged(previous: SessionScreen, next: SessionScreen): boolean {
  return normalizeComparableText(previous.inputText) !== normalizeComparableText(next.inputText);
}

function screenShowsQueuedMessageHint(screen: SessionScreen): boolean {
  return `${screen.content}\n${screen.status}\n${screen.statusAnsi ?? ''}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .some((line) => /tab to queue message/i.test(line));
}

function screenIsStartingUp(screen: SessionScreen): boolean {
  const normalizedStatus = normalizeWhitespace(screen.status);
  const normalizedContent = normalizeWhitespace(screen.content);
  return /^starting session/i.test(normalizedStatus)
    || /^waiting for session output/i.test(normalizedContent)
    || /starting mcp servers/i.test(`${normalizedContent}\n${normalizedStatus}`);
}

function screenAllowsLiteralSelectionWithoutInput(screen: SessionScreen, text: string | undefined): boolean {
  if (!text || text.length > 8 || !/^[\w./:-]+$/u.test(text.trim())) {
    return false;
  }

  const normalizedLines = `${screen.content}\n${screen.status}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const trailingLines = normalizedLines.slice(-8);

  if (trailingLines.some((line) => /Enter to confirm · Esc to exit/i.test(line))) {
    return true;
  }

  if (trailingLines.some((line) => /Esc to cancel · Tab to amend/i.test(line))) {
    return true;
  }

  if (trailingLines.some((line) => /(?:^|\s)\d:\s+\S/.test(line))) {
    return true;
  }

  const numberedChoices = trailingLines.filter((line) => /^(?:[❯›>]\s*)?\d+\.\s/.test(line));
  return numberedChoices.length >= 2;
}

function latestTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (!timestamp) {
      continue;
    }
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed <= latestMs) {
      continue;
    }
    latest = timestamp;
    latestMs = parsed;
  }
  return latest;
}

function isRecentTimestamp(timestamp: string | undefined, referenceTimestamp: string, maxAgeMs: number): boolean {
  if (!timestamp) {
    return false;
  }

  const referenceMs = Date.parse(referenceTimestamp);
  const valueMs = Date.parse(timestamp);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(valueMs)) {
    return false;
  }

  return referenceMs - valueMs <= maxAgeMs;
}

function hashScreen(screen: SessionScreen): string {
  return stableTextHash(
    `${screen.contentAnsi ?? screen.content}\n---\n${screen.inputText}\n---\n${screen.statusAnsi ?? screen.status}`,
  );
}

function combinedTextKeySettleWaitMs(text: string): number {
  const lengthFactorMs = Math.max(0, text.length - 32) * 4;
  return Math.min(
    MAX_COMBINED_TEXT_KEY_SETTLE_WAIT_MS,
    Math.max(MIN_COMBINED_TEXT_KEY_SETTLE_WAIT_MS, 450 + lengthFactorMs),
  );
}

export class SessionManager {
  private readonly watchers = new Map<string, WatchState>();
  private readonly lastScreenHashes = new Map<string, string>();
  private readonly workingIdleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: AppDatabase,
    private readonly tmuxClient: TmuxClient,
    private readonly runtimeDir: string,
    private readonly eventBus: RealtimeEventBus,
  ) {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
  }

  listActiveSessions(): BoundSession[] {
    return this.db.listBoundSessions().filter((session) => ['starting', 'bound', 'releasing'].includes(session.status));
  }

  async recoverSessions(): Promise<void> {
    for (const session of this.listActiveSessions()) {
      await this.refreshSessionState(session);
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
    const existing = this.db.getBoundSessionByConversation(input.project.slug, input.provider.id, input.conversationRef);
    if (existing) {
      const liveSession = await this.refreshSessionState(existing);
      if (liveSession) {
        return liveSession;
      }
    }

    const sessionId = randomUUID();
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
    const session: BoundSession = {
      id: sessionId,
      provider: input.provider.id,
      projectSlug: input.project.slug,
      conversationRef: input.conversationRef,
      tmuxSessionName,
      status: 'starting',
      title: input.title,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      lastOutputAt: undefined,
      lastCompletedAt: undefined,
      isWorking: false,
      rawLogPath,
      eventLogPath,
    };
    this.db.upsertBoundSession(session);

    let tmuxCreated = false;
    try {
      await this.tmuxClient.newDetachedSession(tmuxSessionName, launch.cwd, commandToShell(launch.argv, launch.env));
      tmuxCreated = true;
      await this.tmuxClient.pipePaneToFile(tmuxSessionName, rawLogPath);
      await this.tmuxClient.setUserOption(tmuxSessionName, '@agent_console_session_id', sessionId);
      await this.tmuxClient.setUserOption(tmuxSessionName, '@agent_console_conversation_ref', input.conversationRef);
      await this.tmuxClient.setUserOption(tmuxSessionName, '@agent_console_provider', input.provider.id);
      const pid = await this.tmuxClient.getPanePid(tmuxSessionName);

      const boundSession: BoundSession = {
        ...session,
        status: 'bound',
        updatedAt: nowIso(),
        pid,
      };
      this.db.upsertBoundSession(boundSession);
      const initialPrompt = input.initialPrompt?.trim();
      if (initialPrompt && boundSession.conversationRef.startsWith('pending:')) {
        const pending = this.db.getPendingConversation(boundSession.conversationRef);
        if (pending) {
          const rawMetadata = { ...(pending.rawMetadata ?? {}) } as Record<string, unknown>;
          rawMetadata.lastUserInputHash = stableTextHash(normalizeComparableText(initialPrompt));
          rawMetadata.lastUserInputPreview = truncate(initialPrompt, 120);
          this.db.putPendingConversation({
            ...pending,
            updatedAt: nowIso(),
            isBound: true,
            boundSessionId: boundSession.id,
            rawMetadata,
          });
        }
        this.appendEvent(boundSession, { type: 'user-input', text: initialPrompt, timestamp: nowIso() });
      }
      this.appendEvent(boundSession, { type: 'status', text: `Bound ${input.provider.id} session in ${input.project.displayName}.`, timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: boundSession });
      this.watchSessionOutput(boundSession);
      await this.waitForStartupOutput(boundSession);
      await this.emitScreenUpdate(boundSession);
      return boundSession;
    } catch (error) {
      if (tmuxCreated) {
        try {
          await this.tmuxClient.killSession(tmuxSessionName);
        } catch {
          // Best-effort cleanup after partial launch failure.
        }
      }
      const failed: BoundSession = {
        ...session,
        status: 'error',
        updatedAt: nowIso(),
        isWorking: false,
      };
      this.db.upsertBoundSession(failed);
      this.appendEvent(failed, {
        type: 'status',
        text: `Failed to bind session: ${error instanceof Error ? error.message : 'Unknown error.'}`,
        timestamp: nowIso(),
      });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw error;
    }
  }

  async sendInput(sessionId: string, text: string): Promise<BoundSession> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new Error('Session is no longer running.');
    }
    await this.tmuxClient.sendLiteralInput(liveSession.tmuxSessionName, text);
    const updated: BoundSession = {
      ...liveSession,
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
    };
    this.db.upsertBoundSession(updated);
    if (updated.conversationRef.startsWith('pending:')) {
      const pending = this.db.getPendingConversation(updated.conversationRef);
      if (pending) {
        const rawMetadata = { ...(pending.rawMetadata ?? {}) } as Record<string, unknown>;
        rawMetadata.lastUserInputHash = stableTextHash(normalizeComparableText(text));
        rawMetadata.lastUserInputPreview = truncate(text, 120);
        this.db.putPendingConversation({
          ...pending,
          updatedAt: nowIso(),
          isBound: true,
          boundSessionId: updated.id,
          rawMetadata,
        });
      }
    }
    this.appendEvent(updated, { type: 'user-input', text, timestamp: nowIso() });
    await this.emitScreenUpdate(updated);
    return updated;
  }

  async sendKeystrokes(sessionId: string, payload: { text?: string; keys?: string[] }): Promise<BoundSession> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      throw new Error('Session is no longer running.');
    }

    const beforeScreen = await this.captureSessionScreen(liveSession);
    let latestObservedScreen = beforeScreen;
    let latestObservedHash = hashScreen(beforeScreen);

    if (payload.text) {
      if (payload.keys?.length && !screenAllowsLiteralSelectionWithoutInput(latestObservedScreen, payload.text)) {
        latestObservedScreen = await this.prepareScreenForCombinedTextSubmit(liveSession, latestObservedScreen);
        latestObservedHash = hashScreen(latestObservedScreen);
      }
      const textEntryScreen = latestObservedScreen;
      await this.tmuxClient.sendLiteralText(liveSession.tmuxSessionName, payload.text);
      if (payload.keys?.length) {
        const textSettledScreen = await this.waitForInputTextChange(
          liveSession,
          latestObservedHash,
          textEntryScreen,
          combinedTextKeySettleWaitMs(payload.text),
        );
        if (textSettledScreen) {
          latestObservedScreen = textSettledScreen;
          latestObservedHash = hashScreen(textSettledScreen);
          this.publishScreenUpdate(liveSession, textSettledScreen);
        }
        if (!screenInputChanged(textEntryScreen, latestObservedScreen) && !screenAllowsLiteralSelectionWithoutInput(textEntryScreen, payload.text)) {
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
    if (payload.keys?.length) {
      await this.tmuxClient.sendKeys(liveSession.tmuxSessionName, payload.keys);
    }

    const updated: BoundSession = {
      ...liveSession,
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
    };
    this.db.upsertBoundSession(updated);
    await this.emitScreenUpdate(updated, { waitForChange: Boolean(payload.keys?.length) });
    const afterScreen = await this.captureSessionScreen(updated);
    this.publishScreenUpdate(updated, afterScreen);
    this.appendDebugTrace(updated, {
      action: 'send-keystrokes',
      text: payload.text,
      keys: payload.keys,
      before: latestObservedScreen,
      after: afterScreen,
    });
    return updated;
  }

  async restartPendingSessionWithInitialPrompt(input: {
    sessionId: string;
    project: ActiveProject;
    provider: ProviderAdapter;
    providerSettings: MergedProviderSettings;
    initialPrompt: string;
  }): Promise<BoundSession> {
    const session = this.mustGetSession(input.sessionId);
    if (!session.conversationRef.startsWith('pending:')) {
      throw new Error('Only pending sessions can be restarted with an initial prompt.');
    }
    await this.releaseSession(session.id);
    return await this.bindConversation({
      project: input.project,
      provider: input.provider,
      providerSettings: input.providerSettings,
      conversationRef: session.conversationRef,
      title: session.title ?? 'New conversation',
      kind: 'pending',
      initialPrompt: input.initialPrompt,
    });
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    const releasing = { ...session, status: 'releasing' as const, updatedAt: nowIso(), isWorking: false };
    this.db.upsertBoundSession(releasing);
    this.eventBus.emit({ type: 'session.updated', session: releasing });
    this.appendEvent(releasing, { type: 'status', text: 'Releasing session.', timestamp: nowIso() });

    const wasAlive = await this.tmuxClient.hasSession(session.tmuxSessionName).catch(() => false);
    if (wasAlive) {
      try {
        await this.tmuxClient.interrupt(session.tmuxSessionName);
        await sleep(300);
      } catch {
        // Best effort interrupt.
      }

      try {
        await this.tmuxClient.killSession(session.tmuxSessionName);
      } catch {
        // Re-check below before claiming success.
      }
    }

    const stillAlive = await this.tmuxClient.hasSession(session.tmuxSessionName).catch(() => true);
    if (stillAlive) {
      const failed = { ...releasing, status: 'error' as const, updatedAt: nowIso(), isWorking: false };
      this.db.upsertBoundSession(failed);
      this.appendEvent(failed, { type: 'status', text: 'Failed to release tmux session cleanly.', timestamp: nowIso() });
      this.eventBus.emit({ type: 'session.updated', session: failed });
      throw new Error(`Failed to release tmux session ${session.tmuxSessionName}`);
    }

    this.stopWatching(session.id);
    this.lastScreenHashes.delete(session.id);
    const ended = { ...releasing, status: 'ended' as const, updatedAt: nowIso(), isWorking: false };
    this.db.upsertBoundSession(ended);
    if (session.conversationRef.startsWith('pending:')) {
      const pending = this.db.getPendingConversation(session.conversationRef);
      if (pending) {
        this.db.putPendingConversation({
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
    return this.db.getBoundSessionById(sessionId);
  }

  getSessionByConversation(projectSlug: string, provider: ProviderId, conversationRef: string): BoundSession | undefined {
    return this.db.getBoundSessionByConversation(projectSlug, provider, conversationRef);
  }

  async getSessionScreen(sessionId: string): Promise<{ session: BoundSession; screen: SessionScreen } | undefined> {
    const session = this.mustGetSession(sessionId);
    const liveSession = await this.refreshSessionState(session);
    if (!liveSession) {
      return undefined;
    }
    const snapshot = await this.tmuxClient.capturePane(liveSession.tmuxSessionName).catch(() => '');
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

  private mustGetSession(sessionId: string): BoundSession {
    const session = this.db.getBoundSessionById(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  private async refreshSessionState(session: BoundSession): Promise<BoundSession | undefined> {
    const alive = await this.tmuxClient.hasSession(session.tmuxSessionName).catch(() => false);
    if (!alive) {
      this.stopWatching(session.id);
      this.lastScreenHashes.delete(session.id);
      const terminalStatus = session.status === 'releasing' ? 'ended' : 'error';
      const ended: BoundSession = {
        ...session,
        status: terminalStatus,
        updatedAt: nowIso(),
        isWorking: false,
      };
      this.db.upsertBoundSession(ended);
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

    const nextStatus = session.status === 'starting' ? 'bound' : session.status;
    const refreshed: BoundSession = nextStatus === session.status
      ? session
      : {
          ...session,
          status: nextStatus,
          updatedAt: nowIso(),
        };
    if (refreshed !== session) {
      this.db.upsertBoundSession(refreshed);
      this.eventBus.emit({ type: 'session.updated', session: refreshed });
    }
    this.watchSessionOutput(refreshed);
    const repaired = this.repairIgnoredIdleOutput(refreshed);
    if (!this.lastScreenHashes.has(repaired.id)) {
      await this.emitScreenUpdate(repaired);
    }
    return repaired;
  }

  private appendEvent(session: BoundSession, event: { type: 'user-input' | 'raw-output' | 'status'; text: string; timestamp: string }): void {
    if (!session.eventLogPath) return;
    fs.appendFileSync(session.eventLogPath, `${JSON.stringify(event)}\n`);
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
    if (this.watchers.has(session.id)) return;

    const initialOffset = session.eventLogPath && fs.existsSync(session.eventLogPath) && fs.statSync(session.eventLogPath).size > 0 && fs.existsSync(session.rawLogPath)
      ? fs.statSync(session.rawLogPath).size
      : 0;
    const state: WatchState = { offset: initialOffset, processing: false, queued: false, pendingChunk: '' };
    this.watchers.set(session.id, state);
    const pump = async (): Promise<void> => {
      if (state.processing) {
        state.queued = true;
        return;
      }
      state.processing = true;
      try {
        const stat = await fsPromises.stat(session.rawLogPath!);
        if (stat.size <= state.offset) return;
        const handle = await fsPromises.open(session.rawLogPath!, 'r');
        try {
          const length = stat.size - state.offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, state.offset);
          state.offset = stat.size;
          const chunk = buffer.toString('utf8');
          if (chunk.trim()) {
            state.pendingChunk += chunk;
            this.scheduleRawOutputFlush(session.id, state);
          }
        } finally {
          await handle.close();
        }
      } catch {
        // keep watcher alive even if file is briefly unavailable
      } finally {
        state.processing = false;
        if (state.queued) {
          state.queued = false;
          void pump();
        }
      }
    };

    state.watcher = fs.watch(session.rawLogPath, { persistent: false }, () => {
      void pump();
    });
    void pump();
  }

  private stopWatching(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (state?.flushTimer) {
      clearTimeout(state.flushTimer);
      this.flushPendingChunk(sessionId, state);
    }
    state?.watcher?.close();
    this.watchers.delete(sessionId);
    this.clearWorkingExpiry(sessionId);
  }

  private clearWorkingExpiry(sessionId: string): void {
    const timer = this.workingIdleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.workingIdleTimers.delete(sessionId);
    }
  }

  private scheduleWorkingExpiry(sessionId: string, heartbeatAt: string): void {
    const heartbeatMs = Date.parse(heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      this.clearWorkingExpiry(sessionId);
      return;
    }

    const existing = this.workingIdleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const delayMs = Math.max(0, heartbeatMs + WORKING_PULSE_GRACE_MS - Date.now()) + 100;
    const timer = setTimeout(() => {
      this.workingIdleTimers.delete(sessionId);
      void this.handleWorkingIdleExpiry(sessionId, heartbeatAt);
    }, delayMs);
    this.workingIdleTimers.set(sessionId, timer);
  }

  private async handleWorkingIdleExpiry(sessionId: string, expectedHeartbeatAt: string): Promise<void> {
    try {
      const session = this.mustGetSession(sessionId);
      if (!session.isWorking) {
        this.clearWorkingExpiry(sessionId);
        return;
      }

      const latestHeartbeatAt = latestTimestamp(session.lastOutputAt, session.lastActivityAt);
      if (latestHeartbeatAt && latestHeartbeatAt !== expectedHeartbeatAt) {
        this.scheduleWorkingExpiry(sessionId, latestHeartbeatAt);
        return;
      }

      if (isRecentTimestamp(latestHeartbeatAt, nowIso(), WORKING_PULSE_GRACE_MS)) {
        if (latestHeartbeatAt) {
          this.scheduleWorkingExpiry(sessionId, latestHeartbeatAt);
        }
        return;
      }

      this.clearWorkingExpiry(sessionId);
      const completedAt = latestTimestamp(session.lastOutputAt, session.lastCompletedAt, session.lastActivityAt) ?? nowIso();
      const updated: BoundSession = {
        ...session,
        updatedAt: nowIso(),
        isWorking: false,
        lastCompletedAt: completedAt,
      };
      this.db.upsertBoundSession(updated);
      this.eventBus.emit({ type: 'session.updated', session: updated });
    } catch {
      this.clearWorkingExpiry(sessionId);
    }
  }

  private scheduleRawOutputFlush(sessionId: string, state: WatchState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      this.flushPendingChunk(sessionId, state);
    }, 120);
  }

  private flushPendingChunk(sessionId: string, state: WatchState): void {
    const chunk = state.pendingChunk;
    state.pendingChunk = '';
    if (!chunk.trim()) return;
    const now = nowIso();
    try {
      const session = this.mustGetSession(sessionId);
      const hasMeaningfulOutput = normalizeRawOutputLines(chunk).length > 0;
      const updated = hasMeaningfulOutput
        ? {
            ...session,
            updatedAt: now,
            lastActivityAt: now,
            lastOutputAt: now,
          }
        : session;
      if (hasMeaningfulOutput) {
        this.db.upsertBoundSession(updated);
        if (session.isWorking) {
          this.scheduleWorkingExpiry(sessionId, now);
        }
        this.appendEvent(updated, { type: 'raw-output', text: chunk, timestamp: now });
      }
      void this.emitScreenUpdate(updated);
    } catch {
      // Session may have ended while the debounce timer was pending.
    }
  }

  private repairIgnoredIdleOutput(session: BoundSession): BoundSession {
    if (
      session.isWorking
      || !session.lastOutputAt
      || !session.lastCompletedAt
      || session.lastCompletedAt !== session.lastOutputAt
      || !session.eventLogPath
      || !fs.existsSync(session.eventLogPath)
    ) {
      return session;
    }

    try {
      const events = fs.readFileSync(session.eventLogPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      let latestRawOutputAt: string | undefined;
      let latestMeaningfulOutputAt: string | undefined;
      let latestRawOutputWasIgnorable = false;

      for (const line of events) {
        const event = JSON.parse(line) as { type?: string; text?: string; timestamp?: string };
        if (event.type !== 'raw-output' || typeof event.text !== 'string' || typeof event.timestamp !== 'string') {
          continue;
        }
        latestRawOutputAt = event.timestamp;
        latestRawOutputWasIgnorable = normalizeRawOutputLines(event.text).length === 0;
        if (!latestRawOutputWasIgnorable) {
          latestMeaningfulOutputAt = event.timestamp;
        }
      }

      if (!latestRawOutputWasIgnorable || latestRawOutputAt !== session.lastOutputAt) {
        return session;
      }

      const repairedLastCompletedAt = latestMeaningfulOutputAt ?? session.startedAt;
      const repairedLastOutputAt = latestMeaningfulOutputAt;
      if (
        repairedLastCompletedAt === session.lastCompletedAt
        && repairedLastOutputAt === session.lastOutputAt
      ) {
        return session;
      }

      const repaired: BoundSession = {
        ...session,
        updatedAt: nowIso(),
        lastOutputAt: repairedLastOutputAt,
        lastCompletedAt: repairedLastCompletedAt,
      };
      this.db.upsertBoundSession(repaired);
      this.eventBus.emit({ type: 'session.updated', session: repaired });
      return repaired;
    } catch {
      return session;
    }
  }

  private publishScreenUpdate(session: BoundSession, screen: SessionScreen): boolean {
    const nextHash = hashScreen(screen);
    if (this.lastScreenHashes.get(session.id) === nextHash) {
      return false;
    }

    this.lastScreenHashes.set(session.id, nextHash);
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

    return screen;
  }

  private async emitScreenUpdate(session: BoundSession, options: { waitForChange?: boolean } = {}): Promise<void> {
    const previousHash = this.lastScreenHashes.get(session.id);
    const screen = await this.waitForScreenChange(
      session,
      previousHash,
      options.waitForChange ? 220 : 0,
    );
    if (screen) {
      this.publishScreenUpdate(session, screen);
    }
  }

  private syncSessionScreenState(session: BoundSession, screen: SessionScreen): void {
    const screenShowsWorking = sessionScreenShowsWorking(screen);
    const workingHeartbeatAt = latestTimestamp(
      session.lastOutputAt,
      screenShowsWorking ? session.lastActivityAt : undefined,
    );
    const nextIsWorking = screenShowsWorking && isRecentTimestamp(workingHeartbeatAt, screen.capturedAt, WORKING_PULSE_GRACE_MS);
    const nextIdleCompletion = latestTimestamp(
      session.lastCompletedAt,
      session.lastOutputAt,
    ) ?? session.startedAt ?? screen.capturedAt;

    if (nextIsWorking && workingHeartbeatAt) {
      this.scheduleWorkingExpiry(session.id, workingHeartbeatAt);
    } else {
      this.clearWorkingExpiry(session.id);
    }

    const nextLastCompletedAt = nextIsWorking
      ? session.lastCompletedAt
      : session.isWorking
        ? latestTimestamp(screen.capturedAt, session.lastOutputAt, session.lastCompletedAt) ?? screen.capturedAt
        : nextIdleCompletion;

    if (session.isWorking === nextIsWorking && session.lastCompletedAt === nextLastCompletedAt) {
      return;
    }

    const tracked: BoundSession = {
      ...session,
      updatedAt: screen.capturedAt,
      isWorking: nextIsWorking,
      lastCompletedAt: nextLastCompletedAt,
    };
    this.db.upsertBoundSession(tracked);
    this.eventBus.emit({ type: 'session.updated', session: tracked });
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
}
