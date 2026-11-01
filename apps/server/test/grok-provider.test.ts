import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import { GrokProvider, getGrokProjectGroups } from '../src/providers/grok-provider.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { parseGrokConversationFile } from '../src/providers/transcripts/grok.js';
import { getProviderTranscriptWatchPaths } from '../src/indexing/indexing-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const project = (projectPath: string, extra: Partial<ActiveProject> = {}): ActiveProject => ({
  slug: 'demo', directoryName: 'demo', displayName: 'Demo', rootPath: projectPath, path: projectPath, matchPaths: [projectPath],
  allowedLocalhostPorts: [], tags: [], config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} }, ...extra,
});
const settings = (grokHome: string): MergedProviderSettings => ({
  id: 'grok', enabled: true, discoveryRoot: grokHome,
  commands: { newCommand: ['grok'], resumeCommand: ['grok', '--resume', '{{conversationId}}'], continueCommand: ['grok', '--continue'], env: {} },
});

/** One Grok update line the way `updates.jsonl` stores it. */
const update = (sessionId: string, seconds: number, sessionUpdate: string, extra: Record<string, unknown> = {}, method = 'session/update') => JSON.stringify({
  timestamp: seconds, method, params: { sessionId, update: { sessionUpdate, ...extra }, _meta: { agentTimestampMs: seconds * 1000 } },
});
const text = (value: string) => ({ content: { type: 'text', text: value } });

async function writeSession(grokHome: string, cwd: string, id: string, lines: string[], summary: Record<string, unknown> | null = {}) {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'updates.jsonl'), `${lines.join('\n')}\n`);
  if (summary) await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd }, current_model_id: 'grok-4.7', ...summary }));
  return path.join(dir, 'updates.jsonl');
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-provider-'));
  roots.push(root);
  const grokHome = path.join(root, '.grok');
  return { root, grokHome, projectPath: path.join(root, 'work', 'demo') };
}

describe('Grok conversation history', () => {
  it('joins streamed chunks into messages, ends text at a tool call and leaves out reasoning and bookkeeping', async () => {
    const { grokHome, projectPath } = await fixture();
    const file = await writeSession(grokHome, projectPath, 'sess-1', [
      update('sess-1', 100, 'hook_execution', { event_name: 'session_start' }, '_x.ai/session/update'),
      update('sess-1', 101, 'user_message_chunk', text('Fix the ')),
      update('sess-1', 101, 'user_message_chunk', text('parser bug')),
      update('sess-1', 102, 'agent_thought_chunk', text('I should read the file')),
      update('sess-1', 103, 'agent_message_chunk', text('Let me ')),
      update('sess-1', 103, 'hook_annotation', { message: 'noise' }, '_x.ai/session/update'),
      update('sess-1', 103, 'agent_message_chunk', text('look.')),
      update('sess-1', 104, 'tool_call', { toolCallId: 'c1', title: 'read_file' }),
      update('sess-1', 105, 'tool_call_update', { toolCallId: 'c1', status: 'completed' }),
      update('sess-1', 106, 'agent_message_chunk', text('Fixed it.')),
      update('sess-1', 107, 'turn_completed', { stop_reason: 'end_turn' }, '_x.ai/session/update'),
    ], { generated_title: 'Parser bug', session_summary: 'older summary' });
    const parsed = await parseGrokConversationFile({ filePath: file, provider: 'grok', projectSlug: 'demo', conversationRef: 'sess-1' });
    expect(parsed.displayMessages.map(message => [message.role, message.text])).toEqual([
      ['user', 'Fix the parser bug'],
      ['assistant', 'Let me look.'],
      ['assistant', 'Fixed it.'],
    ]);
    expect(parsed.displayMessages.map(message => message.timestamp)).toEqual([
      new Date(101_000).toISOString(), new Date(103_000).toISOString(), new Date(106_000).toISOString(),
    ]);
    expect(parsed.summary).toMatchObject({
      ref: 'sess-1', kind: 'history', provider: 'grok', title: 'Parser bug', model: 'grok-4.7', transcriptPath: file, degraded: false,
      excerpt: 'Fixed it.',
    });
    expect([...parsed.projectPaths]).toEqual([path.resolve(projectPath)]);
  });

  it('shows a peer-wake prompt as coordination status, and names a chat by its first message when there is no summary.json', async () => {
    const { grokHome, projectPath } = await fixture();
    const file = await writeSession(grokHome, projectPath, 'sess-2', [
      update('sess-2', 1, 'user_message_chunk', text('Fix the thing')),
      update('sess-2', 2, 'agent_message_chunk', text('ok')),
      update('sess-2', 3, 'user_message_chunk', text(PEER_WAKE_PROMPT)),
      update('sess-2', 4, 'agent_message_chunk', text('replied to peers')),
    ], null);
    const parsed = await parseGrokConversationFile({ filePath: file, provider: 'grok', projectSlug: 'demo', conversationRef: 'sess-2' });
    expect(parsed.messages.map(message => message.role)).toEqual(['user', 'assistant', 'status', 'assistant']);
    expect(parsed.messages[2]).toMatchObject({ statusKind: 'coordination', text: 'Agent responding to peer messages.' });
    expect(parsed.displayMessages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(parsed.summary.title).toBe('Fix the thing');
    expect(parsed.summary.degraded).toBe(false);
    expect(parsed.projectPaths.size).toBe(0); // no summary.json, so no directory to say which project it belongs to
  });

  it('lists the conversations saved for a project and no others', async () => {
    const { grokHome, projectPath, root } = await fixture();
    const otherPath = path.join(root, 'work', 'other');
    await writeSession(grokHome, projectPath, 'mine-1', [update('mine-1', 10, 'user_message_chunk', text('first')), update('mine-1', 11, 'agent_message_chunk', text('reply'))], { generated_title: 'First chat' });
    await writeSession(grokHome, projectPath, 'mine-2', [update('mine-2', 20, 'user_message_chunk', text('second')), update('mine-2', 21, 'agent_message_chunk', text('reply'))], { generated_title: 'Second chat' });
    await writeSession(grokHome, otherPath, 'theirs', [update('theirs', 30, 'user_message_chunk', text('elsewhere'))]);
    // A session filed in this project's folder whose summary says another directory is not this project's.
    await writeSession(grokHome, projectPath, 'moved', [update('moved', 40, 'user_message_chunk', text('moved'))], { info: { cwd: otherPath } });

    const provider = new GrokProvider();
    const listed = await provider.listConversations(project(projectPath), settings(grokHome));
    expect(listed.map(summary => summary.ref)).toEqual(['mine-2', 'mine-1']); // newest first
    expect(listed.map(summary => summary.title)).toEqual(['Second chat', 'First chat']);
    expect(listed.every(summary => summary.provider === 'grok' && summary.projectSlug === 'demo')).toBe(true);
  });

  it('reads one conversation by its session id, and returns null for one it does not have', async () => {
    const { grokHome, projectPath } = await fixture();
    await writeSession(grokHome, projectPath, 'abc', [update('abc', 5, 'user_message_chunk', text('hello')), update('abc', 6, 'agent_message_chunk', text('hi there'))]);
    const provider = new GrokProvider();
    const found = await provider.getConversation(project(projectPath), 'abc', settings(grokHome));
    expect(found?.messages.map(message => message.text)).toEqual(['hello', 'hi there']);
    expect(await provider.getConversation(project(projectPath), 'nope', settings(grokHome))).toBeNull();
    expect(await provider.listConversations(project('/does/not/exist'), settings(grokHome))).toEqual([]);
  });

  it('finds a project by every path it answers to, and watches Grok\'s sessions folder', async () => {
    const { grokHome, projectPath } = await fixture();
    const linked = '/links/demo';
    expect(getGrokProjectGroups(project(projectPath, { matchPaths: [projectPath, linked] }), grokHome)).toEqual([
      path.join(grokHome, 'sessions', encodeURIComponent(projectPath)),
      path.join(grokHome, 'sessions', encodeURIComponent(linked)),
    ]);
    expect(getProviderTranscriptWatchPaths('grok', grokHome)).toEqual([path.join(grokHome, 'sessions')]);
  });

  it('is registered with the other providers, and has no terminal launch', () => {
    const adapter = new ProviderRegistry().get('grok');
    expect(adapter.id).toBe('grok');
    expect(() => adapter.getLaunchCommand(project('/x'), null, settings('/h'))).toThrow(/structured transport only/);
  });
});
