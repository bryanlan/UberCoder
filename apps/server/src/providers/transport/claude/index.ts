import type { TransportPlugin } from '../types.js';
import { ClaudeInstance, type ClaudePluginOptions, type ClaudeStructuredConfig } from './claude-instance.js';

export {
  buildClaudeArgv,
  buildClaudeEnv,
  buildMcpConfig,
  ClaudeInstance,
  DEFAULT_CLAUDE_COMMAND,
  type ClaudeOpenOptions,
  type ClaudePluginOptions,
  type ClaudeStructuredConfig,
} from './claude-instance.js';
export { CLAUDE_CAPABILITIES, ClaudeSession, DEFAULT_TIMINGS as DEFAULT_CLAUDE_TIMINGS, type ClaudeTimings } from './claude-session.js';
export { classifyResult, ClaudeLaunchRefusedError, ClaudeSessionHeldError, failureFromApiRetry } from './errors.js';

/** `options` exists for tests (shorter timeouts, a fake `claude`, a fake home); the host passes none. */
export function createClaudePlugin(options: ClaudePluginOptions = {}): TransportPlugin<ClaudeStructuredConfig> {
  return {
    id: 'claude',
    create: (config, context) => new ClaudeInstance(config, context, options),
  };
}
