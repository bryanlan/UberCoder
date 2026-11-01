import { describe, expect, it } from 'vitest';
import { parseProxyPath, assertPortAllowed } from '../src/proxy/localhost-proxy.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/srv/demo',
  path: '/srv/demo',
  matchPaths: ['/srv/demo'],
  allowedLocalhostPorts: [3000, 5173],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [3000, 5173], tags: [], providers: {} },
};

describe('proxy allowlisting', () => {
  it('parses proxy URLs and enforces project port allowlists', () => {
    const parsed = parseProxyPath('/proxy/demo/5173/socket.io/?EIO=4');
    expect(parsed).toEqual({ projectSlug: 'demo', port: 5173, proxiedPath: '/socket.io/?EIO=4' });
    expect(() => assertPortAllowed(project.allowedLocalhostPorts, 5173)).not.toThrow();
    expect(() => assertPortAllowed(project.allowedLocalhostPorts, 9999)).toThrow(/allowlisted/);
  });
});
