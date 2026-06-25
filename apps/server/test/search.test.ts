import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConversationSummary, NormalizedMessage } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import { sanitizeSearchableProse } from '../src/lib/prose-sanitizer.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import {
  buildConversationSearchChunks,
  buildFtsQuery,
  ConversationSearchService,
} from '../src/search/conversation-search.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo Project',
  rootPath: '/tmp/demo',
  path: '/tmp/demo',
  matchPaths: ['/tmp/demo'],
  allowedLocalhostPorts: [],
  tags: ['ops'],
  config: { active: true, explicit: true, path: '/tmp/demo', displayName: 'Demo Project', allowedLocalhostPorts: [], tags: ['ops'], providers: {} },
};

const conversation: ConversationSummary = {
  ref: 'conversation-1',
  kind: 'history',
  projectSlug: 'demo',
  provider: 'codex',
  title: 'Original session',
  updatedAt: '2026-06-18T12:00:00.000Z',
  isBound: false,
  degraded: false,
};

function message(input: Pick<NormalizedMessage, 'role' | 'text' | 'timestamp'>): NormalizedMessage {
  return {
    id: `${input.role}:${input.timestamp}`,
    provider: 'codex',
    conversationRef: 'conversation-1',
    source: 'history-file',
    ...input,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function waitForSearchResults(db: AppDatabase, query: string): Promise<ReturnType<AppDatabase['searchConversationIndex']>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const results = db.searchConversationIndex(query, 10, { projectSlugs: ['demo'] });
    if (results.length > 0) {
      return results;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return db.searchConversationIndex(query, 10, { projectSlugs: ['demo'] });
}

describe('conversation search', () => {
  it('keeps prose lines that merely start with code-like keywords', () => {
    const prose = [
      'for the allocation review, keep this searchable.',
      'if the sidebar search misses this, the feature looks broken.',
      'return to the conversation about pending activity.',
    ].join('\n');

    expect(sanitizeSearchableProse(prose)).toContain('for the allocation review');
    expect(sanitizeSearchableProse(prose)).toContain('if the sidebar search');
    expect(sanitizeSearchableProse(prose)).toContain('return to the conversation');
    expect(sanitizeSearchableProse('for (const item of items) {')).toBe('');
  });

  it('removes stack traces while preserving surrounding prose', () => {
    const proseWithTraces = [
      'The deployment failure discussion should remain searchable.',
      'Traceback (most recent call last):',
      '  File "app.py", line 12, in <module>',
      '    main()',
      'ValueError: hiddenPythonNeedle',
      '',
      'The follow-up plan should also remain searchable.',
      'Error: hiddenNodeNeedle',
      '    at run (/tmp/app.js:10:5)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');

    const sanitized = sanitizeSearchableProse(proseWithTraces);

    expect(sanitized).toContain('deployment failure discussion');
    expect(sanitized).toContain('follow-up plan');
    expect(sanitized).not.toContain('Traceback');
    expect(sanitized).not.toContain('hiddenPythonNeedle');
    expect(sanitized).not.toContain('hiddenNodeNeedle');
    expect(sanitized).not.toContain('app.py');
  });

  it('indexes sanitized user and assistant prose without searchable code blocks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const chunks = buildConversationSearchChunks({
      project,
      conversation,
      messages: [
        message({
          role: 'user',
          timestamp: '2026-06-18T12:00:00.000Z',
          text: 'Find the allocation review workflow.\n```ts\nconst shouldNeverAppear = true;\n```',
        }),
        message({
          role: 'assistant',
          timestamp: '2026-06-18T12:01:00.000Z',
          text: 'The allocation review workflow is now easier to locate from search.',
        }),
        message({
          role: 'tool',
          timestamp: '2026-06-18T12:02:00.000Z',
          text: 'raw tool output with allocation should not be indexed',
        }),
      ],
    });

    db.replaceConversationSearchIndex('demo', 'codex', chunks);

    const allocationQuery = buildFtsQuery('allocation review');
    expect(allocationQuery).toBeTruthy();
    const allocationResults = db.searchConversationIndex(allocationQuery!, 10);
    expect(allocationResults[0]).toMatchObject({
      projectSlug: 'demo',
      conversationRef: 'conversation-1',
      conversationTitle: 'Original session',
    });
    expect(allocationResults[0]?.snippet).toContain('allocation');

    const codeQuery = buildFtsQuery('shouldNeverAppear');
    expect(db.searchConversationIndex(codeQuery!, 10)).toEqual([]);

    db.updateConversationSearchTitle('demo', 'codex', 'conversation-1', 'Renamed allocation session');
    expect(db.searchConversationIndex(allocationQuery!, 10)[0]?.conversationTitle).toBe('Renamed allocation session');
    db.close();
  });

  it('does not return metadata-only matches without searchable message prose', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-metadata-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationSearchIndex('demo', 'codex', [{
      projectSlug: 'demo',
      projectDisplayName: 'Operations Project',
      projectPath: '/tmp/demo',
      projectTags: ['ops'],
      provider: 'codex',
      conversationRef: 'metadata-only-result',
      conversationKind: 'history',
      conversationTitle: 'Ops title',
      conversationUpdatedAt: '2026-06-18T12:00:00.000Z',
      isBound: false,
      messageId: 'metadata-message',
      role: 'assistant',
      timestamp: '2026-06-18T12:00:00.000Z',
      text: 'This message discusses unrelated planning details.',
    }]);

    const metadataQuery = buildFtsQuery('ops');
    expect(metadataQuery).toBeTruthy();
    expect(db.searchConversationIndex(metadataQuery!, 10)).toEqual([]);
    db.close();
  });

  it('derives persisted result bound state from current bound sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-bound-state-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationSearchIndex('demo', 'codex', [{
      projectSlug: 'demo',
      projectDisplayName: 'Demo Project',
      projectPath: '/tmp/demo',
      projectTags: [],
      provider: 'codex',
      conversationRef: 'released-result',
      conversationKind: 'history',
      conversationTitle: 'Released result',
      conversationUpdatedAt: '2026-06-18T12:00:00.000Z',
      isBound: true,
      messageId: 'released-message',
      role: 'assistant',
      timestamp: '2026-06-18T12:00:00.000Z',
      text: 'stale bound phrase',
    }]);

    const query = buildFtsQuery('stale bound phrase');
    expect(query).toBeTruthy();
    expect(db.searchConversationIndex(query!, 10)[0]?.isBound).toBe(false);

    db.upsertBoundSession({
      id: 'session-current',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'released-result',
      tmuxSessionName: 'ac-codex-demo-current',
      status: 'bound',
      shouldRestore: true,
      title: 'Released result',
      startedAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
    });

    expect(db.searchConversationIndex(query!, 10)[0]?.isBound).toBe(true);
    db.close();
  });

  it('excludes CLI invocation conversations from search indexing and stale persisted results', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-hidden-cli-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const hiddenConversation = {
      ...conversation,
      ref: 'hidden-cli-invocation',
      title: '### Review for correctness',
    };

    expect(buildConversationSearchChunks({
      project,
      conversation: hiddenConversation,
      messages: [
        message({
          role: 'assistant',
          timestamp: '2026-06-18T12:00:00.000Z',
          text: 'This hidden review phrase should not be searchable.',
        }),
      ],
    })).toEqual([]);

    expect(buildConversationSearchChunks({
      project,
      conversation: {
        ...conversation,
        ref: 'hidden-codex-exec',
        title: 'Programmatic optimization prompt',
        rawMetadata: {
          originator: 'codex_exec',
          source: 'exec',
        },
      },
      messages: [
        message({
          role: 'assistant',
          timestamp: '2026-06-18T12:00:00.000Z',
          text: 'This spawned exec phrase should not be searchable.',
        }),
      ],
    })).toEqual([]);

    db.replaceConversationSearchIndex('demo', 'codex', [{
      projectSlug: 'demo',
      projectDisplayName: 'Demo Project',
      projectPath: '/tmp/demo',
      projectTags: [],
      provider: 'codex',
      conversationRef: 'stale-hidden-cli',
      conversationKind: 'history',
      conversationTitle: '# Prompt invocation',
      conversationUpdatedAt: '2026-06-18T12:00:00.000Z',
      isBound: false,
      messageId: 'stale-hidden-message',
      role: 'assistant',
      timestamp: '2026-06-18T12:00:00.000Z',
      text: 'stale hidden phrase',
    }]);

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    expect(await search.search('stale hidden phrase', 10)).toEqual([]);
    db.close();
  });

  it('searches active pending sessions through normalized live event logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Please make search cover pending activity.', timestamp: '2026-06-18T12:00:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'Sidebar search covers pending activity from normalized logs.', timestamp: '2026-06-18T12:01:00.000Z' }),
    ].join('\n'), 'utf8');
    db.putPendingConversation({
      ref: 'pending:search',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      isBound: true,
      boundSessionId: 'session-1',
      degraded: false,
    });
    db.upsertBoundSession({
      id: 'session-1',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:search',
      tmuxSessionName: 'ac-codex-demo-search',
      status: 'bound',
      shouldRestore: true,
      title: 'New Codex conversation',
      startedAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      lastActivityAt: '2026-06-18T12:00:00.000Z',
      lastOutputAt: '2026-06-18T12:01:00.000Z',
      eventLogPath,
    });
    db.replaceConversationSearchIndex('demo', 'claude', [{
      projectSlug: 'demo',
      projectDisplayName: 'Demo Project',
      projectPath: '/tmp/demo',
      projectTags: [],
      provider: 'claude',
      conversationRef: 'persisted-result',
      conversationKind: 'history',
      conversationTitle: 'Persisted pending activity result',
      conversationUpdatedAt: '2026-06-17T12:00:00.000Z',
      isBound: false,
      messageId: 'persisted-message',
      role: 'assistant',
      timestamp: '2026-06-17T12:00:00.000Z',
      text: 'pending activity pending activity pending activity',
    }]);

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });
    const results = await search.search('pending activity', 2);
    const liveResult = results.find((result) => result.conversationRef === 'pending:search');

    expect(liveResult).toMatchObject({
      projectSlug: 'demo',
      conversationRef: 'pending:search',
      isBound: true,
    });
    expect(['user', 'assistant']).toContain(liveResult?.role);
    expect(liveResult?.snippet).toContain('pending activity');
    db.close();
  });

  it('does not search raw-output assistant chunks for transcript-backed sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-history-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Please inspect indexed live history.', timestamp: '2026-06-18T12:00:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'repaint fragment ghost needle should never be searchable', timestamp: '2026-06-18T12:01:00.000Z' }),
    ].join('\n'), 'utf8');
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-live',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'History live session',
      createdAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      isBound: true,
      boundSessionId: 'session-history-live',
      degraded: false,
    }]);
    db.upsertBoundSession({
      id: 'session-history-live',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-live',
      tmuxSessionName: 'ac-codex-demo-history-live',
      status: 'bound',
      shouldRestore: true,
      title: 'History live session',
      startedAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      lastActivityAt: '2026-06-18T12:00:00.000Z',
      lastOutputAt: '2026-06-18T12:01:00.000Z',
      eventLogPath,
    });

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    expect(await search.search('ghost needle', 10)).toEqual([]);
    expect((await search.search('indexed live history', 10))[0]?.conversationRef).toBe('history-live');
    db.close();
  });

  it('does not refresh history live-search recency just because a stale conversation is bound', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-history-recency-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Find the old recency invariant.',
        timestamp: '2026-01-01T12:00:00.000Z',
      }),
    ].join('\n'), 'utf8');
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'old-history-live',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Old history live session',
      createdAt: '2026-01-01T12:00:00.000Z',
      updatedAt: '2026-01-01T12:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-old-history-live',
      degraded: false,
    }]);
    db.upsertBoundSession({
      id: 'session-old-history-live',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'old-history-live',
      tmuxSessionName: 'ac-codex-demo-old-history-live',
      status: 'bound',
      shouldRestore: true,
      title: 'Old history live session',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      eventLogPath,
    });

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    const result = (await search.search('old recency invariant', 10))[0];
    expect(result).toMatchObject({
      conversationRef: 'old-history-live',
      conversationUpdatedAt: '2026-01-01T12:00:00.000Z',
      recencyBucket: '60-plus-days',
    });
    db.close();
  });

  it('uses live event recency when a history live session has no cached index entry', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-history-no-index-recency-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Find the missing index recency invariant.',
        timestamp: '2026-01-01T12:00:00.000Z',
      }),
    ].join('\n'), 'utf8');
    db.upsertBoundSession({
      id: 'session-missing-index-history-live',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'missing-index-history-live',
      tmuxSessionName: 'ac-codex-demo-missing-index-history-live',
      status: 'bound',
      shouldRestore: true,
      title: 'Missing index history live session',
      startedAt: '2026-01-01T12:00:00.000Z',
      updatedAt: new Date().toISOString(),
      eventLogPath,
    });

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    const result = (await search.search('missing index recency invariant', 10))[0];
    expect(result).toMatchObject({
      conversationRef: 'missing-index-history-live',
      conversationUpdatedAt: '2026-01-01T12:00:00.000Z',
      recencyBucket: '60-plus-days',
    });
    db.close();
  });

  it('bounds live-session search to the recent event-log tail', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-tail-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: `old-tail-needle ${'outside-tail '.repeat(60_000)}`,
        timestamp: '2026-06-18T12:00:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Only recent live output should be searched.',
        timestamp: '2026-06-18T12:01:00.000Z',
      }),
    ].join('\n'), 'utf8');
    db.putPendingConversation({
      ref: 'pending:tail',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Tail bounded pending',
      createdAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      isBound: true,
      boundSessionId: 'session-tail',
      degraded: false,
    });
    db.upsertBoundSession({
      id: 'session-tail',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:tail',
      tmuxSessionName: 'ac-codex-demo-tail',
      status: 'bound',
      shouldRestore: true,
      title: 'Tail bounded pending',
      startedAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      lastOutputAt: '2026-06-18T12:01:00.000Z',
      eventLogPath,
    });

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    expect(await search.search('old-tail-needle', 10)).toEqual([]);
    expect(await search.search('recent live output', 10)).toHaveLength(1);
    db.close();
  });

  it('does not return live results that only match project metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-live-metadata-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'raw-output', text: 'The assistant discussed unrelated planning details.', timestamp: '2026-06-18T12:01:00.000Z' }),
    ].join('\n'), 'utf8');
    db.putPendingConversation({
      ref: 'pending:metadata',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Metadata-only pending',
      createdAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      isBound: true,
      boundSessionId: 'session-metadata',
      degraded: false,
    });
    db.upsertBoundSession({
      id: 'session-metadata',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:metadata',
      tmuxSessionName: 'ac-codex-demo-metadata',
      status: 'bound',
      shouldRestore: true,
      title: 'Metadata-only pending',
      startedAt: '2026-06-18T12:00:00.000Z',
      updatedAt: '2026-06-18T12:01:00.000Z',
      lastOutputAt: '2026-06-18T12:01:00.000Z',
      eventLogPath,
    });

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });

    expect(await search.search('demo', 10)).toEqual([]);
    db.close();
  });

  it('excludes persisted results for projects outside the active project set', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-active-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationSearchIndex('demo', 'codex', [{
      projectSlug: 'demo',
      projectDisplayName: 'Demo Project',
      projectPath: '/tmp/demo',
      projectTags: [],
      provider: 'codex',
      conversationRef: 'active-result',
      conversationKind: 'history',
      conversationTitle: 'Active result',
      conversationUpdatedAt: '2026-06-18T12:00:00.000Z',
      isBound: false,
      messageId: 'active-message',
      role: 'assistant',
      timestamp: '2026-06-18T12:00:00.000Z',
      text: 'retained search phrase',
    }]);
    db.replaceConversationSearchIndex('inactive', 'codex', [{
      projectSlug: 'inactive',
      projectDisplayName: 'Inactive Project',
      projectPath: '/tmp/inactive',
      projectTags: [],
      provider: 'codex',
      conversationRef: 'inactive-result',
      conversationKind: 'history',
      conversationTitle: 'Inactive result',
      conversationUpdatedAt: '2026-06-19T12:00:00.000Z',
      isBound: false,
      messageId: 'inactive-message',
      role: 'assistant',
      timestamp: '2026-06-19T12:00:00.000Z',
      text: 'retained search phrase',
    }]);

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });
    const results = await search.search('retained phrase', 10);

    expect(results.map((result) => result.projectSlug)).toEqual(['demo']);
    db.close();
  });

  it('applies the search limit after choosing the best chunk for each conversation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-dedupe-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationSearchIndex('demo', 'codex', [
      ...Array.from({ length: 9 }, (_, index) => ({
        projectSlug: 'demo',
        projectDisplayName: 'Demo Project',
        projectPath: '/tmp/demo',
        projectTags: [],
        provider: 'codex' as const,
        conversationRef: 'dominant-result',
        conversationKind: 'history' as const,
        conversationTitle: 'Dominant result',
        conversationUpdatedAt: '2026-06-19T12:00:00.000Z',
        isBound: false,
        messageId: `dominant-message-${index}`,
        role: 'assistant' as const,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        text: 'needle phrase',
      })),
      {
        projectSlug: 'demo',
        projectDisplayName: 'Demo Project',
        projectPath: '/tmp/demo',
        projectTags: [],
        provider: 'codex',
        conversationRef: 'secondary-result',
        conversationKind: 'history',
        conversationTitle: 'Secondary result',
        conversationUpdatedAt: '2026-06-18T12:00:00.000Z',
        isBound: false,
        messageId: 'secondary-message',
        role: 'assistant',
        timestamp: '2026-06-18T12:00:00.000Z',
        text: 'needle phrase',
      },
    ]);

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });
    const results = await search.search('needle phrase', 2);

    expect(results.map((result) => result.conversationRef)).toEqual(['dominant-result', 'secondary-result']);
    db.close();
  });

  it('sorts search results by recency bucket before lexical rank', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-recency-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const recentUpdatedAt = daysAgo(2);
    const olderUpdatedAt = daysAgo(20);
    db.replaceConversationSearchIndex('demo', 'codex', [
      {
        projectSlug: 'demo',
        projectDisplayName: 'Demo Project',
        projectPath: '/tmp/demo',
        projectTags: [],
        provider: 'codex',
        conversationRef: 'older-strong-result',
        conversationKind: 'history',
        conversationTitle: 'Older strong result',
        conversationUpdatedAt: olderUpdatedAt,
        isBound: false,
        messageId: 'older-message',
        role: 'assistant',
        timestamp: olderUpdatedAt,
        text: 'bucket needle bucket needle bucket needle bucket needle bucket needle bucket needle',
      },
      {
        projectSlug: 'demo',
        projectDisplayName: 'Demo Project',
        projectPath: '/tmp/demo',
        projectTags: [],
        provider: 'codex',
        conversationRef: 'recent-weak-result',
        conversationKind: 'history',
        conversationTitle: 'Recent weak result',
        conversationUpdatedAt: recentUpdatedAt,
        isBound: false,
        messageId: 'recent-message',
        role: 'assistant',
        timestamp: recentUpdatedAt,
        text: 'bucket needle',
      },
    ]);

    const search = new ConversationSearchService(db, {
      listActiveProjects: async () => [project],
    });
    const results = await search.search('bucket needle', 2);

    expect(results.map((result) => result.conversationRef)).toEqual(['recent-weak-result', 'older-strong-result']);
    expect(results.map((result) => result.recencyBucket)).toEqual(['0-5-days', '15-30-days']);
    db.close();
  });

  it('backfills missing search rows from the cached conversation index on startup', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-backfill-'));
    const projectPath = path.join(tempDir, 'project');
    const providerRoot = path.join(tempDir, 'provider-home');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(providerRoot, { recursive: true });
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'cached-upgrade',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Cached upgrade conversation',
      updatedAt: '2026-06-18T12:00:00.000Z',
      isBound: false,
      degraded: false,
    }]);
    let listConversationCalls = 0;
    const activeProject = { ...project, path: projectPath, rootPath: projectPath, matchPaths: [projectPath] };
    const providerSettings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: providerRoot,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    };
    const provider = {
      id: 'codex',
      discoverLocalState: async () => ({}),
      listConversations: async () => {
        listConversationCalls += 1;
        return [];
      },
      getConversation: async (_project: ActiveProject, conversationRef: string) => ({
        summary: {
          ...conversation,
          ref: conversationRef,
          title: 'Cached upgrade conversation',
        },
        messages: [
          message({
            role: 'assistant',
            timestamp: '2026-06-18T12:00:00.000Z',
            text: 'The cached upgrade phrase should be searchable after startup.',
          }),
        ],
      }),
      getLaunchCommand: () => ({ cwd: projectPath, argv: ['codex'], env: {} }),
    };
    const indexing = new IndexingService(
      { getProjectsRoot: () => tempDir } as never,
      {
        listActiveProjects: async () => [activeProject],
        getMergedProviderSettings: (_project: ActiveProject, providerId: 'codex' | 'claude') => ({
          ...providerSettings,
          id: providerId,
          enabled: providerId === 'codex',
        }),
      } as never,
      { get: () => provider } as never,
      db,
      new RealtimeEventBus(),
    );

    try {
      await indexing.start();
      const query = buildFtsQuery('cached upgrade phrase');
      expect(query).toBeTruthy();
      const results = await waitForSearchResults(db, query!);

      expect(results[0]?.conversationRef).toBe('cached-upgrade');
      expect(listConversationCalls).toBe(0);
    } finally {
      await indexing.stop();
      db.close();
    }
  });

  it('backfills missing search rows when cached projects become active', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-search-reactivated-'));
    const projectPath = path.join(tempDir, 'project');
    const providerRoot = path.join(tempDir, 'provider-home');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(providerRoot, { recursive: true });
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'reactivated-cached',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Reactivated cached conversation',
      updatedAt: '2026-06-18T12:00:00.000Z',
      isBound: false,
      degraded: false,
    }]);
    const activeProject = { ...project, path: projectPath, rootPath: projectPath, matchPaths: [projectPath] };
    const providerSettings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: providerRoot,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    };
    const provider = {
      id: 'codex',
      discoverLocalState: async () => ({}),
      listConversations: async () => [],
      getConversation: async (_project: ActiveProject, conversationRef: string) => ({
        summary: {
          ...conversation,
          ref: conversationRef,
          title: 'Reactivated cached conversation',
        },
        messages: [
          message({
            role: 'assistant',
            timestamp: '2026-06-18T12:00:00.000Z',
            text: 'The reactivated cached phrase should be searchable after metadata priming.',
          }),
        ],
      }),
      getLaunchCommand: () => ({ cwd: projectPath, argv: ['codex'], env: {} }),
    };
    const indexing = new IndexingService(
      { getProjectsRoot: () => tempDir } as never,
      {
        listActiveProjects: async () => [activeProject],
        getMergedProviderSettings: (_project: ActiveProject, providerId: 'codex' | 'claude') => ({
          ...providerSettings,
          id: providerId,
          enabled: providerId === 'codex',
        }),
      } as never,
      { get: () => provider } as never,
      db,
      new RealtimeEventBus(),
    );

    try {
      await indexing.primeProjectMetadata();
      const query = buildFtsQuery('reactivated cached phrase');
      expect(query).toBeTruthy();
      const results = db.searchConversationIndex(query!, 10, { projectSlugs: ['demo'] });

      expect(results[0]?.conversationRef).toBe('reactivated-cached');
    } finally {
      await indexing.stop();
      db.close();
    }
  });
});
