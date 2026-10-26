import type { ProviderId, SessionTransport } from '@agent-console/shared';

/**
 * The transport a bind gets when the request names none: the configured default, but only for a provider whose structured
 * lane is enabled. The routes and the session manager both resolve it here so they cannot disagree.
 */
export function resolveDefaultTransport(
  configured: SessionTransport,
  structuredProviders: readonly ProviderId[],
  provider: ProviderId,
): SessionTransport {
  return configured === 'structured' && structuredProviders.includes(provider) ? 'structured' : 'tmux';
}
