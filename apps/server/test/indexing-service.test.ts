import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/tmp/demo-project',
  path: '/tmp/demo-project',
  matchPaths: ['/tmp/demo-project'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/tmp/codex',
  commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
} satisfies MergedProviderSettings;

describe('IndexingService', () => {
  it('adopts pending conversations into real history nodes and hides the pending alias from the tree', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:test',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      boundSessionId: 'session-1',
      isBound: true,
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'match-hash',
      },
    });
    db.upsertBoundSession({
      id: 'session-1',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test',
      tmuxSessionName: 'ac-codex-demo',
      status: 'bound',
      title: 'New Codex conversation',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    });

    const conversations: ConversationSummary[] = [{
      ref: 'real-conversation',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Real conversation',
      createdAt: '2026-03-07T00:01:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
      transcriptPath: '/tmp/codex/real-conversation.jsonl',
      providerConversationId: 'real-conversation',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
        lastUserTextHash: 'match-hash',
      },
    }];

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => providerId === 'codex' ? conversations : [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getBoundSessionById('session-1')?.conversationRef).toBe('real-conversation');
    expect(db.getPendingConversation('pending:test')?.rawMetadata?.adoptedConversationRef).toBe('real-conversation');
    expect(db.getPendingConversation('pending:test')?.boundSessionId).toBeUndefined();

    const tree = indexing.getTree();
    expect(tree.projects[0]?.providers.codex.conversations.map((conversation) => conversation.ref)).toEqual(['real-conversation']);
    db.close();
  });

  it('does not adopt a pending conversation into an unrelated history node when the user hash does not match', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:mismatch',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      boundSessionId: 'session-mismatch',
      isBound: true,
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'expected-hash',
      },
    });
    db.upsertBoundSession({
      id: 'session-mismatch',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:mismatch',
      tmuxSessionName: 'ac-codex-demo-mismatch',
      status: 'bound',
      title: 'New Codex conversation',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    });

    const unrelatedConversations: ConversationSummary[] = [{
      ref: 'real-but-wrong',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Real conversation',
      createdAt: '2026-03-07T00:01:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
      transcriptPath: '/tmp/codex/real-but-wrong.jsonl',
      providerConversationId: 'real-but-wrong',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
        lastUserTextHash: 'different-hash',
      },
    }];

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => providerId === 'codex' ? unrelatedConversations : [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getBoundSessionById('session-mismatch')?.conversationRef).toBe('pending:mismatch');
    expect(db.getPendingConversation('pending:mismatch')?.rawMetadata?.adoptedConversationRef).toBeUndefined();

    const tree = indexing.getTree();
    expect(tree.projects[0]?.providers.codex.conversations.map((conversation) => conversation.ref).sort()).toEqual(['pending:mismatch', 'real-but-wrong']);
    db.close();
  });

  it('rebinds an adopted live session even if the pending snapshot lost its boundSessionId', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:stale-snapshot',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'match-hash',
      },
    });
    db.upsertBoundSession({
      id: 'session-stale',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:stale-snapshot',
      tmuxSessionName: 'ac-codex-demo-stale',
      status: 'bound',
      title: 'New Codex conversation',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    });

    const conversations: ConversationSummary[] = [{
      ref: 'real-stale-fallback',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Real conversation',
      createdAt: '2026-03-07T00:01:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
      transcriptPath: '/tmp/codex/real-stale-fallback.jsonl',
      providerConversationId: 'real-stale-fallback',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
        lastUserTextHash: 'match-hash',
      },
    }];

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => providerId === 'codex' ? conversations : [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getBoundSessionById('session-stale')?.conversationRef).toBe('real-stale-fallback');
    expect(indexing.getTree().projects[0]?.providers.codex.conversations[0]?.isBound).toBe(true);
    db.close();
  });

  it('does not adopt a blank pending conversation before the first prompt hash is known', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:no-hash-yet',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-no-hash',
      degraded: false,
      rawMetadata: {
        pending: true,
      },
    });
    db.upsertBoundSession({
      id: 'session-no-hash',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:no-hash-yet',
      tmuxSessionName: 'ac-codex-demo-no-hash',
      status: 'bound',
      title: 'New Codex conversation',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    });

    const conversations: ConversationSummary[] = [{
      ref: 'existing-recent-conversation',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Recent conversation',
      createdAt: '2026-03-07T00:01:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
      transcriptPath: '/tmp/codex/existing-recent-conversation.jsonl',
      providerConversationId: 'existing-recent-conversation',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
      },
    }];

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => providerId === 'codex' ? conversations : [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getBoundSessionById('session-no-hash')?.conversationRef).toBe('pending:no-hash-yet');
    expect(db.getPendingConversation('pending:no-hash-yet')?.rawMetadata?.adoptedConversationRef).toBeUndefined();
    db.close();
  });

  it('carries a manual pending title override onto the adopted real conversation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:renamed',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-renamed',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'match-hash',
      },
    });
    db.setConversationTitleOverride('demo', 'codex', 'pending:renamed', 'My renamed pending title', '2026-03-07T00:00:10.000Z');

    const conversations: ConversationSummary[] = [{
      ref: 'real-renamed',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Vendor title',
      createdAt: '2026-03-07T00:01:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
      transcriptPath: '/tmp/codex/real-renamed.jsonl',
      providerConversationId: 'real-renamed',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
        lastUserTextHash: 'match-hash',
      },
    }];

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => providerId === 'codex' ? conversations : [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getConversationIndexEntry('demo', 'codex', 'real-renamed')?.title).toBe('My renamed pending title');
    expect(db.getConversationTitleOverride('demo', 'codex', 'pending:renamed')).toBeUndefined();
    db.close();
  });
});
