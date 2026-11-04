import type {
  AutoRoute,
  BoundSession,
  FixedModelProfileKey,
  ModelProfileKey,
  ModelProfilesResponse,
  ModelTarget,
  ProviderId,
} from '@agent-console/shared';

/** What the profile control knows about the server's model list. There is no built-in list to fall back on. */
export type ModelProfilesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; profiles: ModelProfilesResponse };

/** The session field that holds each provider's profile. */
const SESSION_PROFILE_FIELDS = { codex: 'codexProfile', claude: 'claudeProfile', grok: 'grokProfile', vibe: 'vibeProfile' } as const satisfies Record<ProviderId, keyof BoundSession>;

/** The profile a session is on, read from the field of its own provider. */
export function sessionModelProfile(session: Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile' | 'grokProfile' | 'vibeProfile'>): ModelProfileKey | undefined {
  return session[SESSION_PROFILE_FIELDS[session.provider]];
}

/** The model and effort a session's active profile means, or undefined when that cannot be told yet. */
export function activeProfileTarget(
  state: ModelProfilesState,
  provider: ProviderId,
  profile: ModelProfileKey | undefined,
  autoRoute: AutoRoute | undefined,
): ModelTarget | undefined {
  if (!profile) return undefined;
  if (profile === 'auto') {
    const decision = autoRoute?.decision;
    return decision?.launchName && decision.effort ? { model: decision.launchName, effort: decision.effort } : undefined;
  }
  if (state.status !== 'ready') return undefined;
  const entry = state.profiles.providers[provider].levels[profile as FixedModelProfileKey];
  return entry ? { model: entry.launchName, effort: entry.effort } : undefined;
}
