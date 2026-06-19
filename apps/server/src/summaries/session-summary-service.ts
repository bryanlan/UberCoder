import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BoundSession, NormalizedMessage, ProviderId, SessionInteractionSummary } from '@agent-console/shared';
import { AppDatabase } from '../db/database.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import { isConversationVisibleInDiscovery } from '../lib/conversation-visibility.js';
import { looksLikeCodeLine, stripCodeLikeContent } from '../lib/prose-sanitizer.js';
import { nowIso } from '../lib/time.js';
import { normalizeWhitespace, truncate } from '../lib/text.js';
import type { ActiveProject, ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { readLiveMessages } from '../sessions/live-output.js';

const SUMMARY_INTERVAL_MS = 60 * 60 * 1000;
const SUMMARY_WINDOW_MS = 60 * 60 * 1000;
const MAX_MODEL_INPUT_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 700;
const MAX_SUMMARY_SENTENCES = 2;
const CODEX_SUMMARY_MODEL = 'gpt-5.3-codex-spark';
const CODEX_SUMMARY_REASONING_EFFORT = 'medium';
const CODEX_SUMMARY_TIMEOUT_MS = 8 * 60 * 1000;

interface PreparedSummaryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface SessionSummaryModelInput {
  project: ActiveProject;
  session: BoundSession;
  messages: PreparedSummaryMessage[];
  recentMessages: PreparedSummaryMessage[];
  windowStartAt: string;
  windowEndAt: string;
  lastInteractionAt?: string;
  existingTitle: string;
  canSuggestTitle: boolean;
  codexEnv: Record<string, string>;
}

export interface SessionSummaryModelOutput {
  chatSummary: string;
  recentChangesSummary: string;
  title?: string | null;
}

export type SessionSummaryRunner = (
  input: SessionSummaryModelInput,
  signal?: AbortSignal,
) => Promise<SessionSummaryModelOutput>;

export interface SessionSummaryRunOptions {
  bootstrap?: boolean;
  referenceTime?: Date;
  force?: boolean;
  onProgress?: (progress: SessionSummaryRunProgress) => void;
}

export interface SessionSummaryRunProgress {
  index: number;
  total: number;
  session: BoundSession;
  status: 'skipped' | 'summarizing' | 'ready' | 'failed';
}

interface CodexSummaryCommandInput {
  projectPath: string;
  schemaPath: string;
  outputPath: string;
  model?: string;
  reasoningEffort?: string;
}

function splitPathList(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergePathValues(primary: string | undefined, fallback: string | undefined): string | undefined {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...splitPathList(primary), ...splitPathList(fallback)]) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries.length > 0 ? entries.join(path.delimiter) : undefined;
}

export function buildCodexSummaryChildEnv(
  codexEnv: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...codexEnv,
  };
  const mergedPath = mergePathValues(codexEnv.PATH, baseEnv.PATH);
  if (mergedPath) {
    mergedEnv.PATH = mergedPath;
  }
  return mergedEnv;
}

async function resolveExecutableFromPath(executable: string, envPath: string | undefined): Promise<string | undefined> {
  const candidates = executable.includes(path.sep)
    ? [path.resolve(executable)]
    : splitPathList(envPath).map((directory) => path.join(directory, executable));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return await fs.realpath(candidate).catch(() => candidate);
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

async function resolveCodexExecutable(): Promise<string> {
  const configuredCommand = process.env.AGENT_CONSOLE_CODEX_CLI?.trim() || 'codex';
  const resolved = await resolveExecutableFromPath(configuredCommand, process.env.PATH);
  if (!resolved) {
    throw new Error(`Codex CLI executable not found: ${configuredCommand}`);
  }
  return resolved;
}

function latestTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    const parsed = Date.parse(timestamp ?? '');
    if (!Number.isFinite(parsed) || parsed <= latestMs) {
      continue;
    }
    latest = timestamp;
    latestMs = parsed;
  }
  return latest;
}

function parseTimestampMs(timestamp: string | undefined): number | undefined {
  const parsed = Date.parse(timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createAbortError(): Error {
  const error = new Error('Session summary run aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function limitSentences(value: string, maxSentences: number): string {
  const sentences = value.match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean) ?? [];
  if (sentences.length === 0) {
    return value;
  }
  return sentences.slice(0, maxSentences).join(' ');
}

function sanitizeSummaryParagraph(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = stripCodeLikeContent(value)
    .replace(/\b(?:diff|patch|stack trace|code block|snippet)\b:?/gi, '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line && !looksLikeCodeLine(line))
    .join(' ');
  const normalized = normalizeWhitespace(cleaned);
  const limited = normalized ? limitSentences(normalized, MAX_SUMMARY_SENTENCES) : '';
  return limited || fallback;
}

function sanitizeTitleSuggestion(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = normalizeWhitespace(stripCodeLikeContent(value))
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return undefined;
  }
  const words = cleaned.split(/\s+/).slice(0, 6);
  if (words.length === 0) {
    return undefined;
  }
  return words.join(' ');
}

function prepareTranscriptMessage(message: NormalizedMessage): PreparedSummaryMessage | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return undefined;
  }
  const text = truncate(stripCodeLikeContent(message.text), MAX_MESSAGE_CHARS).trim();
  if (!text) {
    return undefined;
  }
  return {
    role: message.role,
    text,
    timestamp: message.timestamp,
  };
}

function prepareMessages(messages: NormalizedMessage[]): PreparedSummaryMessage[] {
  const seen = new Set<string>();
  return messages
    .flatMap((message) => {
      const prepared = prepareTranscriptMessage(message);
      return prepared ? [prepared] : [];
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .filter((message) => {
      const key = `${message.timestamp}:${message.role}:${message.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(-MAX_MODEL_INPUT_MESSAGES);
}

function renderMessagesForPrompt(messages: PreparedSummaryMessage[]): string {
  if (messages.length === 0) {
    return 'No user or agent prose messages are available in this window.';
  }
  return messages.map((message) => (
    `[${message.timestamp}] ${message.role === 'user' ? 'User' : 'Agent'}: ${message.text}`
  )).join('\n');
}

function buildSummaryPrompt(input: SessionSummaryModelInput): string {
  return [
    'Summarize this Agent Console session for a short hover tooltip.',
    '',
    'Rules:',
    '- Use only the transcript prose supplied below.',
    '- Only summarize user and agent chat activity.',
    '- Do not include code, diffs, stack traces, command output, file contents, or raw snippets.',
    '- Do not quote the transcript.',
    '- Write compact prose. No bullets. No markdown code fences.',
    '- chatSummary must be 1-2 short sentences that remind Bryan what this session is about.',
    '- recentChangesSummary must be 1-2 short sentences describing the latest user/agent transcript activity.',
    '- Each summary field should stay under 60 words.',
    '- The title must be six words or fewer, or null when no useful title is possible.',
    '',
    `Project: ${input.project.displayName}`,
    `Provider: ${input.session.provider}`,
    `Current title: ${input.existingTitle}`,
    `Last interaction: ${input.lastInteractionAt ?? 'unknown'}`,
    `Recent window: ${input.windowStartAt} to ${input.windowEndAt}`,
    `Title allowed: ${input.canSuggestTitle ? 'yes' : 'no'}`,
    '',
    'Full session prose:',
    renderMessagesForPrompt(input.messages),
    '',
    'Last-hour prose:',
    renderMessagesForPrompt(input.recentMessages),
    '',
    'Return JSON matching the requested schema.',
  ].join('\n');
}

function parseModelOutput(raw: string): SessionSummaryModelOutput {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '';
  if (!jsonText) {
    throw new Error('Summary model did not return JSON.');
  }
  const parsed = JSON.parse(jsonText) as Partial<SessionSummaryModelOutput>;
  return {
    chatSummary: sanitizeSummaryParagraph(
      parsed.chatSummary,
      'No user or agent conversation summary is available yet.',
    ),
    recentChangesSummary: sanitizeSummaryParagraph(
      parsed.recentChangesSummary,
      'No transcript activity in the last hour.',
    ),
    title: sanitizeTitleSuggestion(parsed.title),
  };
}

export function buildCodexSummaryCommandArgs(input: CodexSummaryCommandInput): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-m',
    input.model ?? CODEX_SUMMARY_MODEL,
    '-c',
    `model_reasoning_effort="${input.reasoningEffort ?? CODEX_SUMMARY_REASONING_EFFORT}"`,
    '-s',
    'read-only',
    '-C',
    input.projectPath,
    '--output-schema',
    input.schemaPath,
    '-o',
    input.outputPath,
    '-',
  ];
}

async function ensureSummarySchema(schemaPath: string): Promise<void> {
  await fs.mkdir(path.dirname(schemaPath), { recursive: true });
  await fs.writeFile(schemaPath, `${JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['chatSummary', 'recentChangesSummary', 'title'],
    properties: {
      chatSummary: {
        type: 'string',
        description: 'One or two short prose sentences reminding Bryan what this chat is about.',
      },
      recentChangesSummary: {
        type: 'string',
        description: 'One or two short prose sentences summarizing the latest user/agent transcript activity.',
      },
      title: {
        anyOf: [
          { type: 'string' },
          { type: 'null' },
        ],
        description: 'A six-word-or-fewer chat title, or null.',
      },
    },
  }, null, 2)}\n`, 'utf8');
}

export function createCodexSessionSummaryRunner(runtimeDir: string): SessionSummaryRunner {
  let codexExecutablePromise: Promise<string> | undefined;
  const getCodexExecutable = async () => {
    codexExecutablePromise ??= resolveCodexExecutable();
    try {
      return await codexExecutablePromise;
    } catch (error) {
      codexExecutablePromise = undefined;
      throw error;
    }
  };

  return async (input, signal) => {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const summaryDir = path.join(runtimeDir, 'session-summaries');
    await fs.mkdir(summaryDir, { recursive: true });
    const schemaPath = path.join(summaryDir, 'schema.json');
    const outputPath = path.join(summaryDir, `${input.session.id}-${Date.now()}.json`);
    await ensureSummarySchema(schemaPath);

    const prompt = buildSummaryPrompt(input);
    const args = buildCodexSummaryCommandArgs({
      projectPath: input.project.path,
      schemaPath,
      outputPath,
    });
    const codexExecutable = await getCodexExecutable();
    if (signal?.aborted) {
      throw createAbortError();
    }

    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(codexExecutable, args, {
        cwd: input.project.path,
        env: buildCodexSummaryChildEnv(input.codexEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      });
      let stderr = '';
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Summary model timed out.'));
      }, CODEX_SUMMARY_TIMEOUT_MS);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 32_000) {
          stdout = stdout.slice(-32_000);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 16_000) {
          stderr = stderr.slice(-16_000);
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(signal?.aborted || isAbortError(error) ? createAbortError() : error);
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (signal?.aborted) {
          reject(createAbortError());
          return;
        }
        if (code !== 0) {
          reject(new Error(`Summary model exited with code ${code ?? 'unknown'}: ${truncate(stderr || stdout, 500)}`));
          return;
        }
        try {
          const output = await fs.readFile(outputPath, 'utf8');
          resolve(output);
        } catch {
          resolve(stdout);
        } finally {
          await fs.unlink(outputPath).catch(() => undefined);
        }
      });

      child.stdin.end(prompt);
    });

    return parseModelOutput(raw);
  };
}

export class SessionSummaryService {
  private timer?: NodeJS.Timeout;
  private runPromise?: Promise<void>;
  private abortController?: AbortController;

  constructor(
    private readonly db: AppDatabase,
    private readonly projectService: Pick<ProjectService, 'listActiveProjects' | 'getMergedProviderSettings'>,
    private readonly providerRegistry: Pick<ProviderRegistry, 'get'>,
    private readonly runtimeDir: string,
    private readonly eventBus: RealtimeEventBus,
    private readonly runner: SessionSummaryRunner = createCodexSessionSummaryRunner(runtimeDir),
  ) {}

  start(): void {
    void this.runOnce({ bootstrap: true });
    this.timer = setInterval(() => {
      void this.runOnce({ bootstrap: false });
    }, SUMMARY_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController?.abort();
    await this.runPromise?.catch(() => undefined);
  }

  async runOnce(options: SessionSummaryRunOptions = {}): Promise<void> {
    if (this.runPromise) {
      await this.runPromise;
      return;
    }
    const abortController = new AbortController();
    this.abortController = abortController;
    this.runPromise = this.performRun(options, abortController.signal).finally(() => {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
      this.runPromise = undefined;
    });
    await this.runPromise;
  }

  private async performRun(options: SessionSummaryRunOptions, signal: AbortSignal): Promise<void> {
    const referenceTime = options.referenceTime ?? new Date();
    const activeProjects = await this.projectService.listActiveProjects();
    if (signal.aborted) {
      return;
    }
    const projectMap = new Map(activeProjects.map((project) => [project.slug, project]));
    const activeSessions = this.db.listBoundSessions()
      .filter((session) => (
        isTreeVisibleBoundSession(session)
        && projectMap.has(session.projectSlug)
        && this.isSessionVisibleInDiscovery(session)
      ));

    let index = 0;
    for (const session of activeSessions) {
      index += 1;
      if (signal.aborted) {
        return;
      }
      const project = projectMap.get(session.projectSlug);
      if (!project) {
        continue;
      }
      const existing = this.db.getSessionInteractionSummary(session.id);
      if (!options.force && !this.shouldSummarizeSession(session, existing, referenceTime, Boolean(options.bootstrap))) {
        options.onProgress?.({ index, total: activeSessions.length, session, status: 'skipped' });
        continue;
      }
      options.onProgress?.({ index, total: activeSessions.length, session, status: 'summarizing' });
      let failed = false;
      await this.summarizeSession(project, session, referenceTime, existing, signal).catch((error) => {
        if (signal.aborted || isAbortError(error)) {
          return;
        }
        failed = true;
        this.recordFailure(session, referenceTime, error);
      });
      if (!signal.aborted) {
        options.onProgress?.({ index, total: activeSessions.length, session, status: failed ? 'failed' : 'ready' });
      }
    }
  }

  private shouldSummarizeSession(
    session: BoundSession,
    existing: SessionInteractionSummary | undefined,
    referenceTime: Date,
    bootstrap: boolean,
  ): boolean {
    const lastInteractionAt = this.getLastInteractionAt(session);
    const lastInteractionMs = parseTimestampMs(lastInteractionAt);
    if (!lastInteractionAt || lastInteractionMs === undefined) {
      return bootstrap && !existing;
    }

    const existingInteractionMs = parseTimestampMs(existing?.lastInteractionAt);
    if (existingInteractionMs !== undefined && lastInteractionMs <= existingInteractionMs && existing?.status === 'ready') {
      return false;
    }

    if (bootstrap && !existing) {
      return true;
    }

    return referenceTime.getTime() - lastInteractionMs <= SUMMARY_WINDOW_MS;
  }

  private async summarizeSession(
    project: ActiveProject,
    session: BoundSession,
    referenceTime: Date,
    existing: (SessionInteractionSummary & { titleSuggestedAt?: string }) | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const messages = await this.loadMessages(project, session);
    if (signal.aborted) {
      return;
    }
    const latestMessageAt = messages.at(-1)?.timestamp;
    const lastInteractionAt = latestMessageAt
      ?? this.getLastInteractionAt(session)
      ?? session.startedAt;
    const windowEndMs = parseTimestampMs(lastInteractionAt) ?? referenceTime.getTime();
    const windowEndAt = new Date(windowEndMs).toISOString();
    const windowStartMs = windowEndMs - SUMMARY_WINDOW_MS;
    const windowStartAt = new Date(windowStartMs).toISOString();
    const recentMessages = messages.filter((message) => {
      const timestampMs = parseTimestampMs(message.timestamp);
      return timestampMs !== undefined && timestampMs >= windowStartMs && timestampMs <= windowEndMs;
    });
    const canSuggestTitle = !existing?.titleSuggestedAt
      && !this.db.getConversationTitleOverride(session.projectSlug, session.provider, session.conversationRef);

    const output = messages.length === 0
      ? {
          chatSummary: 'No user or agent conversation text is available yet.',
          recentChangesSummary: 'No transcript activity in the last hour.',
          title: undefined,
        }
      : await this.runner({
          project,
          session,
          messages,
          recentMessages,
          windowStartAt,
          windowEndAt,
          lastInteractionAt,
          existingTitle: session.title ?? 'Live session',
          canSuggestTitle,
          codexEnv: this.projectService.getMergedProviderSettings(project, 'codex').commands.env,
        }, signal);
    if (signal.aborted) {
      return;
    }

    const generatedAt = nowIso();
    const titleApplication = this.resolveTitleSuggestionApplication(session, output.title, canSuggestTitle);
    const titleSuggestion = titleApplication?.title;
    const titleSuggestedAt = titleSuggestion ? generatedAt : undefined;
    this.db.upsertSessionInteractionSummary({
      sessionId: session.id,
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      status: 'ready',
      generatedAt,
      windowStartAt,
      windowEndAt,
      lastInteractionAt,
      chatSummary: sanitizeSummaryParagraph(output.chatSummary, 'No user or agent conversation summary is available yet.'),
      recentChangesSummary: recentMessages.length === 0
        ? 'No transcript activity in the last hour.'
        : sanitizeSummaryParagraph(output.recentChangesSummary, 'No transcript activity in the last hour.'),
      titleSuggestion,
      titleSuggestedAt,
    });

    if (titleApplication) {
      this.applyTitleSuggestion(titleApplication.session, titleApplication.title, generatedAt);
    }

    this.eventBus.emit({
      type: 'conversation.index-updated',
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      timestamp: generatedAt,
    });
  }

  private async loadMessages(project: ActiveProject, session: BoundSession): Promise<PreparedSummaryMessage[]> {
    const providerSettings = this.projectService.getMergedProviderSettings(project, session.provider as ProviderId);
    const provider = this.providerRegistry.get(session.provider);
    const transcriptMessages = providerSettings.enabled && !session.conversationRef.startsWith('pending:')
      ? (await provider.getConversation(project, session.conversationRef, providerSettings))?.messages ?? []
      : [];
    const liveMessages = await readLiveMessages(session);
    return prepareMessages([...transcriptMessages, ...liveMessages]);
  }

  private getLastInteractionAt(session: BoundSession): string | undefined {
    return latestTimestamp(
      session.lastActivityAt,
      session.lastCompletedAt,
      session.lastOutputAt,
      session.startedAt,
    );
  }

  private isSessionVisibleInDiscovery(session: BoundSession): boolean {
    const title = session.conversationRef.startsWith('pending:')
      ? this.db.getPendingConversation(session.conversationRef)?.title
      : this.db.getConversationIndexEntry(session.projectSlug, session.provider, session.conversationRef)?.title;
    return isConversationVisibleInDiscovery({ title: title ?? session.title ?? 'Live session' });
  }

  private resolveTitleSuggestionApplication(
    session: BoundSession,
    rawTitle: string | null | undefined,
    canSuggestTitle: boolean,
  ): { session: BoundSession; title: string } | undefined {
    if (!canSuggestTitle) {
      return undefined;
    }
    const title = sanitizeTitleSuggestion(rawTitle);
    if (!title) {
      return undefined;
    }
    const latestSession = this.db.getBoundSessionById(session.id);
    if (
      !latestSession
      || latestSession.projectSlug !== session.projectSlug
      || latestSession.provider !== session.provider
      || latestSession.conversationRef !== session.conversationRef
      || latestSession.status === 'ended'
      || latestSession.shouldRestore === false
    ) {
      return undefined;
    }
    const currentOverride = this.db.getConversationTitleOverride(
      latestSession.projectSlug,
      latestSession.provider,
      latestSession.conversationRef,
    );
    return currentOverride ? undefined : { session: latestSession, title };
  }

  private applyTitleSuggestion(session: BoundSession, title: string, updatedAt: string): void {
    this.db.setConversationTitleOverride(session.projectSlug, session.provider, session.conversationRef, title, updatedAt);
    const updatedSession = {
      ...session,
      title,
      updatedAt,
    };
    this.db.upsertBoundSession(updatedSession);
    this.eventBus.emit({ type: 'session.updated', session: updatedSession });
  }

  private recordFailure(session: BoundSession, referenceTime: Date, error: unknown): void {
    const timestamp = nowIso();
    this.db.upsertSessionInteractionSummary({
      sessionId: session.id,
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      status: 'failed',
      failedAt: timestamp,
      generatedAt: timestamp,
      windowStartAt: new Date(referenceTime.getTime() - SUMMARY_WINDOW_MS).toISOString(),
      windowEndAt: referenceTime.toISOString(),
      lastInteractionAt: this.getLastInteractionAt(session),
      lastError: error instanceof Error ? error.message : 'Unknown summary failure.',
    });
    this.eventBus.emit({
      type: 'conversation.index-updated',
      projectSlug: session.projectSlug,
      provider: session.provider,
      conversationRef: session.conversationRef,
      timestamp,
    });
  }
}
