import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
  FIXED_MODEL_PROFILE_KEYS,
  type AutoDecision,
  type BoundSession,
  type ModelProfileKey,
  type ModelTarget,
  type FixedModelProfileKey,
  type ModelProfileEntry,
  type ModelProfilesResponse,
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

const ROUTER_PROVIDER: Record<ProviderId, 'openai' | 'anthropic'> = { codex: 'openai', claude: 'anthropic' };

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
const providerSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  levels: z.object({ high: levelSchema, medium: levelSchema, low: levelSchema }),
});
const profilesSchema = z.object({ profiles: z.object({ codex: providerSchema, claude: providerSchema }) });

const classifierSchema = z.object({
  status: z.string().optional(),
  role_choice: z.string().nullable().optional(),
  role_probabilities: z.record(z.string(), z.number()).nullable().optional(),
  difficulty_choice: z.string().nullable().optional(),
}).passthrough();
const routeSchema = z.object({
  status: z.string(),
  role: z.string().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  launch_name: z.string().nullable().optional(),
  quota_state: z.string().nullable().optional(),
  reason: z.string().optional(),
  classifier: classifierSchema.nullable().optional(),
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
  | { ok: true; decision: AutoDecision }
  | { ok: false; reason: string };

/**
 * The Console's one source of model choices: the High/Medium/Low profiles and the Auto router both come from the
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

  async entry(provider: ProviderId, key: FixedModelProfileKey): Promise<ModelProfileEntry> {
    return (await this.profiles()).providers[provider].levels[key];
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
    for (const id of ['codex', 'claude'] as const) {
      const entry = parsed.profiles[id];
      if (entry.provider !== ROUTER_PROVIDER[id]) {
        throw new ModelProfilesUnavailableError(`wo profiles lists ${entry.provider} models for ${id}`);
      }
      const levels = {} as Record<FixedModelProfileKey, ModelProfileEntry>;
      for (const key of FIXED_MODEL_PROFILE_KEYS) {
        const level = entry.levels[key];
        levels[key] = { model: level.model, label: level.label, effort: level.effort, launchName: level.launch_name };
      }
      providers[id] = { routerProvider: entry.provider, levels };
    }
    const profiles: ModelProfilesResponse = { providers, loadedAt: new Date(this.now()).toISOString() };
    this.cached = { profiles, at: this.now() };
    return profiles;
  }

  /**
   * Asks the router for the model of a session's next turns. The router sees the first 2,000 characters of the prompt and only
   * models of the session's own vendor. Never throws: a failure is returned so the caller can fall back to Medium.
   */
  async route(provider: ProviderId, prompt: string): Promise<AutoRouteOutcome> {
    const task = prompt.slice(0, ROUTE_TASK_MAX_CHARS);
    if (!task.trim()) return { ok: false, reason: 'the message has no text to route' };
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        this.woPath,
        ['route', '--task', task, '--launcher', 'console', '--provider', ROUTER_PROVIDER[provider], '--json'],
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
    // The session is bound to one vendor: a model from the other one could not run in it.
    if (result.provider && result.provider !== ROUTER_PROVIDER[provider]) {
      return { ok: false, reason: `the router chose a model from ${result.provider} for a ${provider} session` };
    }
    return { ok: true, decision: this.decisionFrom(result) };
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
    const answered = classifier?.status === 'ok';
    const roleChoice = answered ? classifier?.role_choice ?? undefined : undefined;
    const probability = roleChoice ? classifier?.role_probabilities?.[roleChoice] : undefined;
    const difficulty = answered && classifier?.difficulty_choice && ['lighter', 'standard', 'heavier'].includes(classifier.difficulty_choice)
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

type ProfiledRow = Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile' | 'autoRoute'>;

export function rowProfile(session: Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile'>): ModelProfileKey | undefined {
  return session.provider === 'codex' ? session.codexProfile : session.claudeProfile;
}

/** The target an Auto row runs on: its latest decision, or none before the first message has been routed. */
function autoTarget(session: ProfiledRow): ModelTarget | undefined {
  const decision = session.autoRoute?.decision;
  return decision?.launchName && decision.effort ? { model: decision.launchName, effort: decision.effort } : undefined;
}

/**
 * The model and effort a row's profile means, or undefined when it has none (no profile, or Auto before its first routing).
 * Throws `ModelProfilesUnavailableError` when a High, Medium or Low profile cannot be looked up.
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
