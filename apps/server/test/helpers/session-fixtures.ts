import { RealtimeEventBus } from '../../src/realtime/event-bus.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import type { ProviderId } from '@agent-console/shared';
import type { ProviderAdapter } from '../../src/providers/types.js';
import type { ActiveProject } from '../../src/projects/project-service.js';
import type { MergedProviderSettings } from '../../src/config/service.js';
import { AppDatabase } from '../../src/db/database.js';
import { CoordinationService } from '../../src/coordination/service.js';
import { randomUUID } from 'node:crypto';

export const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/srv/demo',
  path: '/srv/demo',
  matchPaths: ['/srv/demo'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

export const provider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return []; },
  async getConversation() { return null; },
};

export const claudeProvider: ProviderAdapter = {
  ...provider,
  id: 'claude',
};

export const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/home/user/.codex',
} satisfies MergedProviderSettings;

export function createRecoveryManager(
  db: AppDatabase,
  runtimeDir: string,
  eventBus = new RealtimeEventBus(),
  recoveryProvider: ProviderAdapter = provider,
  recoveryProviderSettings: MergedProviderSettings = providerSettings,
  options: ConstructorParameters<typeof SessionManager>[5] = {},
): SessionManager {
  return new SessionManager(db, runtimeDir, eventBus, {
    projectService: {
      getProjectBySlug: async (slug: string) => slug === project.slug ? project : undefined,
      getMergedProviderSettings: () => recoveryProviderSettings,
    },
    providerRegistry: {
      get: () => recoveryProvider,
    },
  }, undefined, { coordinationEnabled: true, ...options });
}

export function enableUnattendedRecovery(db: AppDatabase, providerId: ProviderId, nativeSessionId: string): string {
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
  const id = service.register({ provider: providerId, nativeSessionId, token: randomUUID(), pid: process.pid, cwd: '/tmp' }).assignmentId!;
  service.update(id, { continuation: 'unattended' }); return id;
}
