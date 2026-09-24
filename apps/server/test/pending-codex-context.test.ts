import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, NormalizedMessage } from '@agent-console/shared';
import type { MergedProviderSettings } from '../src/config/service.js';
import { AppDatabase } from '../src/db/database.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';
import { findPendingAdoptionMatch } from '../src/sessions/pending-adoption.js';

const hash = (text: string) => stableTextHash(normalizeComparableText(text));

describe('pending Codex conversations with injected context', () => {
  it.each([false, true])('recovers the completed reply through the original URL (old cache: %s)', async (oldCache) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-pending-context-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const app = fastify();
    try {
      const project: ActiveProject = {
        slug: 'demo', directoryName: 'demo', displayName: 'Demo',
        rootPath: tempDir, path: tempDir, matchPaths: [tempDir],
        allowedLocalhostPorts: [], tags: [],
        config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
      };
      const settings: MergedProviderSettings = {
        id: 'codex', enabled: true, discoveryRoot: tempDir,
        commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
      };
      const prompt = 'Audit the planner’s math.\nPreserve "saved plans" and report findings.';
      const instructions = `# AGENTS.md instructions for ${tempDir}\n\n<INSTRUCTIONS>Read only.</INSTRUCTIONS>`;
      const midnightContext = '<environment_context>\n<current_date>2026-09-08</current_date>\n</environment_context>';
      const reply = 'The audit completed. The full report is ready.';
      const promptAt = '2026-09-08T03:54:37.000Z';
      const transcriptDir = path.join(tempDir, 'sessions', '2026', '09', '07');
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, 'rollout-completed-audit.jsonl');
      const message = (timestamp: string, role: string, text: string) => ({
        timestamp, type: 'response_item',
        payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
      });
      await fs.writeFile(transcriptPath, [
        { type: 'session_meta', payload: { id: 'completed-audit', cwd: tempDir } },
        message('2026-09-08T03:54:35.000Z', 'user', instructions),
        message(promptAt, 'user', prompt),
        message('2026-09-08T04:00:00.000Z', 'user', midnightContext),
        message('2026-09-08T05:30:00.000Z', 'assistant', reply),
      ].map((record) => JSON.stringify(record)).join('\n'));

      const pending: ConversationSummary = {
        ref: 'pending:overnight', kind: 'pending', projectSlug: 'demo', provider: 'codex',
        title: 'New Codex conversation', createdAt: '2026-09-08T03:54:25.000Z',
        updatedAt: '2026-09-08T03:54:34.000Z', isBound: true, boundSessionId: 'existing-session', degraded: false,
        rawMetadata: { pending: true, lastUserInputHash: hash(prompt), lastUserInputAt: '2026-09-08T03:54:34.000Z' },
      };
      db.pendingConversations.put(pending);
      db.boundSessions.upsert({
        id: 'existing-session', provider: 'codex', projectSlug: 'demo', conversationRef: pending.ref,
        tmuxSessionName: 'existing-tmux-writer', status: 'bound', shouldRestore: true,
        title: pending.title, startedAt: pending.createdAt!, updatedAt: pending.updatedAt, isWorking: false,
      });
      if (oldCache) {
        const fingerprint = await fs.stat(transcriptPath);
        db.transcriptParseCache.put(transcriptPath, fingerprint.size, fingerprint.mtimeMs, {
          scope: 'full', projectPaths: [tempDir], authoritativeProjectPaths: [tempDir],
          summary: {
            ...pending, ref: 'completed-audit', kind: 'history', transcriptPath,
            rawMetadata: { firstUserTextHash: hash(instructions), lastUserTextHash: hash(midnightContext) },
          },
        });
        // Version 4 cached the injected records as the first/last user input.
        db.sqlite.prepare('update transcript_parse_cache set parser_version = 4 where path = ?').run(transcriptPath);
      }

      const provider = new CodexProvider(db.transcriptParseCache);
      const bindConversation = vi.fn();
      await registerConversationRoutes(
        app, { ensureAuthenticated: async () => undefined } as never, db,
        { getProjectBySlug: async () => project, getMergedProviderSettings: () => settings } as never,
        { get: () => provider } as never, { bindConversation } as never, new RealtimeEventBus(),
      );
      const response = await app.inject('/api/conversations/demo/codex/pending%3Aovernight/messages?limit=20');
      expect(response.statusCode).toBe(200);
      expect(response.json().messages.map((entry: NormalizedMessage) => entry.text)).toEqual([prompt, reply]);
      expect(response.json().conversation.kind).toBe('history');
      expect(db.pendingConversations.get(pending.ref)?.rawMetadata?.adoptedConversationRef).toBe('completed-audit');
      expect(db.boundSessions.getById('existing-session')).toMatchObject({
        conversationRef: 'completed-audit', resumeConversationRef: 'completed-audit', tmuxSessionName: 'existing-tmux-writer',
      });
      expect(bindConversation).not.toHaveBeenCalled();

      const conversation = await provider.getConversation(project, 'completed-audit', settings);
      expect(conversation?.allMessages?.filter((entry) => entry.role === 'user')).toHaveLength(3);
      expect(conversation?.summary.rawMetadata).toMatchObject({
        firstUserTextHash: hash(prompt), lastUserTextHash: hash(prompt), firstUserAt: promptAt, lastUserAt: promptAt,
      });
      for (const unrelatedInput of [instructions, midnightContext, 'A different audit']) {
        expect(findPendingAdoptionMatch({
          ...pending, rawMetadata: { ...pending.rawMetadata, lastUserInputHash: hash(unrelatedInput) },
        }, [conversation!.summary])).toBeUndefined();
      }
      expect(findPendingAdoptionMatch({
        ...pending, rawMetadata: { ...pending.rawMetadata, lastUserInputAt: '2026-09-08T05:29:00.000Z' },
      }, [conversation!.summary])).toBeUndefined();
    } finally {
      await app.close();
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
