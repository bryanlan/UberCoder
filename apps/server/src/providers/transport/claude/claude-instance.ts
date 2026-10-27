// The Claude plugin as a `TransportInstance`: one `claude` process per conversation (`processModel: 'per-session'`).
//
// `start` mints a session id and launches `claude --session-id <id>`; `resume` launches `claude --resume <id>`. Both
// spawn through the host's `LineTransportFactory` (a session host relay in production, so the process outlives a
// backend restart; `hostId` is `claude-<conversationId>`) and fall back to a plain stdio child when the host gives
// none. A backend restart finds the process still running behind its host: `resume` then reattaches (with the argv
// the process was launched with, recorded in plugin meta, because the host is keyed by it) instead of spawning, and
// `reattach` adopts such a survivor without ever starting a process when there is none.
// After a spawn they run the handshake: an `initialize` control request (carrying the appended system prompt,
// so it stays out of `ps`), the launch checks, and only then hand over a ready {@link ClaudeSession}. Nothing here
// makes a model call: `probe` and the handshake only read what `initialize` answers.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LineTransportNotRunningError,
  ResumeFailedError,
  TransportBusyError,
  TransportUnavailableError,
  type LineTransport,
  type LineTransportFactory,
  type OpenOptions,
  type PluginContext,
  type TransportInstance,
} from '../types.js';
import { createStdioLineTransportFactory, transportStartedFresh, type LineTransportRequest } from '../line-transport.js';
import { redactFreeText } from '../codex/redact.js';
import { ClaudeLaunchRefusedError, ClaudeSessionHeldError } from './errors.js';
import {
  asString,
  isRecord,
  type ClaudeFrame,
  type ClaudeResultFrame,
  type InitializeResponseBody,
} from './protocol.js';
import {
  CLAUDE_CAPABILITIES,
  ClaudeSession,
  DEFAULT_TIMINGS,
  type ClaudeLogger,
  type ClaudeTimings,
} from './claude-session.js';
import { ClaudeControlError, ClaudeControlTimeoutError, ClaudeExitError, describeExit, StreamJsonClient } from './stream-json.js';
import { claudeConfigDir, expectedTranscriptPaths, findSessionHolder, locateTranscripts, transcriptHasConversation } from './transcript.js';

export const DEFAULT_CLAUDE_COMMAND = ['claude'];

/**
 * `structuredSessions.claude` in the Console config. Same shape as the Codex block: the host merges the Console's
 * coordination variables into `env` first; `enabled` and `idleUnloadMinutes` are the host's.
 */
export interface ClaudeStructuredConfig {
  enabled: boolean;
  /** The `claude` executable and any leading arguments. Defaults to `['claude']`. */
  command: string[];
  idleUnloadMinutes: number;
  env: Record<string, string>;
}

/**
 * `OpenOptions` plus what only this plugin uses. The contract's `OpenOptions` has no place for them, so the host passes
 * them on the same object and this plugin reads them through this type (a documented cast, not a second code path).
 */
export interface ClaudeOpenOptions extends OpenOptions {
  /** The grant authority text, appended to the system prompt through `initialize`. */
  appendSystemPrompt?: string;
  /**
   * `'off'` launches with `--system-prompt-snapshot off`. The CLI records the system prompt on a conversation's first
   * request and replays that record on every resume, so changed appended text reaches a resumed conversation only
   * with this set (or after compaction).
   */
  systemPromptSnapshot?: 'off';
  /** `start` only: launch under this id instead of a new one. Valid only when the id has no transcript yet. */
  sessionId?: string;
}

/** Test and embedding hooks. Production code passes none of them. */
export interface ClaudePluginOptions {
  timings?: Partial<ClaudeTimings>;
  /** The environment the child inherits. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** The home directory used for `~` and `~/.claude`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Spawns the process. Defaults to the factory on the plugin context, then to a plain stdio child. */
  lineTransport?: LineTransportFactory;
  /**
   * Refuse a launch that shows no `SessionStart` hook (the CLI came up in bare mode, which skips the Console's
   * coordination hooks). Defaults to true when coordination is enabled.
   */
  requireHooks?: boolean;
  /** Refuse a launch on an API key instead of the subscription login. Defaults to true. */
  requireSubscriptionLogin?: boolean;
}

/** Variables that carry the identity of whatever started this process; the child must not inherit them. */
const SCRUBBED_EXACT = new Set(['CLAUDECODE', 'TMUX', 'TMUX_PANE', 'CODEX_THREAD_ID']);

function isScrubbedKey(key: string): boolean {
  return SCRUBBED_EXACT.has(key);
}

/**
 * `CLAUDE_CODE_*` in the inherited environment describes the session that started the backend (its entrypoint, its
 * session id, its settings), so none of it reaches a conversation's process. The same prefix in the Console config
 * (`structuredSessions.claude.env`) was typed on purpose and passes through, for example `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
 * The plugin does not vet that config. Keys that do harm there, as far as this plugin can tell:
 *  - `CLAUDE_CODE_SDK_READS_SESSION_STATE`: set last in {@link buildClaudeEnv}, so the config cannot turn it off;
 *  - login-source switches (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`): the launch
 *    runs on another account or fails the subscription-login check;
 *  - anything that starts the CLI in bare mode or disables hooks: the SessionStart check refuses the launch;
 *  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`: hides the background work the idle guard looks for;
 *  - session identity keys (`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`): they make the CLI report the wrong origin.
 */
function isInheritedIdentityKey(key: string): boolean {
  return isScrubbedKey(key) || key.startsWith('CLAUDE_CODE_');
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/**
 * The child's environment. The inherited environment loses everything that names another session (`CLAUDECODE`,
 * `CLAUDE_CODE_*`, `TMUX`, `CODEX_THREAD_ID`, `AGENT_CONSOLE_*`, `AGENT_COORD_*`), plus `NODE_OPTIONS` and `DEBUG`
 * (which can change what the CLI writes). The configured and per-session values go on top with `~` expanded, minus the
 * identity variables that name another session (`CLAUDECODE`, `TMUX`, `TMUX_PANE`, `CODEX_THREAD_ID`); a configured
 * `CLAUDE_CODE_*` key is kept (see {@link isInheritedIdentityKey}). Then this session's identity and the flag that makes the
 * CLI report the authoritative turn end (`system/session_state_changed`) are set.
 */
export function buildClaudeEnv(input: {
  base: NodeJS.ProcessEnv;
  configEnv?: Record<string, string>;
  optionsEnv?: Record<string, string>;
  conversationId?: string;
  home?: string;
}): Record<string, string> {
  const home = input.home ?? os.homedir();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || isInheritedIdentityKey(key) || key.startsWith('AGENT_CONSOLE_') || key.startsWith('AGENT_COORD_') || key === 'NODE_OPTIONS' || key === 'DEBUG') continue;
    env[key] = value;
  }
  for (const layer of [input.configEnv, input.optionsEnv]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (isScrubbedKey(key)) continue;
      env[key] = expandHome(value, home);
    }
  }
  if (input.conversationId) env.AGENT_CONSOLE_SESSION_ID = input.conversationId;
  env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1';
  return env;
}

/** The argv for a conversation process. No `-p`: stream-json input implies print mode, and `-p` may gain `--bare`. */
export function buildClaudeArgv(input: {
  command: string[];
  mode: 'new' | 'resume';
  sessionId: string;
  model?: string;
  effort?: string;
  mcpConfig?: string;
  snapshotOff?: boolean;
}): string[] {
  return [
    ...input.command,
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    // The Console decides what the agent may do; this keeps the CLI from prompting for anything but the few things
    // that always ask (AskUserQuestion, explicit ask rules), which arrive as `can_use_tool` control requests.
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
    input.mode === 'resume' ? '--resume' : '--session-id', input.sessionId,
    ...(input.mcpConfig ? ['--mcp-config', input.mcpConfig] : []),
    ...(input.snapshotOff ? ['--system-prompt-snapshot', 'off'] : []),
  ];
}

/** The per-session coordination MCP server, as the tmux launch passes it. */
export function buildMcpConfig(coordination: NonNullable<PluginContext['coordination']>, conversationId: string): string {
  return JSON.stringify({
    mcpServers: {
      agent_console_coordination: {
        command: 'node',
        args: [coordination.helperPath, 'mcp'],
        env: { AGENT_COORD_RUNTIME: coordination.runtimeDir, AGENT_CONSOLE_SESSION_ID: conversationId },
      },
    },
  });
}

function isMissingBinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ((error as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code);
  return code === 'ENOENT';
}

function errorText(error: unknown): string {
  return redactFreeText(error instanceof Error ? error.message : String(error), 500);
}

/** Process and transport problems become `TransportUnavailableError`; refusals the caller must see stay as they are. */
export function toTransportError(error: unknown): Error {
  if (error instanceof ClaudeLaunchRefusedError || error instanceof ResumeFailedError || error instanceof TransportUnavailableError) return error;
  if (error instanceof ClaudeExitError || error instanceof ClaudeControlTimeoutError || error instanceof ClaudeControlError || isMissingBinary(error)) {
    const unavailable = new TransportUnavailableError(`Claude is not available: ${errorText(error)}`);
    unavailable.cause = error;
    return unavailable;
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** What the handshake found out about the process. */
interface Found {
  /** The requests the process already had open (reattach only). */
  pending: unknown;
  /** `unknown`: a process found again that would not say. */
  running: 'idle' | 'running' | 'unknown';
}

export class ClaudeInstance implements TransportInstance {
  readonly plugin = 'claude';
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly log: ClaudeLogger;
  readonly timings: ClaudeTimings;

  private readonly config: ClaudeStructuredConfig;
  private readonly context: PluginContext;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly factory: LineTransportFactory;
  private readonly requireHooks: boolean;
  private readonly requireSubscriptionLogin: boolean;
  private readonly sessions = new Map<string, ClaudeSession>();
  /** Session ids being launched right now: a second launch of the same id would be a second writer. */
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(config: ClaudeStructuredConfig, context: PluginContext, options: ClaudePluginOptions = {}) {
    this.config = config;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.home = options.homeDir ?? os.homedir();
    this.factory = options.lineTransport ?? context.lineTransport ?? createStdioLineTransportFactory({ log: context.log });
    this.requireHooks = options.requireHooks ?? context.coordination !== undefined;
    this.requireSubscriptionLogin = options.requireSubscriptionLogin ?? true;
  }

  /** Sessions with a live process, by native id. */
  get openSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // -------------------------------------------------------------------------------------------------------
  // TransportInstance

  async alive(): Promise<{ pid?: number; connected: boolean }> {
    const live = [...this.sessions.values()].filter((session) => !session.isEnded);
    const pid = live.find((session) => session.pid !== undefined)?.pid;
    return { ...(pid !== undefined ? { pid } : {}), connected: live.length > 0 };
  }

  /**
   * A throwaway process answers `initialize` (models, account, version) and gets end of input. It never receives a
   * message, so no model call is made and nothing is stored (`--no-session-persistence`).
   */
  async probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }> {
    const deadline = Date.now() + this.timings.probeDeadlineMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    const argv = [
      ...this.command(),
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--session-id', randomUUID(),
      '--no-session-persistence',
      // The probe is not a conversation: the Console's coordination hooks must not run for it.
      '--settings', JSON.stringify({ disableAllHooks: true }),
    ];
    let transport: LineTransport;
    try {
      const request: LineTransportRequest = {
        argv,
        cwd,
        env: buildClaudeEnv({ base: this.baseEnv, configEnv: this.config.env, home: this.home }),
        closeGraceMs: Math.min(2_000, this.timings.closeGraceMs),
        termGraceMs: this.timings.termGraceMs,
      };
      transport = await this.factory(request);
    } catch (error) {
      if (isMissingBinary(error)) return { installed: false, auth: 'unknown', models: [] };
      throw toTransportError(error);
    }
    const client = new StreamJsonClient({ transport, log: this.log, label: 'claude probe', controlTimeoutMs: this.timings.controlTimeoutMs });
    try {
      const reply = await client.sendControl({ subtype: 'initialize' }, { timeoutMs: Math.min(left(), this.timings.initializeTimeoutMs) });
      const body = (reply.response ?? {}) as InitializeResponseBody;
      const models: Array<{ id: string; label: string; efforts?: string[] }> = [];
      const seen = new Set<string>();
      for (const model of Array.isArray(body.models) ? body.models : []) {
        if (!isRecord(model) || typeof model.value !== 'string' || seen.has(model.value)) continue;
        seen.add(model.value);
        models.push({
          id: model.value,
          label: typeof model.displayName === 'string' && model.displayName.length > 0 ? model.displayName : model.value,
          ...(Array.isArray(model.supportedEffortLevels) ? { efforts: model.supportedEffortLevels.filter((level): level is string => typeof level === 'string') } : {}),
        });
      }
      return { installed: true, ...(body.claude_code_version ? { version: body.claude_code_version } : {}), auth: authFromAccount(body.account), models };
    } catch (error) {
      throw toTransportError(error);
    } finally {
      await this.endProbeProcess(client);
    }
  }

  async start(options: OpenOptions): Promise<ClaudeSession> {
    const claude = options as ClaudeOpenOptions;
    const sessionId = claude.sessionId ?? randomUUID();
    const configDir = this.configDirFor(claude);
    if (claude.sessionId) {
      // Reusing an id is for a conversation whose first prompt never reached the model: it has no transcript.
      const existing = locateTranscripts(configDir, claude.cwd, sessionId);
      if (existing.length > 0) throw new TransportUnavailableError(`Claude session ${sessionId} already has a transcript; resume it instead.`);
      this.assertNotHeld(configDir, sessionId);
    }
    return this.launch('new', sessionId, claude, configDir);
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<ClaudeSession> {
    const claude = options as ClaudeOpenOptions;
    const configDir = this.configDirFor(claude);
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new ClaudeSessionHeldError(nativeSessionId, loaded.pid ?? process.pid);
    const recorded = this.readLaunchRecord(claude.conversationId, nativeSessionId);
    if (recorded) {
      // After a backend restart the holder is usually our own process, still running behind its session host. It is ours
      // when this plugin recorded how it was launched and the host answers for exactly that command line. Only a
      // connection that starts nothing is made here: a process started beside a holder would be a second writer.
      if (this.disposed) throw new TransportUnavailableError('The Claude instance was shut down.');
      const survivor = await this.adoptSurvivor(nativeSessionId, claude, recorded.argv);
      if (survivor) return survivor;
    }
    // The CLI does not stop two processes writing one transcript, so this is the only check there is. A holder that is
    // still there once our own survivor (if any) is out of the way is somebody else's process.
    const holder = findSessionHolder(configDir, nativeSessionId);
    if (holder) throw new ClaudeSessionHeldError(nativeSessionId, holder.pid);
    let conversation: string | undefined;
    const files = locateTranscripts(configDir, claude.cwd, nativeSessionId);
    for (const file of files) {
      if (await transcriptHasConversation(file)) {
        conversation = file;
        break;
      }
    }
    if (!conversation) {
      // The CLI writes a conversation only once a prompt reaches the model, so a chat that never ran a turn (or lost its
      // process before the first prompt got through) has no transcript, or only preamble, and `--resume` cannot find it.
      // Its id is unused, so launch it again under the same id: the conversation is still the Console's, and it was empty.
      // A chat that did complete a turn is another matter: its transcript was removed (the CLI deletes old ones) or moved, and
      // starting over under its id would silently drop the history, so that stays a failed resume with a clear reason.
      if (this.conversationRan(claude.conversationId, nativeSessionId)) {
        throw new ResumeFailedError(`The saved Claude conversation for session ${nativeSessionId} is gone (its transcript was not found), so it cannot be resumed. Start a new conversation.`);
      }
      this.log.info({ sessionId: nativeSessionId, transcripts: files.length }, 'claude has no conversation for this session; starting it again under the same id');
      const session = await this.launch('new', nativeSessionId, claude, configDir);
      session.noteNoHistory();
      return session;
    }
    return this.launch('resume', nativeSessionId, claude, configDir, { transcriptPath: conversation });
  }

  /**
   * Adopts this conversation's process when one outlived a backend restart behind its session host, and resolves undefined
   * when there is none. Unlike `resume` it never starts a process: the connection is made with `attachOnly`, which finds a
   * live host that runs exactly the command line this plugin recorded for the conversation or reports that none does.
   *
   * The process is the conversation's own when the recorded launch names this native id, the host id is the
   * conversation's (`claude-<conversationId>`) and the host's command line hash matches the recorded argv. It is the
   * only writer when no other live process holds the session in the CLI's registry; a holder that is not the host's child
   * is another writer, and the survivor is let go (disconnected, still running) with {@link ClaudeSessionHeldError}.
   *
   * A survivor that already ran its handshake is initialized again, which only reads what it still has open and what it is
   * doing (the CLI allows a repeated `initialize`, for example after a reconnect): the open requests, `session_state`
   * (a process that is not idle is in the middle of a turn, which the session then tracks as an adopted provider turn) and
   * the snapshot of its background tasks. One the earlier backend never spoke to is handshaken as a new launch, with its
   * SessionStart hook frames replayed. A host that runs but does not answer in time is left alone and reported as
   * {@link TransportBusyError}; it is not "no survivor". That is the only busy case: a handshake that fails after the
   * connection was made (a refusal, a timeout, an exit) throws the ordinary error, so the caller treats the process as lost.
   */
  async reattach(nativeSessionId: string, options: OpenOptions): Promise<ClaudeSession | undefined> {
    if (this.disposed) return undefined;
    const claude = options as ClaudeOpenOptions;
    const recorded = this.readLaunchRecord(claude.conversationId, nativeSessionId);
    // No record, or one that names another conversation's process: there is nothing of ours to find.
    if (!recorded || !argvNamesSession(recorded.argv, nativeSessionId)) return undefined;
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new ClaudeSessionHeldError(nativeSessionId, loaded.pid ?? process.pid);
    return this.adoptSurvivor(nativeSessionId, claude, recorded.argv);
  }

  /** `attachSurvivor` with the instance's `opening` guard held: two connections to one conversation's process are never made at once. */
  private async adoptSurvivor(sessionId: string, options: ClaudeOpenOptions, argv: string[]): Promise<ClaudeSession | undefined> {
    if (this.opening.has(sessionId)) throw new ClaudeSessionHeldError(sessionId, process.pid);
    this.opening.add(sessionId);
    try {
      return await this.attachSurvivor(sessionId, options, argv);
    } finally {
      this.opening.delete(sessionId);
    }
  }

  /**
   * The backend is going away or the instance is being replaced. Behind a session host the processes keep running for
   * the next backend (the connection just closes); a plain stdio child is ended.
   */
  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    this.disposed = true;
    this.log.info({ reason, sessions: this.sessions.size }, 'claude instance disposed');
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.detach()));
  }

  // -------------------------------------------------------------------------------------------------------
  // Launch

  private command(): string[] {
    return this.config.command.length > 0 ? this.config.command : DEFAULT_CLAUDE_COMMAND;
  }

  private configDirFor(options: OpenOptions): string {
    const merged = buildClaudeEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, home: this.home });
    return claudeConfigDir(merged, this.home);
  }

  private assertNotHeld(configDir: string, sessionId: string): void {
    const loaded = this.sessions.get(sessionId);
    if (loaded && !loaded.isEnded) throw new ClaudeSessionHeldError(sessionId, loaded.pid ?? process.pid);
    const holder = findSessionHolder(configDir, sessionId);
    if (holder) throw new ClaudeSessionHeldError(sessionId, holder.pid);
  }

  // The command line a conversation's process was launched with. A session host is keyed by it, so a backend restart
  // must present exactly this one to find the process again (a resume would otherwise use `--resume` where the launch
  // used `--session-id`, and a profile switched since would differ in `--model`).
  private launchKey(conversationId: string): string {
    return `claude-launch:${conversationId}`;
  }

  // Whether a conversation ever completed a turn. The launch record cannot say: it goes with the process (an idle sleep ends
  // the process), and the history question comes up exactly then. This record stays until the service ends the conversation.
  private ranKey(conversationId: string): string {
    return `claude-turns:${conversationId}`;
  }

  private noteConversationRan(conversationId: string, sessionId: string): void {
    if (this.conversationRan(conversationId, sessionId)) return;
    this.context.meta.set(this.ranKey(conversationId), JSON.stringify({ sessionId, firstTurnCompletedAt: new Date().toISOString() }));
  }

  /**
   * A conversation that has history this plugin never saw complete: a row moved over from tmux, or one whose turns completed
   * before the record above existed. Without the record `resume` would take a transcript the CLI has since deleted (it removes
   * old ones) for a chat that never ran, and relaunch it empty under the same id.
   */
  noteConversationHistory(conversationId: string, nativeSessionId: string): void {
    this.noteConversationRan(conversationId, nativeSessionId);
  }

  private conversationRan(conversationId: string, sessionId: string): boolean {
    const stored = this.context.meta.get(this.ranKey(conversationId));
    if (!stored) return false;
    try {
      return (JSON.parse(stored) as { sessionId?: unknown }).sessionId === sessionId;
    } catch {
      return false;
    }
  }

  private forgetLaunch(conversationId: string, sessionId: string): void {
    if (this.readLaunchRecord(conversationId, sessionId)) this.context.meta.delete(this.launchKey(conversationId));
  }

  private readLaunchRecord(conversationId: string, sessionId: string): { argv: string[] } | undefined {
    const stored = this.context.meta.get(this.launchKey(conversationId));
    if (!stored) return undefined;
    try {
      const record = JSON.parse(stored) as { sessionId?: unknown; argv?: unknown };
      if (record.sessionId !== sessionId || !Array.isArray(record.argv) || !record.argv.every((entry) => typeof entry === 'string')) return undefined;
      return { argv: record.argv as string[] };
    } catch {
      return undefined;
    }
  }

  private async launch(
    mode: 'new' | 'resume',
    sessionId: string,
    options: ClaudeOpenOptions,
    configDir: string,
    extra: { transcriptPath?: string } = {},
  ): Promise<ClaudeSession> {
    if (this.disposed) throw new TransportUnavailableError('The Claude instance was shut down.');
    if (!fs.existsSync(options.cwd)) throw new TransportUnavailableError(`The working directory does not exist: ${options.cwd}`);
    if (this.opening.has(sessionId)) throw new ClaudeSessionHeldError(sessionId, process.pid);
    this.opening.add(sessionId);
    try {
      return await this.launchProcess(mode, sessionId, options, configDir, extra);
    } finally {
      this.opening.delete(sessionId);
    }
  }

  private async launchProcess(
    mode: 'new' | 'resume',
    sessionId: string,
    options: ClaudeOpenOptions,
    configDir: string,
    extra: { transcriptPath?: string },
  ): Promise<ClaudeSession> {
    const env = buildClaudeEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const argv = buildClaudeArgv({
      command: this.command(),
      mode,
      sessionId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(this.context.coordination ? { mcpConfig: buildMcpConfig(this.context.coordination, options.conversationId) } : {}),
      snapshotOff: options.systemPromptSnapshot === 'off',
    });
    const request: LineTransportRequest = {
      argv,
      cwd: options.cwd,
      env,
      hostId: hostIdFor(options.conversationId),
      closeGraceMs: this.timings.closeGraceMs,
      termGraceMs: this.timings.termGraceMs,
      // Asks for what the process printed before we connect: the SessionStart hook frames come first. The factory honours
      // it for a process it starts (or one nobody has written to yet) and never replays a used process's old output.
      sinceSeq: 0,
    };
    let transport: LineTransport;
    try {
      transport = await this.factory(request);
    } catch (error) {
      throw toTransportError(error);
    }
    // A fresh channel means the process was just started (or never used); otherwise a process from an earlier backend,
    // already initialized and possibly in the middle of a turn, was found again.
    const fresh = transportStartedFresh(transport);
    return this.bringUp(transport, fresh, mode, sessionId, options, configDir, argv, extra.transcriptPath);
  }

  /** `reattach`, with the instance's `opening` guard held: connect to the survivor, check the one-writer rule, run the handshake. */
  private async attachSurvivor(sessionId: string, options: ClaudeOpenOptions, argv: string[]): Promise<ClaudeSession | undefined> {
    const configDir = this.configDirFor(options);
    const env = buildClaudeEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const request: LineTransportRequest = {
      argv,
      cwd: options.cwd,
      env,
      hostId: hostIdFor(options.conversationId),
      attachOnly: true,
      closeGraceMs: this.timings.closeGraceMs,
      termGraceMs: this.timings.termGraceMs,
    };
    let nothingRuns = false;
    let unreachable = false;
    const connect = async (replayFromStart: boolean): Promise<LineTransport | undefined> => {
      try {
        return await this.factory(replayFromStart ? { ...request, sinceSeq: 0 } : request);
      } catch (error) {
        if (error instanceof LineTransportNotRunningError) {
          // Nothing was started. `absent` and `ended` say that no provider process is reachable for this host id; a host that
          // runs another command line says nothing about this conversation's process; a host that did not answer in time may
          // be stalled with the process running.
          if (error.reason === 'absent' || error.reason === 'ended') nothingRuns = true;
          if (error.reason === 'unreachable') unreachable = true;
          return undefined;
        }
        throw toTransportError(error);
      }
    };
    const none = (): undefined => {
      // A host that runs but did not answer: this is not "there is no survivor", and what a caller does with that (a launch,
      // which retires a host) would end a process that may be running a turn. Let the next use try again.
      if (unreachable) throw new TransportBusyError('The running Claude process for this conversation did not answer in time. It was left alone; try again in a moment.');
      // A launch record outlives its process when no backend saw the exit (a reboot, or a process that ended while the
      // backend was down). Dropping it here keeps a later `resume` from taking a dead launch for a survivor.
      if (nothingRuns) this.forgetLaunch(options.conversationId, sessionId);
      return undefined;
    };
    let transport = await connect(false);
    if (!transport) return none();
    let fresh = transportStartedFresh(transport);
    if (fresh) {
      // The earlier backend started this process and never spoke to it, so its SessionStart hook frames went by before
      // this connection. Connect again and have the host replay them (a disconnect leaves the process running).
      await transport.close().catch(() => undefined);
      transport = await connect(true);
      if (!transport) return none();
      fresh = transportStartedFresh(transport);
    }
    // One writer: the CLI registers every live process with the session it has open. The only one allowed is the
    // host's own child; anything else writes the same transcript.
    const holder = findSessionHolder(configDir, sessionId, transport.pid !== undefined ? { ignorePids: [transport.pid] } : {});
    if (holder) {
      await transport.close().catch(() => undefined); // let go; the survivor keeps running
      throw new ClaudeSessionHeldError(sessionId, holder.pid);
    }
    return this.bringUp(transport, fresh, 'resume', sessionId, options, configDir, argv, locateTranscripts(configDir, options.cwd, sessionId)[0]);
  }

  /**
   * Wraps a connected channel in a session and runs the handshake. The channel is a new process (`fresh`) or one an
   * earlier backend already initialized. Records the launch before the handshake, so a backend that dies right after
   * still finds the process again.
   */
  private async bringUp(
    transport: LineTransport,
    fresh: boolean,
    mode: 'new' | 'resume',
    sessionId: string,
    options: ClaudeOpenOptions,
    configDir: string,
    argv: string[],
    transcriptPath: string | undefined,
  ): Promise<ClaudeSession> {
    const client = new StreamJsonClient({ transport, log: this.log, label: 'claude', controlTimeoutMs: this.timings.controlTimeoutMs });
    // A resume that fails at startup answers with a zeroed error result and exits, without ever replying to `initialize`.
    let startupResult: ClaudeResultFrame | undefined;
    const stopWatching = client.onFrame((frame: ClaudeFrame) => {
      if (frame.type === 'result' && (frame as ClaudeResultFrame).is_error) startupResult = frame as ClaudeResultFrame;
    });
    const session = new ClaudeSession({
      sessionId,
      cwd: options.cwd,
      client,
      log: this.log,
      timings: this.timings,
      configDir,
      transcriptPath: transcriptPath ?? expectedTranscriptPaths(configDir, options.cwd, sessionId)[0],
      ...optionalFlag('model', flagValue(argv, '--model')),
      ...optionalFlag('effort', flagValue(argv, '--effort')),
      requireSubscriptionLogin: this.requireSubscriptionLogin,
      onTurnCompleted: () => this.noteConversationRan(options.conversationId, sessionId),
      onEnded: (ended, kind) => {
        if (this.sessions.get(ended.nativeSessionId) === ended) this.sessions.delete(ended.nativeSessionId);
        // The process is gone: nothing is left to reattach to. A detached session leaves its process running.
        if (kind === 'exited' && this.readLaunchRecord(options.conversationId, sessionId)) this.context.meta.delete(this.launchKey(options.conversationId));
      },
    });
    this.sessions.set(sessionId, session);
    // Recorded before the handshake: a backend that dies right after the process came up must still find it again.
    // A failed handshake ends the process of a fresh launch, and its exit removes the record.
    this.context.meta.set(this.launchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
    let found: Found;
    try {
      found = await this.handshake(client, session, options, fresh);
    } catch (error) {
      stopWatching();
      this.sessions.delete(sessionId);
      if (fresh) {
        await session.close('error').catch(() => undefined);
      } else {
        // Do not end a process that may be running a turn for the person; let go of it.
        await session.detach().catch(() => undefined);
      }
      throw this.startupError(error, mode, sessionId, startupResult, client);
    }
    stopWatching();
    session.announce();
    // A process found in the middle of a turn: the turn is ours to track from here, before anything else is adopted, so the
    // requests it still has open belong to it, Stop reaches it, and its `result` ends it.
    if (found.running !== 'idle') session.adoptRunningTurn();
    session.adoptRequests(found.pending);
    this.log.info({ pid: session.pid, mode, sessionId, reattached: !fresh, state: found.running }, fresh ? 'claude session started' : 'reattached to a running claude session');
    return session;
  }

  /**
   * `initialize`, the launch checks, and (for a process found again) what it was doing. The repeated `initialize` of a
   * process that is already running only reads: its reply carries `session_state` (`idle`, `running`, `requires_action`)
   * and the requests the process still has open, and the CLI sends a snapshot of its background tasks right behind it.
   */
  private async handshake(client: StreamJsonClient, session: ClaudeSession, options: ClaudeOpenOptions, fresh: boolean): Promise<Found> {
    let reply: Awaited<ReturnType<StreamJsonClient['sendControl']>>;
    try {
      reply = await client.sendControl(
        { subtype: 'initialize', ...(fresh && options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}) },
        { timeoutMs: this.timings.initializeTimeoutMs },
      );
    } catch (error) {
      if (fresh || !(error instanceof ClaudeControlError)) throw error;
      // The CLI refused to initialize again. The process still works and may be in the middle of a turn, but it cannot say
      // what it is doing, so the turn is assumed to be running: the next `result`, or an idle state change, ends it.
      this.log.warn({ pid: client.pid, error: errorText(error) }, 'a running claude process refused the repeated initialize; adopting it without knowing its state');
      return { pending: undefined, running: 'unknown' };
    }
    const body = (reply.response ?? {}) as InitializeResponseBody;
    const source = body.account?.apiKeySource;
    if (this.requireSubscriptionLogin && typeof source === 'string' && source !== 'none' && source !== 'oauth') {
      throw new ClaudeLaunchRefusedError('api_key', `Claude came up on an API key (${source}) instead of the subscription login, so it was not used.`);
    }
    // A process found again ran its SessionStart hooks long ago; only a new one shows them now.
    if (fresh && this.requireHooks && !(await this.sawSessionStartHook(session))) {
      throw new ClaudeLaunchRefusedError('no_hooks', 'Claude came up without the Console hooks (no SessionStart hook ran; the CLI may have started in bare mode), so it was not used.');
    }
    if (fresh) return { pending: undefined, running: 'idle' };
    // The snapshot of the background tasks arrives right behind the reply. Wait for it, within a grace, so the idle decision
    // that follows the adoption never reads an empty set that only looks empty because the frame is still on its way.
    await session.awaitBackgroundSnapshot(this.timings.backgroundSnapshotGraceMs);
    if (client.exitInfo) throw new ClaudeExitError(client.exitInfo, true); // the process ended while we waited
    // An absent state (an older CLI) is taken as idle: a turn that is not there could never be ended.
    const state = typeof body.session_state === 'string' ? body.session_state : 'idle';
    return { pending: reply.pending_permission_requests, running: state === 'idle' ? 'idle' : 'running' };
  }

  /** SessionStart hook frames precede the `initialize` reply; a slow hook gets a short grace. */
  private async sawSessionStartHook(session: ClaudeSession): Promise<boolean> {
    const deadline = Date.now() + this.timings.hookGraceMs;
    while (!session.sawSessionStartHook) {
      if (Date.now() >= deadline || session.isEnded) return session.sawSessionStartHook;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private startupError(error: unknown, mode: 'new' | 'resume', sessionId: string, startupResult: ClaudeResultFrame | undefined, client: StreamJsonClient): Error {
    if (error instanceof ClaudeLaunchRefusedError) return error;
    if (startupResult) {
      const detail = redactFreeText((startupResult.errors ?? []).join('; ') || 'the process reported an error', 300);
      const reason = startupResult.startup_failure_reason ? ` (${startupResult.startup_failure_reason})` : '';
      const failure = mode === 'resume'
        ? new ResumeFailedError(`Claude could not resume session ${sessionId}${reason}: ${detail}`)
        : new TransportUnavailableError(`Claude could not start${reason}: ${detail}`);
      failure.cause = error;
      return failure;
    }
    if (error instanceof ClaudeExitError) {
      const failure = mode === 'resume'
        ? new ResumeFailedError(`Claude exited while resuming session ${sessionId} (${describeExit(error.exit)}).`)
        : new TransportUnavailableError(`Claude exited while starting (${describeExit(error.exit)}).`);
      failure.cause = error;
      return failure;
    }
    this.log.warn({ pid: client.pid, error: errorText(error), stderr: client.stderrTail() }, 'claude handshake failed');
    return toTransportError(error);
  }

  /** End of input, then the process group if it lingers (the transport runs the stages). A probe process exits in about 150 ms. */
  private async endProbeProcess(client: StreamJsonClient): Promise<void> {
    await client.close({ terminate: true }).catch(() => undefined);
  }
}

/** True when the argv launches this native session: `--session-id <id>` or `--resume <id>`. */
function argvNamesSession(argv: string[], sessionId: string): boolean {
  return flagValue(argv, '--session-id') === sessionId || flagValue(argv, '--resume') === sessionId;
}

/** The value after a flag in an argv. */
function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function optionalFlag(key: 'model' | 'effort', value: string | undefined): { model?: string; effort?: string } {
  return value ? { [key]: value } : {};
}

/** A session host id: letters, digits, `.`, `_` and `-` only. */
export function hostIdFor(conversationId: string): string {
  return `claude-${conversationId.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 128);
}

/** `account` from `initialize`: `tokenSource: 'none'` with no email or key source means nobody is signed in. */
function authFromAccount(account: InitializeResponseBody['account']): 'ok' | 'missing' | 'unknown' {
  if (!isRecord(account)) return 'unknown';
  if (asString(account.apiProvider) && account.apiProvider !== 'firstParty') return 'unknown'; // auth is outside the Console's reach
  const signedIn = asString(account.email) || asString(account.subscriptionType) || asString(account.organization);
  const source = asString(account.tokenSource);
  const keySource = asString(account.apiKeySource);
  if (signedIn || (source && source !== 'none') || (keySource && keySource !== 'none')) return 'ok';
  return source === 'none' ? 'missing' : 'unknown';
}
