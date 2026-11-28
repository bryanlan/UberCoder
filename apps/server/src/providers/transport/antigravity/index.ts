import type { TransportPlugin } from '../types.js';
import {
  AntigravityInstance,
  type AntigravityPluginOptions,
  type AntigravityStructuredConfig,
  type AntigravityUnresponsiveRuns,
} from './antigravity-instance.js';

export {
  buildAntigravityEnv,
  buildMcpServers,
  DEFAULT_ANTIGRAVITY_QUOTA_COMMAND,
  hostIdFor,
  AntigravityInstance,
  type AntigravityPluginOptions,
  type AntigravityStructuredConfig,
  type AntigravityUnresponsiveRuns,
} from './antigravity-instance.js';
export {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_QUOTA_COMMAND,
  ANTIGRAVITY_RATE_LIMIT_NOTICE,
  DEFAULT_ANTIGRAVITY_COMMAND,
  antigravityLaunchKey,
  antigravityTurnKey,
} from './protocol.js';
export {
  AntigravitySession,
  DEFAULT_ANTIGRAVITY_TIMINGS,
  type AntigravityTimings,
} from './antigravity-session.js';

/** `options` exists for tests (shorter timeouts, a fake `agy`, a fake quota command). The host passes none. */
export function createAntigravityPlugin(options: AntigravityPluginOptions = {}): TransportPlugin<AntigravityStructuredConfig> {
  const unresponsiveRuns: AntigravityUnresponsiveRuns = new Map();
  return {
    id: 'antigravity',
    create: (config, context) => new AntigravityInstance(config, context, options, unresponsiveRuns),
  };
}
