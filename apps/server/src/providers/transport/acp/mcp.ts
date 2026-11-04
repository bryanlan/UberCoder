import type { PluginContext } from '../types.js';

/** The per-session coordination MCP server, as ACP's `session/new` takes it (`env` is a list of name and value pairs). */
export function buildMcpServers(coordination: PluginContext['coordination'], conversationId: string): Array<Record<string, unknown>> {
  if (!coordination) return [];
  return [{
    name: 'agent_console_coordination',
    command: 'node',
    args: [coordination.helperPath, 'mcp'],
    env: [
      { name: 'AGENT_COORD_RUNTIME', value: coordination.runtimeDir },
      { name: 'AGENT_CONSOLE_SESSION_ID', value: conversationId },
    ],
  }];
}
