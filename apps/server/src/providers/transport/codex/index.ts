import type { TransportPlugin } from '../types.js';
import { CodexAppServerInstance, createAppServerContinuity, type AppServerContinuity, type CodexPluginOptions, type CodexStructuredConfig } from './app-server-instance.js';

export type { CodexPluginOptions, CodexStructuredConfig } from './app-server-instance.js';
export { CodexAppServerInstance, INSTANCE_META_KEY } from './app-server-instance.js';
export { CodexAppServerSession, CODEX_CAPABILITIES, type CodexTimings } from './app-server-session.js';
export { classifyCodexFailure } from './errors.js';

/** `options` exists for tests (shorter timeouts, a fake `codex`); the host passes none. */
export function createCodexAppServerPlugin(options: CodexPluginOptions = {}): TransportPlugin<CodexStructuredConfig> {
  // The host drops an instance that never connected and asks for a new one, so what a Console's app-server needs remembered
  // across them (request ids, the run of timeouts) is kept here, by the Console's runtime directory.
  const continuities = new Map<string, AppServerContinuity>();
  return {
    id: 'codex',
    create: (config, context) => {
      let continuity = continuities.get(context.runtimeDir);
      if (!continuity) {
        continuity = createAppServerContinuity();
        continuities.set(context.runtimeDir, continuity);
      }
      return new CodexAppServerInstance(config, context, options, continuity);
    },
  };
}
