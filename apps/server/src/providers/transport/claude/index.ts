import type { TransportPlugin } from '../types.js';
import { ClaudeInstance, type ClaudePluginOptions, type ClaudeStructuredConfig, type ClaudeUnresponsiveRuns } from './claude-instance.js';

export {
  buildClaudeArgv,
  buildClaudeEnv,
  buildMcpConfig,
  CLAUDE_UNRESPONSIVE_LIMIT_MS,
  ClaudeInstance,
  DEFAULT_CLAUDE_COMMAND,
  type ClaudeOpenOptions,
  type ClaudePluginOptions,
  type ClaudeStructuredConfig,
  type ClaudeUnresponsiveRuns,
} from './claude-instance.js';
export { CLAUDE_CAPABILITIES, ClaudeSession, DEFAULT_TIMINGS as DEFAULT_CLAUDE_TIMINGS, type ClaudeTimings } from './claude-session.js';
export { classifyResult, ClaudeLaunchRefusedError, ClaudeSessionHeldError, failureFromApiRetry } from './errors.js';

/** `options` exists for tests (shorter timeouts, a fake `claude`, a fake home); the host passes none. */
export function createClaudePlugin(options: ClaudePluginOptions = {}): TransportPlugin<ClaudeStructuredConfig> {
  // Held here, not in an instance: the service drops an instance that never connected after every failed open, and the run of
  // handshake timeouts that bounds a hung CLI has to outlive it.
  const unresponsiveRuns: ClaudeUnresponsiveRuns = new Map();
  return {
    id: 'claude',
    create: (config, context) => new ClaudeInstance(config, context, options, unresponsiveRuns),
  };
}
