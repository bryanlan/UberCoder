import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { VibeProvider, vibeSessionsRoot } from '../src/providers/vibe-provider.js';
import { parseVibeConversationFile } from '../src/providers/transcripts/vibe.js';
import { VIBE_STORE_FORMAT } from '../src/providers/vibe-store.js';
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
const settings = (vibeHome: string): MergedProviderSettings => ({ id: 'vibe', enabled: true, discoveryRoot: vibeHome });

const message = (role: 'user' | 'assistant', text: string, createdAt: number, source: string, extra: Record<string, unknown> = {}) => ({
  type: 'message', turnId: 't1', createdAt, generationStatus: 'committed', role, content: [{ type: 'text', text }], source, ...extra,
});

async function writeStore(vibeHome: string, id: string, options: {
  cwd?: string;
  title?: string;
  model?: string;
  entries?: unknown[];
  format?: string;
  minor?: number;
  omitMinor?: boolean;
  chunks?: boolean;
  omitProjection?: boolean;
} = {}) {
  const dir = path.join(vibeSessionsRoot(vibeHome), id);
  const generation = 'gen-0001';
  const entries = options.entries ?? [
    message('user', 'Fix the parser', 1_700_000_000_000, 'turn_start'),
    { type: 'reasoning', createdAt: 1_700_000_001_000, content: [{ type: 'text', text: 'thinking' }] },
    message('assistant', 'Fixed it.', 1_700_000_002_000, 'harness'),
    message('assistant', 'still writing', 1_700_000_003_000, 'harness', { generationStatus: 'in_progress' }),
  ];
  await fs.mkdir(path.join(dir, 'generations', generation), { recursive: true });
  const projection: Record<string, unknown> = { path: 'projection-state.json', sha256: 'abc' };
  if (options.chunks !== false) {
    await fs.mkdir(path.join(dir, 'chunks'), { recursive: true });
    await fs.writeFile(path.join(dir, 'chunks', 'abc.json'), JSON.stringify(entries));
    projection.chunks = ['abc'];
  }
  await fs.writeFile(path.join(dir, 'generations', generation, 'manifest.json'), JSON.stringify({
    execution_state: 'quiescent',
    projection_state: projection,
  }));
  if (!options.omitProjection) {
    await fs.writeFile(path.join(dir, 'generations', generation, 'projection-state.json'), JSON.stringify({ snapshot: { history: { entries } } }));
  }
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    ...(options.title ? { title: options.title } : {}),
    environment: options.cwd ? { working_directory: options.cwd } : {},
    config: { active_model: options.model ?? 'glm-5-3' },
  }));
  const pointer: Record<string, unknown> = {
    store_format: options.format ?? VIBE_STORE_FORMAT,
    session_id: id,
    generation,
    snapshot_sequence: 1,
  };
  if (!options.omitMinor) pointer.store_format_minor = options.minor ?? 10;
  await fs.writeFile(path.join(dir, 'CURRENT'), JSON.stringify(pointer));
  return path.join(dir, 'CURRENT');
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-provider-'));
  roots.push(root);
  return { root, vibeHome: path.join(root, '.vibe'), projectPath: path.join(root, 'work', 'demo') };
}

describe('Vibe conversation history', () => {
  it('joins stored chunks into messages and leaves out reasoning and an unfinished assistant block', async () => {
    const { vibeHome, projectPath } = await fixture();
    const file = await writeStore(vibeHome, 'sess-1', { cwd: projectPath, title: 'Parser bug', model: 'glm-5-3', omitProjection: true });
    const parsed = await parseVibeConversationFile({ filePath: file, provider: 'vibe', projectSlug: 'demo', conversationRef: 'sess-1' });
    expect(parsed.displayMessages.map(message => [message.role, message.text])).toEqual([
      ['user', 'Fix the parser'],
      ['assistant', 'Fixed it.'],
    ]);
    expect(parsed.displayMessages.map(message => message.timestamp)).toEqual([
      new Date(1_700_000_000_000).toISOString(),
      new Date(1_700_000_002_000).toISOString(),
    ]);
    expect(parsed.summary).toMatchObject({
      ref: 'sess-1', kind: 'history', provider: 'vibe', title: 'Parser bug', model: 'glm-5-3', transcriptPath: file, degraded: false,
      excerpt: 'Fixed it.',
    });
    expect([...parsed.projectPaths]).toEqual([path.resolve(projectPath)]);
  });

  it('shows a peer-wake prompt as coordination status', async () => {
    const { vibeHome, projectPath } = await fixture();
    const file = await writeStore(vibeHome, 'sess-2', {
      cwd: projectPath,
      entries: [
        message('user', 'Fix the thing', 1_000, 'turn_start'),
        message('assistant', 'ok', 2_000, 'harness'),
        message('user', PEER_WAKE_PROMPT, 3_000, 'turn_start'),
        message('assistant', 'replied to peers', 4_000, 'harness'),
      ],
    });
    const parsed = await parseVibeConversationFile({ filePath: file, provider: 'vibe', projectSlug: 'demo', conversationRef: 'sess-2' });
    expect(parsed.messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'status', 'assistant']);
    expect(parsed.messages[2]).toMatchObject({ statusKind: 'coordination', text: 'Agent responding to peer messages.' });
    expect(parsed.displayMessages.map(entry => entry.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('shows the person\'s words without the session-start block, and keeps two user messages in a row apart', async () => {
    const { vibeHome, projectPath } = await fixture();
    const block = formatSessionStartContext({
      assignment: { id: 'a1', status: 'active', continuation: null, supervisorId: null, awaiting: null, recovery: null },
      pendingMessageCount: 0, messages: [],
    }, 'a1', '/usr/local/bin/coordination-helper');
    const file = await writeStore(vibeHome, 'sess-3', {
      cwd: projectPath,
      entries: [
        message('user', `${block}\n\nFix the thing`, 1_000, 'turn_start'),
        message('user', 'Actually, fix the other thing', 2_000, 'turn_start'),
        message('assistant', 'ok', 3_000, 'harness'),
      ],
    });
    const parsed = await parseVibeConversationFile({ filePath: file, provider: 'vibe', projectSlug: 'demo', conversationRef: 'sess-3' });
    expect(parsed.messages.map(entry => [entry.role, entry.text])).toEqual([
      ['user', 'Fix the thing'],
      ['user', 'Actually, fix the other thing'],
      ['assistant', 'ok'],
    ]);
  });

  it('reads a newer minor when the pointer still has the same fields, and refuses an unknown format or a pointer with no minor', async () => {
    const { vibeHome, projectPath } = await fixture();
    const newer = await writeStore(vibeHome, 'newer', { cwd: projectPath, title: 'Newer', minor: 11 });
    const parsed = await parseVibeConversationFile({ filePath: newer, provider: 'vibe', projectSlug: 'demo', conversationRef: 'newer' });
    expect(parsed.summary.title).toBe('Newer');

    const warnings: Array<{ sessionId?: string; reason?: string }> = [];
    const provider = new VibeProvider(undefined, { warn: (fields) => warnings.push(fields as { sessionId?: string; reason?: string }) });
    await writeStore(vibeHome, 'unknown', { cwd: projectPath, format: 'nope/v9' });
    await writeStore(vibeHome, 'no-minor', { cwd: projectPath, omitMinor: true });
    await writeStore(vibeHome, 'old-minor', { cwd: projectPath, minor: 9 });
    const listed = await provider.listConversations(project(projectPath), settings(vibeHome));
    expect(listed.map(summary => summary.ref).sort()).toEqual(['newer']);
    expect(warnings.map(entry => entry.sessionId).sort()).toEqual(['no-minor', 'old-minor', 'unknown']);
    expect(warnings.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0)).toBe(true);
    expect(await provider.getConversation(project(projectPath), 'unknown', settings(vibeHome))).toBeNull();
  });

  it('lists the conversations saved for a project, includes one with no directory as degraded, and watches the unified folder', async () => {
    const { vibeHome, projectPath, root } = await fixture();
    const otherPath = path.join(root, 'work', 'other');
    await writeStore(vibeHome, 'mine', { cwd: projectPath, title: 'Mine', entries: [message('user', 'first', 10_000, 'turn_start'), message('assistant', 'reply', 11_000, 'harness')] });
    await writeStore(vibeHome, 'theirs', { cwd: otherPath, entries: [message('user', 'elsewhere', 20_000, 'turn_start')] });
    await writeStore(vibeHome, 'loose', { entries: [message('user', 'no directory', 5_000, 'turn_start'), message('assistant', 'still here', 6_000, 'harness')] });

    const provider = new VibeProvider();
    const listed = await provider.listConversations(project(projectPath), settings(vibeHome));
    expect(listed.map(summary => summary.ref).sort()).toEqual(['loose', 'mine']);
    expect(listed.find(summary => summary.ref === 'loose')).toMatchObject({ degraded: true, title: 'no directory' });
    expect(listed.find(summary => summary.ref === 'mine')).toMatchObject({ degraded: false, projectSlug: 'demo' });
    const opened = await provider.getConversation(project(projectPath), 'mine', settings(vibeHome));
    expect(opened?.messages.map(entry => entry.text)).toEqual(['first', 'reply']);
    expect(await provider.getConversation(project(projectPath), 'theirs', settings(vibeHome))).toBeNull();
    expect(getProviderTranscriptWatchPaths('vibe', vibeHome)).toEqual([vibeSessionsRoot(vibeHome)]);
  });

  it('is registered with the other providers', () => {
    const adapter = new ProviderRegistry().get('vibe');
    expect(adapter.id).toBe('vibe');
    expect(adapter).toBeInstanceOf(VibeProvider);
  });
});
