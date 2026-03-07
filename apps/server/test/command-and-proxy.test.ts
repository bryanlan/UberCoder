import { describe, expect, it } from 'vitest';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { parseProxyPath, assertPortAllowed } from '../src/proxy/localhost-proxy.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  path: '/srv/demo',
  allowedLocalhostPorts: [3000, 5173],
  tags: [],
  config: { active: true, displayName: 'Demo', allowedLocalhostPorts: [3000, 5173], tags: [], providers: {} },
};

const settings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/home/user/.codex',
  commands: {
    newCommand: ['codex'],
    resumeCommand: ['codex', 'resume', '{{conversationId}}'],
    continueCommand: ['codex', 'resume', '--last'],
    env: { CODEX_HOME: '/home/user/.codex' },
  },
} satisfies MergedProviderSettings;

describe('command construction and proxy allowlisting', () => {
  it('builds the provider resume command from templates', () => {
    const command = new CodexProvider().getLaunchCommand(project, 'session-123', settings);
    expect(command.cwd).toBe('/srv/demo');
    expect(command.argv).toEqual(['codex', 'resume', 'session-123']);
    expect(command.env).toEqual({ CODEX_HOME: '/home/user/.codex' });
  });

  it('parses proxy URLs and enforces project port allowlists', () => {
    const parsed = parseProxyPath('/proxy/demo/5173/socket.io/?EIO=4');
    expect(parsed).toEqual({ projectSlug: 'demo', port: 5173, proxiedPath: '/socket.io/?EIO=4' });
    expect(() => assertPortAllowed(project.allowedLocalhostPorts, 5173)).not.toThrow();
    expect(() => assertPortAllowed(project.allowedLocalhostPorts, 9999)).toThrow(/allowlisted/);
  });
});
