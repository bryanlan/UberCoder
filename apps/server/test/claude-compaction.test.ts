import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { ClaudeRunMonitor } from '../src/providers/transcripts/claude-run-state.js';
import { TRANSCRIPT_PARSER_VERSION } from '../src/providers/types.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import { buildConversationSearchChunks, buildFtsQuery } from '../src/search/conversation-search.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';
import { createRecoveryManager, FakeTmux, project, providerSettings } from './helpers/session-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const prompt = {
  uuid: 'user', parentUuid: null, type: 'user', timestamp: '2026-10-09T05:00:00.000Z',
  message: { role: 'user', content: 'Show the text I typed before the summary.' },
};
const answer = {
  uuid: 'answer', parentUuid: 'user', type: 'assistant', timestamp: '2026-10-09T05:01:00.000Z',
  message: { role: 'assistant', content: 'The work is complete.', stop_reason: 'end_turn' },
};
const boundary = {
  uuid: 'boundary', parentUuid: null, logicalParentUuid: 'answer',
  type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T05:55:00.002Z',
  compactMetadata: { trigger: 'auto' },
};
const summary = {
  uuid: 'summary', parentUuid: 'boundary', type: 'user', timestamp: '2026-10-09T05:55:00.000Z',
  isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation.\n\nSummary: internal summary body.' },
};

async function fixture(records: Record<string, unknown>[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-compaction-'));
  const filePath = path.join(dir, 'compacted.jsonl');
  await fs.writeFile(filePath, records.map(record => JSON.stringify(record) + '\n').join(''));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const input = { filePath, provider: 'claude' as const, projectSlug: 'demo', conversationRef: 'compacted' };
  return { filePath, dir, parse: () => parseClaudeConversationFile(input) };
}

describe('Claude compaction history', () => {
  it('retains real prompts and replies, replaces the summary with a marker, and preserves activity metadata', async () => {
    const { parse } = await fixture([prompt, answer, boundary, summary]);
    const parsed = await parse();
    expect(parsed.displayMessages.map(m => [m.role, m.text])).toEqual([
      ['user', prompt.message.content], ['assistant', answer.message.content],
      ['status', '[Claude auto summarized]'],
    ]);
    expect(parsed.displayMessages.at(-1)).toMatchObject({
      statusKind: 'compaction', lifecycle: 'durable', source: 'history-file',
      rawMetadata: { isCompactSummary: true, message: { content: summary.message.content } },
    });
    expect(parsed.summary).toMatchObject({
      title: prompt.message.content, excerpt: answer.message.content, updatedAt: answer.timestamp,
      rawMetadata: { firstUserAt: prompt.timestamp, lastUserAt: prompt.timestamp },
    });
  });

  it('crosses repeated compactions without including sibling branches', async () => {
    const secondPrompt = { ...prompt, uuid: 'user-2', parentUuid: 'summary', timestamp: '2026-10-09T06:00:00.000Z',
      message: { role: 'user', content: 'Continue.' } };
    const secondAnswer = { ...answer, uuid: 'answer-2', parentUuid: 'user-2', timestamp: '2026-10-09T06:01:00.000Z' };
    const { parse } = await fixture([
      prompt, answer,
      { ...prompt, uuid: 'sibling-user', parentUuid: 'answer', message: { role: 'user', content: 'Discarded sibling prompt.' } },
      boundary, summary, secondPrompt, secondAnswer,
      { ...boundary, uuid: 'boundary-2', logicalParentUuid: 'answer-2', timestamp: '2026-10-09T06:55:00.002Z' },
      { ...summary, uuid: 'summary-2', parentUuid: 'boundary-2', timestamp: '2026-10-09T06:55:00.000Z' },
    ]);
    const parsed = await parse();
    expect(parsed.displayMessages.map(m => m.text)).toEqual([
      prompt.message.content, answer.message.content, '[Claude auto summarized]',
      'Continue.', answer.message.content, '[Claude auto summarized]',
    ]);
    expect(parsed.summary.updatedAt).toBe(secondAnswer.timestamp);
    expect(parsed.summary.rawMetadata?.lastUserAt).toBe(secondPrompt.timestamp);
  });

  it.each(['manual', undefined])('does not label a %s compaction trigger as automatic', async trigger => {
    const { parse } = await fixture([prompt, answer, { ...boundary, compactMetadata: { trigger } }, summary]);
    expect((await parse()).displayMessages.at(-1)).toMatchObject({
      role: 'status', statusKind: 'compaction', text: '[Claude summarized]',
    });
  });

  it.each(['auto', 'manual'])('uses the preserved summary anchor to label %s compaction with intervening records', async trigger => {
    const { parse } = await fixture([prompt, answer,
      { ...boundary, compactMetadata: { trigger, preservedSegment: { anchorUuid: summary.uuid } } },
      { uuid: 'attachment', parentUuid: boundary.uuid, type: 'attachment' },
      { ...summary, parentUuid: 'attachment' },
    ]);
    expect((await parse()).displayMessages.at(-1)?.text).toBe(
      trigger === 'auto' ? '[Claude auto summarized]' : '[Claude summarized]',
    );
  });

  it('prefers the summary anchor trigger over an older compaction parent', async () => {
    const { parse } = await fixture([prompt, answer, boundary,
      { ...boundary, uuid: 'manual-boundary', compactMetadata: {
        trigger: 'manual', preservedSegment: { anchorUuid: summary.uuid },
      } }, summary,
    ]);
    expect((await parse()).displayMessages.at(-1)?.text).toBe('[Claude summarized]');
  });

  it('does not infer summaries from user text or attach unrelated history to a missing logical parent', async () => {
    const { parse } = await fixture([
      prompt, answer, { ...boundary, logicalParentUuid: 'missing-parent' }, summary,
      { ...prompt, uuid: 'quoted-summary', parentUuid: 'summary', timestamp: '2026-10-09T06:00:00.000Z',
        message: summary.message },
    ]);
    const parsed = await parse();
    expect(parsed.displayMessages.map(m => [m.role, m.text])).toEqual([
      ['status', '[Claude auto summarized]'], ['user', summary.message.content],
    ]);
  });

  it('returns the restored paginated history and public marker without exposing the summary body', async () => {
    const { dir, filePath, parse } = await fixture([prompt, answer, boundary, summary]);
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    cleanup.push(async () => { db.close(); });
    db.conversationIndex.upsert((await parse()).summary);
    const app = fastify();
    cleanup.push(() => app.close());
    await registerConversationRoutes(app, { ensureAuthenticated: async () => undefined } as never, db,
      { getProjectBySlug: async () => ({ slug: 'demo' }), getMergedProviderSettings: () => ({}) } as never,
      { get: () => ({ getConversation: async () => null }) } as never, {} as never, new RealtimeEventBus());
    const url = '/api/conversations/demo/claude/compacted/messages';
    const response = await app.inject({ method: 'GET', url: `${url}?limit=1` });
    expect(response.statusCode).toBe(200);
    const tail = response.json();
    expect(tail.messagePage).toMatchObject({ total: 3, hasOlder: true });
    expect(tail.messages).toEqual([expect.objectContaining({
      role: 'status', statusKind: 'compaction', text: '[Claude auto summarized]',
    })]);
    expect(tail.messages[0].rawMetadata).toBeUndefined();
    expect(response.body).not.toContain('internal summary body');
    const older = await app.inject({ method: 'GET', url: `${url}?limit=10&before=${tail.messagePage.olderCursor}` });
    expect(older.json().messages.map((m: { text: string }) => m.text)).toEqual([
      prompt.message.content, answer.message.content,
    ]);
    expect(older.json().conversation.transcriptPath).toBe(filePath);
  });
});

describe('Claude compaction search upgrade', () => {
  it.each(['missing', 'older'])('rebuilds existing search rows with a %s parser version and unchanged transcript', async version => {
    const { dir, filePath, parse } = await fixture([prompt, answer, boundary, summary]);
    const parsed = await parse();
    const stat = await fs.stat(filePath);
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    cleanup.push(async () => { db.close(); });
    db.conversationIndex.upsert(parsed.summary);
    // Seed the old parser's summary-only index with the current file fingerprint.
    db.searchIndex.replaceConversation(project.slug, 'claude', parsed.summary.ref,
      buildConversationSearchChunks({ project, conversation: parsed.summary, messages: [{
        ...parsed.displayMessages.at(-1)!, role: 'user', statusKind: undefined, text: summary.message.content,
      }] }), { transcriptPath: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    const versionKey = 'searchParserVersion:demo:claude';
    if (version === 'older') db.meta.set(versionKey, String(TRANSCRIPT_PARSER_VERSION - 1));
    const writes = vi.spyOn(db.searchIndex, 'replaceConversation');
    const indexing = new IndexingService({} as never, {
      listActiveProjects: async () => [project],
      getMergedProviderSettings: (_project: unknown, id: string) => ({ ...providerSettings, id, enabled: id === 'claude' }),
    } as never, { get: () => ({ listConversations: async () => [parsed.summary] }) } as never, db, new RealtimeEventBus());
    cleanup.push(() => indexing.stop());

    await indexing.loadProjectMetadata({ backfillSearchIndex: true });
    expect(db.searchIndex.search(buildFtsQuery('text I typed before the summary')!, 10)).toHaveLength(1);
    expect(db.searchIndex.search(buildFtsQuery('internal summary body')!, 10)).toEqual([]);
    expect(db.searchIndex.search(buildFtsQuery('Claude auto summarized')!, 10)).toEqual([]);
    expect(db.meta.get(versionKey)).toBe(String(TRANSCRIPT_PARSER_VERSION));
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await fs.stat(filePath)).mtimeMs).toBe(stat.mtimeMs);

    await indexing.loadProjectMetadata({ backfillSearchIndex: true });
    await indexing.refreshProjectProvider(project.slug, 'claude');
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('does not mark a partially written upgrade current, and rebuilds it on retry', async () => {
    const { dir, filePath, parse } = await fixture([prompt, answer, boundary, summary]);
    const parsed = await parse();
    const stat = await fs.stat(filePath);
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    cleanup.push(async () => { db.close(); });
    const secondPath = path.join(dir, 'compacted-2.jsonl');
    await fs.copyFile(filePath, secondPath);
    const conversations = [parsed.summary, { ...parsed.summary, ref: 'compacted-2', transcriptPath: secondPath }];
    db.conversationIndex.replace(project.slug, 'claude', conversations);
    for (const conversation of conversations) {
      db.searchIndex.replaceConversation(project.slug, 'claude', conversation.ref,
        buildConversationSearchChunks({ project, conversation, messages: [{
          ...parsed.displayMessages.at(-1)!, role: 'user', statusKind: undefined, text: summary.message.content,
        }] }), { transcriptPath: conversation.transcriptPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    const versionKey = 'searchParserVersion:demo:claude';
    db.meta.set(versionKey, String(TRANSCRIPT_PARSER_VERSION - 1));
    const replace = db.searchIndex.replaceConversation.bind(db.searchIndex);
    const writes = vi.spyOn(db.searchIndex, 'replaceConversation').mockImplementationOnce(replace)
      .mockImplementationOnce(() => { throw new Error('Interrupted write'); });
    const indexing = new IndexingService({} as never, {
      listActiveProjects: async () => [project],
      getMergedProviderSettings: (_project: unknown, id: string) => ({ ...providerSettings, id, enabled: id === 'claude' }),
    } as never, { get: () => ({}) } as never, db, new RealtimeEventBus());
    cleanup.push(() => indexing.stop());

    await expect(indexing.loadProjectMetadata({ backfillSearchIndex: true })).rejects.toThrow('Interrupted write');
    expect(db.meta.get(versionKey)).toBe(String(TRANSCRIPT_PARSER_VERSION - 1));
    expect(db.searchIndex.search(buildFtsQuery('internal summary body')!, 10)).toHaveLength(1);
    await indexing.loadProjectMetadata({ backfillSearchIndex: true });
    expect(db.searchIndex.search(buildFtsQuery('internal summary body')!, 10)).toEqual([]);
    expect(db.searchIndex.search(buildFtsQuery('text I typed before the summary')!, 10)).toHaveLength(2);
    expect(db.meta.get(versionKey)).toBe(String(TRANSCRIPT_PARSER_VERSION));
    expect(writes).toHaveBeenCalledTimes(4);
  });
});

describe('Claude compaction turn state', () => {
  it('reconciles a falsely working binding after restart while preserving the response clock and unsent draft', async () => {
    const { dir, filePath, parse } = await fixture([prompt, answer, boundary, summary]);
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    cleanup.push(async () => { db.close(); });
    db.conversationIndex.upsert((await parse()).summary);
    const tmux = new FakeTmux();
    tmux.paneText = 'Claude Code\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
    const adapter = new ClaudeProvider();
    const settings = { ...providerSettings, id: 'claude' as const, commands: { ...providerSettings.commands,
      newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'] } };
    const manager = createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter, settings);
    cleanup.push(() => manager.stop());
    const session = await manager.bindConversation({ project, provider: adapter, providerSettings: settings,
      conversationRef: 'compacted', title: 'Compaction', kind: 'history' });
    await expect.poll(() => db.boundSessions.getById(session.id)?.lastResponseAt).toBe(answer.timestamp);
    await manager.stop();
    db.boundSessions.upsert({ ...db.boundSessions.getById(session.id)!, isWorking: true });
    tmux.paneText = 'Claude Code\n❯ is it live yet\n⏵⏵ bypass permissions on (shift+tab to cycle)';
    const resumed = createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter, settings);
    cleanup.push(() => resumed.stop());
    await resumed.reconcileSessions();
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    expect(db.boundSessions.getById(session.id)?.lastResponseAt).toBe(answer.timestamp);
    expect(tmux.created).toHaveLength(1);
    expect(tmux.sent).toEqual([]);
    expect(tmux.sentKeys).toEqual([]);
    expect(tmux.paneText).toContain('❯ is it live yet');
    expect(await new ClaudeRunMonitor().read(filePath)).toMatchObject({ status: 'completed' });
  });

  it('keeps a completed response ready during idle compaction, including after monitor restart', async () => {
    const { filePath } = await fixture([prompt, answer]);
    const monitor = new ClaudeRunMonitor();
    const completed = await monitor.read(filePath);
    expect(completed).toMatchObject({ status: 'completed', timestamp: answer.timestamp, turnId: prompt.uuid });
    await fs.appendFile(filePath, [boundary, summary].map(r => JSON.stringify(r) + '\n').join(''));
    expect(await monitor.read(filePath)).toEqual(completed);
    expect(await new ClaudeRunMonitor().read(filePath)).toEqual(completed);
    await fs.appendFile(filePath, JSON.stringify({ ...prompt, uuid: 'next-user', parentUuid: 'summary',
      timestamp: '2026-10-09T06:00:00.000Z' }) + '\n');
    expect(await monitor.read(filePath)).toMatchObject({ status: 'running', turnId: 'next-user' });
  });

  it('does not finish a running turn or invent a turn when compacting', async () => {
    const running = await fixture([prompt, boundary, summary]);
    expect(await new ClaudeRunMonitor().read(running.filePath)).toMatchObject({ status: 'running', turnId: prompt.uuid });
    const standalone = await fixture([boundary, summary]);
    expect(await new ClaudeRunMonitor().read(standalone.filePath)).toBeUndefined();
  });
});
