import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { FakeTmux, createRecoveryManager } from './helpers/session-fixtures.js';
import { adoptPendingConversation } from '../src/sessions/pending-adoption.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/tmp/demo-project',
  path: '/tmp/demo-project',
  matchPaths: ['/tmp/demo-project'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/tmp/codex',
  commands: {
    newCommand: ['codex'],
    resumeCommand: ['codex', 'resume', '{{conversationId}}'],
    continueCommand: ['codex', 'resume', '--last'],
    env: {},
  },
} satisfies MergedProviderSettings;

const adoptedConversation: ConversationSummary = {
  ref: 'real-adopted',
  kind: 'history',
  projectSlug: 'demo',
  provider: 'codex',
  title: 'Real adopted conversation',
  createdAt: '2026-03-07T00:01:00.000Z',
  updatedAt: '2026-03-07T00:01:00.000Z',
  transcriptPath: '/tmp/codex/real-adopted.jsonl',
  providerConversationId: 'real-adopted',
  isBound: false,
  degraded: false,
  rawMetadata: {
    firstUserTextHash: 'match-hash',
    lastUserTextHash: 'match-hash',
  },
};

const racedConversation: ConversationSummary = {
  ...adoptedConversation,
  ref: 'real-raced',
  title: 'Raced conversation',
  transcriptPath: '/tmp/codex/real-raced.jsonl',
  providerConversationId: 'real-raced',
};

const adoptionProvider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return [adoptedConversation]; },
  async getConversation() { return null; },
  getLaunchCommand(_project, conversationRef) {
    return {
      cwd: project.path,
      argv: conversationRef ? ['codex', 'resume', conversationRef] : ['codex'],
      env: {},
    };
  },
};

function seedPendingAdoption(db: AppDatabase): void {
  db.pendingConversations.put({
    ref: 'pending:adopt-me',
    kind: 'pending',
    projectSlug: 'demo',
    provider: 'codex',
    title: 'Pending session',
    createdAt: '2026-03-07T00:00:00.000Z',
    updatedAt: '2026-03-07T00:00:05.000Z',
    isBound: true,
    boundSessionId: 'session-adopt-me',
    degraded: false,
    rawMetadata: {
      pending: true,
      lastUserInputHash: 'match-hash',
      lastUserInputAt: '2026-03-07T00:00:05.000Z',
    },
  });
  db.boundSessions.upsert({
    id: 'session-adopt-me',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'pending:adopt-me',
    tmuxSessionName: 'ac-codex-demo-adopt-me',
    status: 'bound',
    shouldRestore: true,
    title: 'Pending session',
    startedAt: '2026-03-07T00:00:00.000Z',
    updatedAt: '2026-03-07T00:00:05.000Z',
  } satisfies BoundSession);
}

function getAdoptionState(db: AppDatabase): Record<string, unknown> {
  const pending = db.pendingConversations.get('pending:adopt-me');
  const session = db.boundSessions.getById('session-adopt-me');
  return {
    pendingIsBound: pending?.isBound,
    pendingBoundSessionId: pending?.boundSessionId,
    adoptedConversationRef: pending?.rawMetadata?.adoptedConversationRef,
    adoptedTranscriptPath: pending?.rawMetadata?.adoptedTranscriptPath,
    pendingTranscriptPath: pending?.transcriptPath,
    sessionConversationRef: session?.conversationRef,
    sessionResumeConversationRef: session?.resumeConversationRef,
    sessionTitle: session?.title,
  };
}

describe('pending conversation adoption', () => {
  it('keeps index-refresh and session-restore adoption state transitions in parity', async () => {
    const indexTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-index-adoption-'));
    const restoreTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-restore-adoption-'));
    const indexDb = new AppDatabase(path.join(indexTempDir, 'agent-console.sqlite'));
    const restoreDb = new AppDatabase(path.join(restoreTempDir, 'agent-console.sqlite'));
    seedPendingAdoption(indexDb);
    seedPendingAdoption(restoreDb);

    const indexing = new IndexingService(
      { getProjectsRoot: () => indexTempDir } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: (_project: ActiveProject, providerId: 'codex' | 'claude') => ({
          ...providerSettings,
          enabled: providerId === 'codex',
          discoveryRoot: path.join(indexTempDir, providerId),
        }),
      } as never,
      {
        get: () => adoptionProvider,
      } as never,
      indexDb,
      new RealtimeEventBus(),
    );
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(
      restoreDb,
      tmux,
      restoreTempDir,
      new RealtimeEventBus(),
      adoptionProvider,
      { ...providerSettings, discoveryRoot: restoreTempDir },
    );

    try {
      await indexing.refreshAll();
      await manager.ensureSession('session-adopt-me');

      expect(getAdoptionState(restoreDb)).toEqual(getAdoptionState(indexDb));
      expect(tmux.createdCommands.at(-1)).toContain("'codex' 'resume' 'real-adopted'");
    } finally {
      await indexing.stop();
      manager.stop();
      indexDb.close();
      restoreDb.close();
    }
  });

  it('serializes pending adoption so two refresh owners cannot overwrite the same pending row', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-adoption-race-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    seedPendingAdoption(db);

    try {
      const first = adoptPendingConversation({
        db,
        projectSlug: 'demo',
        providerId: 'codex',
        pendingRef: 'pending:adopt-me',
        matchedConversation: adoptedConversation,
        adoptedAt: '2026-03-07T00:02:00.000Z',
      });
      const second = adoptPendingConversation({
        db,
        projectSlug: 'demo',
        providerId: 'codex',
        pendingRef: 'pending:adopt-me',
        matchedConversation: racedConversation,
        adoptedAt: '2026-03-07T00:03:00.000Z',
      });

      expect(first.adopted).toBe(true);
      expect(first.reboundSession?.conversationRef).toBe('real-adopted');
      expect(second).toEqual({ adopted: false });
      expect(getAdoptionState(db)).toEqual({
        pendingIsBound: false,
        pendingBoundSessionId: undefined,
        adoptedConversationRef: 'real-adopted',
        adoptedTranscriptPath: '/tmp/codex/real-adopted.jsonl',
        pendingTranscriptPath: '/tmp/codex/real-adopted.jsonl',
        sessionConversationRef: 'real-adopted',
        sessionResumeConversationRef: 'real-adopted',
        sessionTitle: 'Real adopted conversation',
      });
    } finally {
      db.close();
    }
  });
});
