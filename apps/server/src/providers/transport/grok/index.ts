import type { TransportPlugin } from '../types.js';
import { GrokInstance, type GrokPluginOptions, type GrokStructuredConfig, type GrokUnresponsiveRuns } from './grok-instance.js';

export {
  buildGrokArgv,
  buildGrokEnv,
  buildMcpServers,
  DEFAULT_GROK_COMMAND,
  grokLaunchKey,
  grokTranscriptPath,
  grokTurnKey,
  GROK_UNRESPONSIVE_LIMIT_MS,
  GrokInstance,
  hostIdFor,
  type GrokPluginOptions,
  type GrokStructuredConfig,
  type GrokUnresponsiveRuns,
} from './grok-instance.js';
export { DEFAULT_GROK_TIMINGS, GROK_CAPABILITIES, GrokSession, type GrokTimings } from './grok-session.js';

/** `options` exists for tests (shorter timeouts, a fake `grok`, a fake home); the host passes none. */
export function createGrokPlugin(options: GrokPluginOptions = {}): TransportPlugin<GrokStructuredConfig> {
  // Held here, not in an instance: the service drops an instance that never connected after every failed open, and the run of
  // handshake timeouts that bounds a hung process has to outlive it.
  const unresponsiveRuns: GrokUnresponsiveRuns = new Map();
  return {
    id: 'grok',
    create: (config, context) => new GrokInstance(config, context, options, unresponsiveRuns),
  };
}
