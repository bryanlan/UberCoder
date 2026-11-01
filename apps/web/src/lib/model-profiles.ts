import {
  FIXED_MODEL_PROFILE_KEYS,
  MODEL_PROFILE_KEYS,
  type AutoRoute,
  type FixedModelProfileKey,
  type ModelProfileKey,
  type ModelProfilesResponse,
  type ModelTarget,
  type ProviderId,
} from '@agent-console/shared';

/** What the profile control knows about the server's model list. There is no built-in list to fall back on. */
export type ModelProfilesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; profiles: ModelProfilesResponse };

/** Auto routes each message on the structured transport only, so a terminal-backed session offers H, M and L. */
export function offeredProfileKeys(structured: boolean): readonly ModelProfileKey[] {
  return structured ? MODEL_PROFILE_KEYS : FIXED_MODEL_PROFILE_KEYS;
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
  return { model: entry.launchName, effort: entry.effort };
}
