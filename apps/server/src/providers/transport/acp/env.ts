import os from 'node:os';
import path from 'node:path';

/** Variables that carry the identity of whatever started this process; the child must not inherit them. */
const SCRUBBED_EXACT = new Set(['CLAUDECODE', 'TMUX', 'TMUX_PANE', 'CODEX_THREAD_ID', 'NODE_OPTIONS', 'DEBUG']);

export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function isInheritedIdentityKey(key: string): boolean {
  return SCRUBBED_EXACT.has(key) || key.startsWith('CLAUDE_CODE_') || key.startsWith('AGENT_CONSOLE_') || key.startsWith('AGENT_COORD_');
}

/**
 * The child's environment. The inherited environment loses everything that names another session, plus `NODE_OPTIONS` and
 * `DEBUG`. Configured values go on top with `~` expanded (an exact scrubbed name in those layers is still dropped; a
 * prefix such as `AGENT_COORD_*` is kept, because a plugin sets it on purpose). Then this session's identity is set.
 * `dropInherited` and `dropConfigured` remove more names (Vibe drops Mistral API-key variables from both layers).
 */
export function buildChildEnv(input: {
  base: NodeJS.ProcessEnv;
  configEnv?: Record<string, string>;
  optionsEnv?: Record<string, string>;
  conversationId?: string;
  home?: string;
  dropInherited?(key: string): boolean;
  dropConfigured?(key: string): boolean;
}): Record<string, string> {
  const home = input.home ?? os.homedir();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || isInheritedIdentityKey(key) || input.dropInherited?.(key)) continue;
    env[key] = value;
  }
  for (const layer of [input.configEnv, input.optionsEnv]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (SCRUBBED_EXACT.has(key) || input.dropConfigured?.(key)) continue;
      env[key] = expandHome(value, home);
    }
  }
  if (input.conversationId) env.AGENT_CONSOLE_SESSION_ID = input.conversationId;
  return env;
}
