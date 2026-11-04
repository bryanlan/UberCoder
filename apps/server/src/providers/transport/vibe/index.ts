import type { TransportPlugin } from '../types.js';
import { VibeInstance, type VibePluginOptions, type VibeStructuredConfig, type VibeUnresponsiveRuns } from './vibe-instance.js';

export {
  buildMcpServers,
  buildVibeEnv,
  DEFAULT_VIBE_QUOTA_COMMAND,
  hostIdFor,
  VibeInstance,
  type VibePluginOptions,
  type VibeStructuredConfig,
  type VibeUnresponsiveRuns,
} from './vibe-instance.js';
export { DEFAULT_VIBE_COMMAND, VIBE_CAPABILITIES, VIBE_QUOTA_COMMAND, VIBE_RATE_LIMIT_NOTICE, vibeLaunchKey, vibeTurnKey } from './protocol.js';
export { DEFAULT_VIBE_TIMINGS, VibeSession, type VibeTimings } from './vibe-session.js';

/** `options` exists for tests (shorter timeouts, a fake `vibe-acp`, a fake quota command). The host passes none. */
export function createVibePlugin(options: VibePluginOptions = {}): TransportPlugin<VibeStructuredConfig> {
  const unresponsiveRuns: VibeUnresponsiveRuns = new Map();
  return {
    id: 'vibe',
    create: (config, context) => new VibeInstance(config, context, options, unresponsiveRuns),
  };
}
