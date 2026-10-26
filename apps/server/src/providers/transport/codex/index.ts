import type { TransportPlugin } from '../types.js';
import { CodexAppServerInstance, type CodexPluginOptions, type CodexStructuredConfig } from './app-server-instance.js';

export type { CodexPluginOptions, CodexStructuredConfig } from './app-server-instance.js';
export { CodexAppServerInstance, INSTANCE_META_KEY } from './app-server-instance.js';
export { CodexAppServerSession, CODEX_CAPABILITIES, type CodexTimings } from './app-server-session.js';
export { classifyCodexFailure } from './errors.js';

/** `options` exists for tests (shorter timeouts, a fake `codex`); the host passes none. */
export function createCodexAppServerPlugin(options: CodexPluginOptions = {}): TransportPlugin<CodexStructuredConfig> {
  return {
    id: 'codex',
    create: (config, context) => new CodexAppServerInstance(config, context, options),
  };
}
