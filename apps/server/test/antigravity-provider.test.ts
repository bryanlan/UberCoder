import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { visibleModelMatchesTarget } from '@agent-console/shared';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { AntigravityProvider } from '../src/providers/antigravity-provider.js';
import { parseAntigravityConversationFile } from '../src/providers/transcripts/antigravity.js';
import {
  antigravityBrainRoot,
  antigravityMetadataPath,
  antigravityTranscriptPath,
  antigravityTurnSettled,
  readAntigravityTurnBaseline,
} from '../src/providers/antigravity-store.js';
import { formatSessionStartContext } from '../src/coordination/console-registration.js';
import { getProviderTranscriptWatchPaths } from '../src/indexing/indexing-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const project = (projectPath: string, extra: Partial<ActiveProject> = {}): ActiveProject => ({
  slug: 'demo', directoryName: 'demo', displayName: 'Demo', rootPath: projectPath, path: projectPath, matchPaths: [projectPath],
  allowedLocalhostPorts: [], tags: [], config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} }, ...extra,
});
const settings = (dataDir: string): MergedProviderSettings => ({ id: 'antigravity', enabled: true, discoveryRoot: dataDir });

async function writeSession(dataDir: string, id: string, options: {
  cwd?: string;
  title?: string;
  isInternal?: boolean;
  steps?: Record<string, unknown>[];
} = {}) {
  const transcript = antigravityTranscriptPath(dataDir, id);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const steps = options.steps ?? [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-28T15:00:00Z',
      content: '<USER_REQUEST>\nFix the parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-28T07:00:00-08:00.\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-28T15:00:01Z',
      model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'read_file', args: { Path: '/tmp/foo' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-28T15:00:02Z',
      model: 'gemini-4-neon-high',
      content: 'Fixed it.',
    },
  ];
  await fs.writeFile(transcript, `${steps.map(step => JSON.stringify(step)).join('\n')}\n`);

  const metaPath = antigravityMetadataPath(dataDir);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  let existing: { conversations: Record<string, unknown> } = { conversations: {} };
  try {
    existing = JSON.parse(await fs.readFile(metaPath, 'utf8')) as { conversations: Record<string, unknown> };
  } catch { /* fresh metadata file */ }
  existing.conversations[id] = {
    summary: {
      ID: id,
      Title: options.title ?? '',
      UpdatedAt: '2026-11-28T15:00:02Z',
      WorkspaceURIs: options.cwd ? [pathToFileURL(options.cwd).href] : [],
      Internal: options.isInternal ?? false,
    },
    is_internal: options.isInternal ?? false,
  };
  await fs.writeFile(metaPath, JSON.stringify(existing, null, 2));
  return transcript;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-provider-'));
  roots.push(root);
  return { root, dataDir: path.join(root, '.gemini', 'antigravity-cli'), projectPath: path.join(root, 'work', 'demo') };
}

describe('Antigravity conversation history', () => {
  it('extracts user requests, skips tool-only planner steps, normalizes model names, and matches visible targets', async () => {
    const { dataDir, projectPath } = await fixture();
    const file = await writeSession(dataDir, 'sess-1', { cwd: projectPath, title: 'Parser bug' });
    const parsed = await parseAntigravityConversationFile({ filePath: file, provider: 'antigravity', projectSlug: 'demo', conversationRef: 'sess-1' });
    expect(parsed.displayMessages.map(message => [message.role, message.text])).toEqual([
      ['user', 'Fix the parser'],
      ['assistant', 'Fixed it.'],
    ]);
    expect(parsed.summary).toMatchObject({
      ref: 'sess-1',
      kind: 'history',
      provider: 'antigravity',
      title: 'Parser bug',
      model: 'gemini-4-neon high',
      transcriptPath: file,
      degraded: false,
      excerpt: 'Fixed it.',
    });
    expect([...parsed.projectPaths]).toEqual([path.resolve(projectPath)]);
    expect(visibleModelMatchesTarget('antigravity', { model: 'gemini-4-neon', effort: 'high' }, parsed.summary.model)).toBe(true);
    expect(visibleModelMatchesTarget('antigravity', { model: 'gemini-4-neon', effort: 'high' }, 'gemini-4-neon-high')).toBe(true);
    expect(visibleModelMatchesTarget('antigravity', { model: 'gemini-4-hydrogen', effort: 'high' }, parsed.summary.model)).toBe(false);
  });

  it('strips the coordination session-start block and detects peer wakes', async () => {
    const { dataDir, projectPath } = await fixture();
    const block = formatSessionStartContext({
      assignment: { id: 'a1', status: 'active', continuation: null, supervisorId: null, awaiting: null, recovery: null },
      pendingMessageCount: 0, messages: [],
    }, 'a1', '/usr/local/bin/coordination-helper');
    const file = await writeSession(dataDir, 'sess-2', {
      cwd: projectPath,
      steps: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T15:00:00Z', content: `<USER_REQUEST>\n${block}\n\nFix the thing\n</USER_REQUEST>` },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T15:00:01Z', model: 'gemini-4-hydrogen-high', content: 'Done.' },
        { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T15:00:02Z', content: `<USER_REQUEST>\n${PEER_WAKE_PROMPT}\n</USER_REQUEST>` },
        { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T15:00:03Z', model: 'gemini-4-hydrogen-high', content: 'Replied to peers.' },
      ],
    });
    const parsed = await parseAntigravityConversationFile({ filePath: file, provider: 'antigravity', projectSlug: 'demo', conversationRef: 'sess-2' });
    expect(parsed.messages.map(entry => [entry.role, entry.text])).toEqual([
      ['user', 'Fix the thing'],
      ['assistant', 'Done.'],
      ['status', 'Agent responding to peer messages.'],
      ['assistant', 'Replied to peers.'],
    ]);
  });

  it('lists project conversations, skips internal sessions, includes unmapped ones as degraded, and watches brain + metadata', async () => {
    const { dataDir, projectPath, root } = await fixture();
    const otherPath = path.join(root, 'work', 'other');
    await writeSession(dataDir, 'mine', { cwd: projectPath, title: 'Mine' });
    await writeSession(dataDir, 'theirs', { cwd: otherPath, title: 'Theirs' });
    await writeSession(dataDir, 'internal', { cwd: projectPath, title: 'Internal', isInternal: true });
    await writeSession(dataDir, 'loose', { title: 'Loose' });

    const provider = new AntigravityProvider();
    const listed = await provider.listConversations(project(projectPath), settings(dataDir));
    expect(listed.map(summary => summary.ref).sort()).toEqual(['loose', 'mine']);
    expect(listed.find(summary => summary.ref === 'loose')).toMatchObject({ degraded: true });
    expect(listed.find(summary => summary.ref === 'mine')).toMatchObject({ degraded: false, projectSlug: 'demo' });
    expect(await provider.getConversation(project(projectPath), 'theirs', settings(dataDir))).toBeNull();
    expect(await provider.getConversation(project(projectPath), 'internal', settings(dataDir))).toBeNull();
    expect(getProviderTranscriptWatchPaths('antigravity', dataDir)).toEqual([
      antigravityBrainRoot(dataDir),
      antigravityMetadataPath(dataDir),
    ]);
  });

  it('detects whether a running turn settled on disk after a baseline step index', async () => {
    const { dataDir, projectPath } = await fixture();
    const file = await writeSession(dataDir, 'sess-turn', {
      cwd: projectPath,
      steps: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T15:00:00Z', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T15:00:01Z', model: 'gemini-4-neon-high', content: 'hello' },
      ],
    });
    const baseline = readAntigravityTurnBaseline(file);
    expect(baseline).toEqual({ lastStepIndex: 1 });
    expect(antigravityTurnSettled(file, baseline)).toBe('running');

    await fs.appendFile(file, `${JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T15:00:02Z', tool_calls: [{ name: 'read_file' }] })}\n`);
    expect(antigravityTurnSettled(file, baseline)).toBe('running');

    await fs.appendFile(file, `${JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T15:00:03Z', content: 'all done' })}\n`);
    expect(antigravityTurnSettled(file, baseline)).toBe('finished');
  });

  it('is registered with the other providers', () => {
    const adapter = new ProviderRegistry().get('antigravity');
    expect(adapter.id).toBe('antigravity');
    expect(adapter).toBeInstanceOf(AntigravityProvider);
  });
});
