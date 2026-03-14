import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
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

const secondProject: ActiveProject = {
  ...project,
  slug: 'demo-two',
  directoryName: 'demo-two',
  displayName: 'Demo Two',
  rootPath: '/tmp/demo-two',
  path: '/tmp/demo-two',
  matchPaths: ['/tmp/demo-two'],
};

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

  it('synthesizes missing bound conversations into the tree before indexing catches up', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-live-only',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'real-live-only',
      tmuxSessionName: 'ac-claude-demo-live-only',
      status: 'bound',
      title: 'Live only Claude session',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:03:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    });

    const indexing = new IndexingService(
      { getProjectsRoot: () => '/tmp/projects' } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: (_project: ActiveProject, providerId: string) => ({
          ...providerSettings,
          id: providerId,
          enabled: false,
        }),
      } as never,
      {
        get: () => ({
          listConversations: async () => [],
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    const tree = indexing.getTree();
    expect(tree.projects[0]?.providers.claude.conversations[0]).toMatchObject({
      ref: 'real-live-only',
      title: 'Live only Claude session',
      isBound: true,
      boundSessionId: 'session-live-only',
    });
    expect(tree.projects[0]?.providers.claude.conversations[0]?.rawMetadata?.syntheticSessionPlaceholder).toBe(true);
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

  it('uses the batched Codex discovery path once per refresh instead of per project', async () => {
    class FakeCodexProvider extends CodexProvider {
      batchedCalls = 0;
      singleCalls = 0;

      override async listConversationsForProjects(projects: ActiveProject[], _settings: MergedProviderSettings): Promise<Map<string, ConversationSummary[]>> {
        this.batchedCalls += 1;
        return new Map(projects.map((item) => [item.slug, [{
          ref: `${item.slug}-conversation`,
          kind: 'history',
          projectSlug: item.slug,
          provider: 'codex',
          title: `${item.displayName} conversation`,
          createdAt: '2026-03-07T00:00:00.000Z',
          updatedAt: '2026-03-07T00:00:00.000Z',
          transcriptPath: `/tmp/${item.slug}.jsonl`,
          providerConversationId: `${item.slug}-conversation`,
          isBound: false,
          degraded: false,
          rawMetadata: {
            projectPaths: [item.path],
          },
        }]]));
      }

      override async listConversations(_project: ActiveProject, _settings: MergedProviderSettings): Promise<ConversationSummary[]> {
        this.singleCalls += 1;
        return [];
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const provider = new FakeCodexProvider();
    const indexing = new IndexingService(
      { getProjectsRoot: () => tempDir } as never,
      {
        listActiveProjects: async () => [project, secondProject],
        getMergedProviderSettings: (_project: ActiveProject, providerId: string) => ({
          ...providerSettings,
          id: providerId,
          enabled: providerId === 'codex',
        }),
      } as never,
      {
        get: (providerId: string) => (providerId === 'codex'
          ? provider
          : { listConversations: async () => [] }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(provider.batchedCalls).toBe(1);
    expect(provider.singleCalls).toBe(0);
    expect(db.getConversationIndexEntry('demo', 'codex', 'demo-conversation')).toBeTruthy();
    expect(db.getConversationIndexEntry('demo-two', 'codex', 'demo-two-conversation')).toBeTruthy();
    await indexing.stop();
    db.close();
  });

  it('coalesces concurrent explicit refreshes instead of starting overlapping scans', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    let codexCalls = 0;
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });

    const indexing = new IndexingService(
      { getProjectsRoot: () => tempDir } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: (_project: ActiveProject, providerId: string) => ({
          ...providerSettings,
          id: providerId,
          enabled: providerId === 'codex',
        }),
      } as never,
      {
        get: (providerId: string) => ({
          listConversations: async () => {
            if (providerId !== 'codex') {
              return [];
            }
            codexCalls += 1;
            await scanGate;
            return [];
          },
        }),
      } as never,
      db,
      new RealtimeEventBus(),
    );

    const firstRefresh = indexing.refreshAll();
    const secondRefresh = indexing.refreshAll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codexCalls).toBe(1);

    releaseScan?.();
    await Promise.all([firstRefresh, secondRefresh]);

    expect(codexCalls).toBe(1);
    await indexing.stop();
    db.close();
  });

  it('keeps the earliest scheduled refresh instead of postponing it on repeated change events', async () => {
    vi.useFakeTimers();
    try {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
      const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
      let codexCalls = 0;

      const indexing = new IndexingService(
        { getProjectsRoot: () => tempDir } as never,
        {
          listActiveProjects: async () => [project],
          getMergedProviderSettings: (_project: ActiveProject, providerId: string) => ({
            ...providerSettings,
            id: providerId,
            enabled: providerId === 'codex',
          }),
        } as never,
        {
          get: (providerId: string) => ({
            listConversations: async () => {
              if (providerId === 'codex') {
                codexCalls += 1;
              }
              return [];
            },
          }),
        } as never,
        db,
        new RealtimeEventBus(),
      );

      indexing.scheduleRefresh(100);
      await vi.advanceTimersByTimeAsync(50);
      indexing.scheduleRefresh(100);
      await vi.advanceTimersByTimeAsync(49);

      expect(codexCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(1);

      expect(codexCalls).toBe(1);
      await indexing.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
