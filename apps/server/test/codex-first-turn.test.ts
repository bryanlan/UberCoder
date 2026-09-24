import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, NormalizedMessage } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';

describe('Codex first-turn transcript linking', () => {
  it.each(['0.153.4', '0.154.0'])('links %s while working and follows the saved reply through completion', async (version) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-codex-first-turn-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const app = fastify();
    try {
      const prompt = 'Prepare the packet for "Example Client".\nUse the prior notes.';
      const promptAt = '2026-09-10T14:15:32.000Z';
      const project: ActiveProject = {
        slug: 'demo', directoryName: 'demo', displayName: 'Demo',
        path: tempDir, rootPath: tempDir, matchPaths: [tempDir],
        allowedLocalhostPorts: [], tags: [],
        config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
      };
      const settings: MergedProviderSettings = {
        id: 'codex', enabled: true, discoveryRoot: tempDir,
        commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
      };
      const eventLogPath = path.join(tempDir, 'events.jsonl');
      await fs.writeFile(eventLogPath, [
        { type: 'user-input', text: prompt, timestamp: promptAt },
        { type: 'raw-output', text: '45 minutes › Ask Codex to do anything\nCalling tool({"query":"Example"})\nusage: python3\nW Wo', timestamp: '2026-09-10T14:15:33.000Z' },
      ].map((row) => JSON.stringify(row)).join('\n'));
      const session: BoundSession = {
        id: 'existing-session', provider: 'codex', projectSlug: project.slug,
        conversationRef: 'pending:first-turn', tmuxSessionName: 'existing-writer',
        status: 'bound', shouldRestore: true, isWorking: true, pid: 12345,
        startedAt: promptAt, updatedAt: promptAt, eventLogPath,
      };
      db.boundSessions.upsert(session);
      db.pendingConversations.put({
        ref: session.conversationRef, kind: 'pending', projectSlug: project.slug, provider: 'codex',
        title: 'New Codex conversation', isBound: true, boundSessionId: session.id, degraded: false,
        createdAt: promptAt, updatedAt: promptAt,
        rawMetadata: { lastUserInputHash: stableTextHash(normalizeComparableText(prompt)), lastUserInputAt: promptAt },
      });
      const provider = new CodexProvider(db.transcriptParseCache);
      const getConversation = vi.spyOn(provider, 'getConversation');
      const bindConversation = vi.fn();
      await registerConversationRoutes(
        app, { ensureAuthenticated: async () => undefined } as never, db,
        { getProjectBySlug: async () => project, getMergedProviderSettings: () => settings } as never,
        { get: () => provider } as never, { bindConversation } as never, new RealtimeEventBus(),
      );
      const pendingUrl = '/api/conversations/demo/codex/pending%3Afirst-turn/messages';
      const first = await app.inject(pendingUrl);
      expect(first.statusCode).toBe(200);
      expect(first.json().messages.map((m: NormalizedMessage) => m.text)).toEqual([prompt]);
      expect(db.boundSessions.getById(session.id)?.conversationRef).toBe(session.conversationRef);

      const transcriptDir = path.join(tempDir, 'sessions', '2026', '09', '10');
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, 'rollout-native-first-turn.jsonl');
      const message = (timestamp: string, role: string, text: string, phase?: string) => ({
        timestamp, type: 'response_item',
        payload: { type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
      });
      const commentary = 'I am checking the prior notes.';
      // Current Codex records have response_item messages, without the old
      // user_message/agent_message event copies. Tool events are not chat prose.
      await fs.writeFile(transcriptPath, [
        { type: 'session_meta', payload: { id: 'native-first-turn', cwd: tempDir, cli_version: version } },
        message(promptAt, 'user', `# AGENTS.md instructions for ${tempDir}\n<INSTRUCTIONS>Injected context.</INSTRUCTIONS>`),
        message(promptAt, 'user', prompt),
        message('2026-09-10T14:15:34.000Z', 'assistant', commentary, 'commentary'),
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-1', output: 'usage: python3' } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');

      // Metadata polling can trigger linking too; the following message read
      // must have the canonical path even before a full discovery pass runs.
      const metadata = await app.inject(`${pendingUrl}?limit=0`);
      expect(metadata.json().conversation).toMatchObject({ ref: 'native-first-turn', kind: 'history', transcriptPath });
      const linked = await app.inject(pendingUrl);
      expect(linked.json().messages.map((m: NormalizedMessage) => m.text)).toEqual([prompt, commentary]);
      expect(linked.json().messages.every((m: NormalizedMessage) => m.source === 'history-file' && m.conversationRef === 'native-first-turn')).toBe(true);
      expect(linked.json().messages.at(-1).lifecycle).toBe('pending');
      expect(db.conversationIndex.get(project.slug, 'codex', 'native-first-turn')).toMatchObject({ transcriptPath, boundSessionId: session.id });
      expect(db.boundSessions.getById(session.id)).toMatchObject({
        conversationRef: 'native-first-turn', resumeConversationRef: 'native-first-turn',
        tmuxSessionName: session.tmuxSessionName, pid: 12345, isWorking: true,
      });

      const nativeUrl = '/api/conversations/demo/codex/native-first-turn/messages';
      const native = await app.inject(nativeUrl);
      expect(native.json().messages).toEqual(linked.json().messages);
      const reply = 'The packet is ready.\n\nThe meeting agenda is included.';
      await fs.appendFile(transcriptPath, JSON.stringify(message('2026-09-10T14:15:38.000Z', 'assistant', reply, 'final_answer')) + '\n');
      const completed = await app.inject(nativeUrl);
      expect(completed.json().messages.map((m: NormalizedMessage) => m.text)).toEqual([prompt, reply]);
      expect(completed.json().messages.at(-1).lifecycle).toBe('durable');
      expect(getConversation).not.toHaveBeenCalled();
      expect(bindConversation).not.toHaveBeenCalled();

      // Repair conversations linked by the former code, which left only the
      // adopted pending row and binding, without a native index entry.
      db.conversationIndex.replace(project.slug, 'codex', []);
      const recovered = await app.inject(pendingUrl);
      expect(recovered.json().conversation.ref).toBe('native-first-turn');
      expect(recovered.json().messages).toEqual(completed.json().messages);
      expect(db.conversationIndex.get(project.slug, 'codex', 'native-first-turn')?.transcriptPath).toBe(transcriptPath);
      expect(getConversation).toHaveBeenCalledOnce();
      expect(getConversation).toHaveBeenCalledWith(project, 'native-first-turn', settings);
      const recoveredNative = await app.inject(nativeUrl);
      expect(recoveredNative.json().messages).toEqual(recovered.json().messages);
      expect(getConversation).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
