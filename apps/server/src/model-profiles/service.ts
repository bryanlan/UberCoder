import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
  FIXED_MODEL_PROFILE_KEYS,
  MODEL_PROFILE_NAMES,
  type AutoDecision,
  type BoundSession,
  type ModelProfileKey,
  type ModelTarget,
  type FixedModelProfileKey,
  type ModelProfileEntry,
  type ModelProfilesResponse,
  PROVIDER_NAMES,
  type ProviderId,
} from '@agent-console/shared';

/** Where `wo` lives unless the config or `AGENT_CONSOLE_WO_PATH` says otherwise. */
export const DEFAULT_WO_PATH = '/home/bryan/code/workflow_optimizer/.venv/bin/wo';
export const DEFAULT_PROFILES_TIMEOUT_MS = 10_000;
export const DEFAULT_ROUTE_TIMEOUT_MS = 8_000;
/** How long a successful `wo profiles` answer is reused before the catalog is read again. */
export const DEFAULT_PROFILES_CACHE_MS = 5 * 60_000;
/** The part of a prompt the router sees. */
export const ROUTE_TASK_MAX_CHARS = 2_000;
/** How much of the last assistant reply a re-route reads. */
export const ROUTE_REPLY_MAX_CHARS = 500;

/**
 * The text a provisional Auto choice is routed again from: the new prompt, the start of the last assistant reply, then the earlier
 * prompt, newest first, at most 2,000 characters. The newest words come first so a long earlier prompt is the part that is cut.
 */
export function composeRerouteTask(input: { prompt: string; assistantReply?: string; previousPrompt?: string }): string {
  const parts = [input.prompt.trim(), input.assistantReply?.trim().slice(0, ROUTE_REPLY_MAX_CHARS), input.previousPrompt?.trim()]
    .filter((part): part is string => !!part);
  return parts.join('\n\n').slice(0, ROUTE_TASK_MAX_CHARS);
}

const ROUTER_PROVIDER: Record<ProviderId, 'openai' | 'anthropic' | 'xai'> = { codex: 'openai', claude: 'anthropic', grok: 'xai' };
const ROUTER_VENDORS = ['openai', 'anthropic', 'xai'] as const;

/** The Console provider that runs a router vendor's models, or undefined for a vendor the Console has no provider for. */
export function providerForRouterVendor(vendor: string | null | undefined): ProviderId | undefined {
  return (Object.keys(ROUTER_PROVIDER) as ProviderId[]).find(id => ROUTER_PROVIDER[id] === vendor);
}

export class ModelProfilesUnavailableError extends Error {
  constructor(reason: string) {
    super(`Model profiles unavailable: ${reason}`);
    this.name = 'ModelProfilesUnavailableError';
  }
}

export interface ModelRoutingSettings {
  /** Absolute path of the `wo` executable. */
  woPath?: string;
  profilesTimeoutMs?: number;
  routeTimeoutMs?: number;
  profilesCacheMs?: number;
}

export interface WoRunResult {
  stdout: string;
  stderr: string;
}

/** Runs `wo` with an argument list and no shell. Rejects with `code`, `killed`, `stdout`, `stderr` set the way `execFile` does. */
export type WoRunner = (woPath: string, args: string[], options: { timeoutMs: number }) => Promise<WoRunResult>;

export const runWo: WoRunner = (woPath, args, options) => new Promise((resolve, reject) => {
  execFile(woPath, args, { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

const levelSchema = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  effort: z.string().min(1),
  launch_name: z.string().min(1),
});
// A provider may lack a level (Grok has no Ultra or High model). Every provider has a Medium model: it is the level the Console
// falls back to when Auto cannot route and the default for a launch that names no model.
const providerSchema = z.object({
  provider: z.enum(ROUTER_VENDORS),
  levels: z.object({ ultra: levelSchema.optional(), high: levelSchema.optional(), medium: levelSchema, low: levelSchema.optional() }),
});
const profilesSchema = z.object({ profiles: z.object({ codex: providerSchema, claude: providerSchema, grok: providerSchema }) });

const classifierSchema = z.object({
  status: z.string().optional(),
  role_choice: z.string().nullable().optional(),
  role_probabilities: z.record(z.string(), z.number()).nullable().optional(),
  difficulty_choice: z.string().nullable().optional(),
}).passthrough();
const optionSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  launch_name: z.string().nullable().optional(),
  quota_state: z.string().nullable().optional(),
}).passthrough();
const routeSchema = z.object({
  status: z.string(),
  // Null when the router routed by level instead of by kind of task.
  role: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  launch_name: z.string().nullable().optional(),
  quota_state: z.string().nullable().optional(),
  reason: z.string().optional(),
  // True when the classifier could not tell the kind of task. An older router does not send it, which means false.
  provisional: z.boolean().optional(),
  classifier: classifierSchema.nullable().optional(),
  alternatives: z.array(optionSchema).optional(),
  // Set when the router routed by level: picked on Start (`caller`) or asked for in the latest message (`classifier`).
  level: z.enum(FIXED_MODEL_PROFILE_KEYS).nullable().optional(),
  level_source: z.enum(['caller', 'classifier']).nullable().optional(),
  // The thinking level the latest message asked for.
  requested_effort: z.string().nullable().optional(),
}).passthrough();

/** A short, single-line reason for a failed `wo` call, safe to show to the person. */
function failureReason(error: unknown, timeoutMs: number, woPath: string): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string; stdout?: string };
  if (failure?.code === 'ENOENT') return `wo was not found at ${woPath}`;
  if (failure?.code === 'EACCES') return `wo at ${woPath} is not executable`;
  if (failure?.killed || failure?.signal === 'SIGTERM') return `timed out after ${Number((timeoutMs / 1000).toFixed(1))} s`;
  const detail = String(failure?.stderr ?? '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)
    ?? String(failure?.message ?? error).split('\n')[0]?.trim();
  return (detail || 'wo failed').slice(0, 160);
}

export type AutoRouteOutcome =
  | { ok: true; decision: AutoDecision; provider: ProviderId }
  | { ok: false; reason: string };

export interface RouteOptions {
  /** For a provider-neutral route: the providers a session can be created on now. The first router option on one of them is used. */
  acceptProvider?: (provider: ProviderId) => boolean;
  /**
   * The person's newest message (at most 2,000 characters are sent). The router reads it for an explicit level ("use high") or
   * thinking level ("xhigh thinking") and, when it finds one, routes by it.
   */
  latestMessage?: string;
}

/**
 * A provider has no model at the level asked for (Grok has no Ultra or High model). It is a kind of unavailable profile, so every
 * place that turns an unavailable profile into a message for the person handles it too.
 */
export class ModelLevelUnavailableError extends ModelProfilesUnavailableError {
  constructor(readonly provider: ProviderId, readonly level: FixedModelProfileKey) {
    super(`${PROVIDER_NAMES[provider]} has no ${MODEL_PROFILE_NAMES[level]} model`);
    // The profiles did load; only this level is missing, so the message drops the "Model profiles unavailable" prefix.
    this.message = `${PROVIDER_NAMES[provider]} has no ${MODEL_PROFILE_NAMES[level]} model.`;
    this.name = 'ModelLevelUnavailableError';
  }
}

/**
 * The Console's one source of model choices: the level profiles and the Auto router both come from the
 * workflow_optimizer catalog, through the `wo` command. Nothing here knows a model name. A successful profile read is cached;
 * when a later read fails the last good answer keeps being served (it came from the same catalog), and the failure is logged.
 * With no good answer at all, every lookup throws `ModelProfilesUnavailableError` and the web shows the reason.
 */
export class ModelProfileService {
  private readonly woPath: string;
  private readonly profilesTimeoutMs: number;
  private readonly routeTimeoutMs: number;
  private readonly profilesCacheMs: number;
  private cached?: { profiles: ModelProfilesResponse; at: number };
  private inflight?: Promise<ModelProfilesResponse>;

  constructor(
    settings: ModelRoutingSettings = {},
    private readonly run: WoRunner = runWo,
    private readonly logger?: { warn(bindings: unknown, message?: string): void },
    private readonly now: () => number = Date.now,
  ) {
    this.woPath = process.env.AGENT_CONSOLE_WO_PATH?.trim() || settings.woPath || DEFAULT_WO_PATH;
    this.profilesTimeoutMs = settings.profilesTimeoutMs ?? DEFAULT_PROFILES_TIMEOUT_MS;
    this.routeTimeoutMs = settings.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    this.profilesCacheMs = settings.profilesCacheMs ?? DEFAULT_PROFILES_CACHE_MS;
  }

  /** The profiles, from the cache while fresh. Throws `ModelProfilesUnavailableError` when none have ever loaded. */
  async profiles(): Promise<ModelProfilesResponse> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < this.profilesCacheMs) return cached.profiles;
    this.inflight ??= this.load().finally(() => { this.inflight = undefined; });
    try {
      return await this.inflight;
    } catch (error) {
      if (cached) {
        this.logger?.warn({ err: error }, 'Reloading the model profiles failed; serving the last good answer.');
        return cached.profiles;
      }
      throw error;
    }
  }

  /** The profiles already loaded, without running `wo`. For text that only describes a session. */
  peek(provider: ProviderId, key: FixedModelProfileKey): ModelProfileEntry | undefined {
    return this.cached?.profiles.providers[provider].levels[key];
  }

  /** The model a provider runs at a level. Throws `ModelLevelUnavailableError` when it has none at that level. */
  async entry(provider: ProviderId, key: FixedModelProfileKey): Promise<ModelProfileEntry> {
    const entry = (await this.profiles()).providers[provider].levels[key];
    if (!entry) throw new ModelLevelUnavailableError(provider, key);
    return entry;
  }

  private async load(): Promise<ModelProfilesResponse> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(this.woPath, ['profiles', '--json'], { timeoutMs: this.profilesTimeoutMs }));
    } catch (error) {
      throw new ModelProfilesUnavailableError(failureReason(error, this.profilesTimeoutMs, this.woPath));
    }
    let parsed: z.infer<typeof profilesSchema>;
    try {
      parsed = profilesSchema.parse(JSON.parse(stdout));
    } catch {
      throw new ModelProfilesUnavailableError('wo profiles returned an unreadable answer');
    }
    const providers = {} as ModelProfilesResponse['providers'];
    for (const id of ['codex', 'claude', 'grok'] as const) {
      const entry = parsed.profiles[id];
      if (entry.provider !== ROUTER_PROVIDER[id]) {
        throw new ModelProfilesUnavailableError(`wo profiles lists ${entry.provider} models for ${id}`);
      }
      const levels: Partial<Record<FixedModelProfileKey, ModelProfileEntry>> = {};
      for (const key of FIXED_MODEL_PROFILE_KEYS) {
        const level = entry.levels[key];
        if (level) levels[key] = { model: level.model, label: level.label, effort: level.effort, launchName: level.launch_name };
      }
      providers[id] = { routerProvider: entry.provider, levels };
    }
    const profiles: ModelProfilesResponse = { providers, loadedAt: new Date(this.now()).toISOString() };
    this.cached = { profiles, at: this.now() };
    return profiles;
  }

  /**
   * Asks the router for the model of a session's next turns. The router sees the first 2,000 characters of the prompt, and of
   * `options.latestMessage` when given. With a `provider` it sees only models of that vendor (a session cannot change vendor);
   * with none, any vendor can win and `options.acceptProvider` says which of them a new session can be created on. Never throws:
   * a failure is returned so the caller can fall back to Medium.
   */
  async route(provider: ProviderId | undefined, prompt: string, options: RouteOptions = {}): Promise<AutoRouteOutcome> {
    const task = prompt.slice(0, ROUTE_TASK_MAX_CHARS);
    if (!task.trim()) return { ok: false, reason: 'the message has no text to route' };
    const latest = options.latestMessage?.slice(0, ROUTE_TASK_MAX_CHARS);
    return this.ask(['--task', task, ...(latest?.trim() ? ['--latest-message', latest] : [])], provider, options);
  }

  /**
   * Asks the router for the model with the most quota room at a level, with no classifier call. Like `route`, a `provider` limits
   * it to that vendor and `options.acceptProvider` says which vendors a new session can be created on. Never throws.
   */
  async routeLevel(level: FixedModelProfileKey, provider: ProviderId | undefined, options: Pick<RouteOptions, 'acceptProvider'> = {}): Promise<AutoRouteOutcome> {
    return this.ask(['--level', level], provider, options);
  }

  private async ask(target: string[], provider: ProviderId | undefined, options: RouteOptions): Promise<AutoRouteOutcome> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        this.woPath,
        ['route', ...target, '--launcher', 'console', ...(provider ? ['--provider', ROUTER_PROVIDER[provider]] : []), '--json'],
        { timeoutMs: this.routeTimeoutMs },
      ));
    } catch (error) {
      return { ok: false, reason: this.routeFailure(error) };
    }
    let result: z.infer<typeof routeSchema>;
    try {
      result = routeSchema.parse(JSON.parse(stdout));
    } catch {
      return { ok: false, reason: 'the router returned an unreadable answer' };
    }
    if (result.status !== 'route' || !result.launch_name || !result.model || !result.label || !result.effort) {
      return { ok: false, reason: result.reason ? `the router chose no model (${result.reason})` : 'the router chose no model' };
    }
    // The router always names the vendor; an answer without one can only mean the session's own, when a vendor was asked for.
    const chosenProvider = result.provider ? providerForRouterVendor(result.provider) : provider;
    if (!chosenProvider) {
      return { ok: false, reason: `the router chose a model from ${result.provider ?? 'an unknown vendor'}, which the Console cannot run` };
    }
    // A session is bound to one vendor: a model from another one could not run in it.
    if (provider && chosenProvider !== provider) {
      return { ok: false, reason: `the router chose a model from ${result.provider} for a ${provider} session` };
    }
    if (!provider && options.acceptProvider && !options.acceptProvider(chosenProvider)) {
      return this.nextAcceptable(result, options.acceptProvider);
    }
    return { ok: true, decision: this.decisionFrom(result), provider: chosenProvider };
  }

  /** The router's first choice is on a provider that cannot take new sessions: use its best alternative that can. */
  private nextAcceptable(result: z.infer<typeof routeSchema>, accept: (provider: ProviderId) => boolean): AutoRouteOutcome {
    for (const option of result.alternatives ?? []) {
      const alternative = providerForRouterVendor(option.provider);
      if (!alternative || !accept(alternative) || !option.launch_name || !option.model || !option.label || !option.effort) continue;
      const decision = this.decisionFrom({
        ...result,
        provider: option.provider,
        model: option.model,
        label: option.label,
        effort: option.effort,
        launch_name: option.launch_name,
        quota_state: option.quota_state ?? null,
        reason: `${result.reason ?? ''} ${option.label} was used because ${PROVIDER_NAMES[providerForRouterVendor(result.provider)!]} is not available for new chats.`.trim(),
      });
      return { ok: true, decision, provider: alternative };
    }
    return { ok: false, reason: 'the router chose no model that a new chat can run on' };
  }

  private routeFailure(error: unknown): string {
    // Exit 3 and 4 still print the decision JSON; its reason says more than the exit code.
    const stdout = (error as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string' && stdout.trim()) {
      try {
        const reason = routeSchema.parse(JSON.parse(stdout)).reason;
        if (reason) return reason.slice(0, 160);
      } catch { /* fall through to the process failure */ }
    }
    return failureReason(error, this.routeTimeoutMs, this.woPath);
  }

  private decisionFrom(result: z.infer<typeof routeSchema>): AutoDecision {
    const classifier = result.classifier ?? undefined;
    // The labels are shown whatever the classifier's status says: a classifier that could not tell the task kind still
    // reports the difficulty and the role probabilities it read.
    const roleChoice = classifier?.role_choice ?? undefined;
    const probability = roleChoice ? classifier?.role_probabilities?.[roleChoice] : undefined;
    const difficulty = classifier?.difficulty_choice && ['lighter', 'standard', 'heavier'].includes(classifier.difficulty_choice)
      ? classifier.difficulty_choice : undefined;
    return {
      source: 'router',
      decidedAt: new Date(this.now()).toISOString(),
      model: result.model ?? undefined,
      label: result.label ?? undefined,
      effort: result.effort ?? undefined,
      launchName: result.launch_name ?? undefined,
      ...(result.role ? { role: result.role } : {}),
      ...(probability !== undefined ? { rolePercent: Math.round(probability * 100) } : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(classifier?.status ? { classifierStatus: classifier.status } : {}),
      ...(result.quota_state ? { quotaState: result.quota_state } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.provisional === true ? { provisional: true } : {}),
      ...(result.level ? { level: result.level } : {}),
      ...(result.level_source ? { levelSource: result.level_source } : {}),
      ...(result.requested_effort ? { requestedEffort: result.requested_effort } : {}),
    };
  }
}

/** The decision recorded when routing failed and Medium was applied (or could not even be loaded). */
export function fallbackDecision(reason: string, medium: ModelProfileEntry | undefined, now: Date = new Date()): AutoDecision {
  const short = reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return {
    source: 'fallback',
    decidedAt: now.toISOString(),
    ...(medium ? { model: medium.model, label: medium.label, effort: medium.effort, launchName: medium.launchName } : {}),
    warning: medium ? `Auto unavailable: ${short}. Using Medium.` : `Auto unavailable: ${short}. Keeping the current model.`,
  };
}

type ProfiledRow = Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile' | 'grokProfile' | 'autoRoute'>;

export function rowProfile(session: Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile' | 'grokProfile'>): ModelProfileKey | undefined {
  return session.provider === 'codex' ? session.codexProfile : session.provider === 'grok' ? session.grokProfile : session.claudeProfile;
}

/** The target an Auto row runs on: its latest decision, or none before the first message has been routed. */
function autoTarget(session: ProfiledRow): ModelTarget | undefined {
  const decision = session.autoRoute?.decision;
  return decision?.launchName && decision.effort ? { model: decision.launchName, effort: decision.effort } : undefined;
}

/**
 * The model and effort a row's profile means, or undefined when it has none (no profile, or Auto before its first routing).
 * Throws `ModelProfilesUnavailableError` when the profiles cannot be loaded, and `ModelLevelUnavailableError` when the row's
 * provider has no model at its level.
 */
export async function sessionModelTarget(service: ModelProfileService, session: ProfiledRow): Promise<ModelTarget | undefined> {
  const key = rowProfile(session);
  if (!key) return undefined;
  if (key === 'auto') return autoTarget(session);
  const entry = await service.entry(session.provider, key);
  return { model: entry.launchName, effort: entry.effort };
}

/** Like `sessionModelTarget` but from what is already loaded, for text that only describes a session. */
export function peekSessionModelTarget(service: ModelProfileService, session: ProfiledRow): ModelTarget | undefined {
  const key = rowProfile(session);
  if (!key) return undefined;
  if (key === 'auto') return autoTarget(session);
  const entry = service.peek(session.provider, key);
  return entry ? { model: entry.launchName, effort: entry.effort } : undefined;
}
