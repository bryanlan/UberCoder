import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { agentControlledByConversation, type AgentLaunchMark } from '../src/lib/agent-controlled.js';
import { backfillHumanReplies } from '../src/sessions/human-reply-backfill.js';

function endedSession(id: string, conversationRef: string): BoundSession {
  return {
    id,
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef,
    status: 'ended',
    shouldRestore: false,
    title: id,
    startedAt: '2026-03-07T00:00:00.000Z',
    updatedAt: '2026-03-07T00:00:00.000Z',
  };
}

describe('agent-controlled conversation marks', () => {
  it('uses the latest launch name and the resumed conversation ref', () => {
    const marks: AgentLaunchMark[] = [
      {
        projectSlug: 'demo', provider: 'codex', conversationRef: 'pending:old', resumeConversationRef: 'native',
        launcherName: 'First lead', updatedAt: '2026-03-07T00:00:00.000Z',
      },
      {
        projectSlug: 'demo', provider: 'codex', conversationRef: 'pending:new', resumeConversationRef: 'native',
        launcherName: '  ', updatedAt: '2026-03-08T00:00:00.000Z',
      },
    ];

    expect(agentControlledByConversation(marks).get('demo:codex:native')).toEqual({ launcherName: 'an agent' });
    expect(agentControlledByConversation(marks).get('demo:codex:pending:old')).toEqual({ launcherName: 'First lead' });
  });

  it('reads retained launch rows and skips a row whose launch record is not JSON', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-agent-controlled-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.boundSessions.upsert({ ...endedSession('launched', 'pending:req'), resumeConversationRef: 'native-ref' });
    db.boundSessions.setLaunchContext('launched', {
      launchedBy: 'assignment-1', launcherName: 'Planner lead', grantIds: ['grant-1'], requestId: 'req', supervisorId: 'assignment-1',
    });
    db.boundSessions.upsert(endedSession('broken', 'other-ref'));
    db.sqlite.prepare('update bound_sessions set launch_context_json=? where id=?').run('{', 'broken');

    expect(db.boundSessions.listAgentLaunchMarks()).toEqual([{
      projectSlug: 'demo',
      provider: 'codex',
      conversationRef: 'pending:req',
      resumeConversationRef: 'native-ref',
      launcherName: 'Planner lead',
      updatedAt: '2026-03-07T00:00:00.000Z',
    }]);
    db.close();
  });

  describe('a person reply', () => {
    const context = { launchedBy: 'assignment-1', launcherName: 'Planner lead', grantIds: ['grant-1'], requestId: 'req', supervisorId: 'assignment-1' };

    it('is recorded once, and the chat stops being an agent-launched mark', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-human-reply-'));
      const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
      db.boundSessions.upsert(endedSession('launched', 'pending:req'));
      db.boundSessions.setLaunchContext('launched', context);
      db.boundSessions.upsert(endedSession('mine', 'native-mine'));

      expect(db.boundSessions.markHumanReplied('launched', '2026-03-07T01:00:00.000Z')).toEqual(['launched']);
      expect(db.boundSessions.markHumanReplied('launched', '2026-03-07T02:00:00.000Z')).toEqual([]);
      expect(db.boundSessions.getById('launched')?.launchContext).toEqual({ ...context, humanRepliedAt: '2026-03-07T01:00:00.000Z' });
      expect(db.boundSessions.listAgentLaunchMarks()).toEqual([]);
      // A chat the person started has no launch record to update.
      expect(db.boundSessions.markHumanReplied('mine', '2026-03-07T01:00:00.000Z')).toEqual([]);
      expect(db.boundSessions.getById('mine')?.launchContext).toBeUndefined();
      // Ordinary session writes do not drop the reply.
      db.boundSessions.upsert({ ...endedSession('launched', 'pending:req'), title: 'renamed' });
      expect(db.boundSessions.getById('launched')?.launchContext?.humanRepliedAt).toBe('2026-03-07T01:00:00.000Z');
      db.close();
    });

    it('counts for the agent launch of a chat the person resumed from history', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-human-reply-resume-'));
      const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
      db.boundSessions.upsert({ ...endedSession('launched', 'pending:req'), resumeConversationRef: 'native-1' });
      db.boundSessions.setLaunchContext('launched', context);
      db.boundSessions.upsert(endedSession('other-launch', 'native-2'));
      db.boundSessions.setLaunchContext('other-launch', context);
      // The person reopens the saved chat: a new row on the same native conversation, with no launch record of its own.
      db.boundSessions.upsert(endedSession('resumed', 'native-1'));
      expect(db.boundSessions.listAgentLaunchMarks().map((mark) => mark.conversationRef).sort()).toEqual(['native-2', 'pending:req']);

      expect(db.boundSessions.markHumanReplied('resumed', '2026-03-07T01:00:00.000Z')).toEqual(['launched']);
      expect(db.boundSessions.listAgentLaunchMarks().map((mark) => mark.conversationRef)).toEqual(['native-2']);
      expect(db.boundSessions.getById('other-launch')?.launchContext?.humanRepliedAt).toBeUndefined();
      db.close();
    });

    it('is found in the event log for chats launched before replies were tracked', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-human-reply-backfill-'));
      const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
      const write = async (name: string, lines: unknown[]) => {
        const file = path.join(tempDir, `${name}.jsonl`);
        await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
        return file;
      };
      const open = (id: string, ref: string, eventLogPath: string | undefined) => {
        db.boundSessions.upsert({ ...endedSession(id, ref), eventLogPath });
        db.boundSessions.setLaunchContext(id, context);
      };
      open('answered', 'pending:a', await write('answered', [
        { type: 'agent-input', text: 'do the thing', timestamp: '2026-03-07T00:01:00.000Z' },
        { type: 'status', text: 'working', timestamp: '2026-03-07T00:02:00.000Z' },
        { type: 'user-input', text: 'looks good, also add tests', timestamp: '2026-03-07T00:03:00.000Z' },
        { type: 'user-input', text: 'thanks', timestamp: '2026-03-07T00:09:00.000Z' },
      ]));
      open('agent-only', 'pending:b', await write('agent-only', [
        { type: 'agent-input', text: 'do the other thing', timestamp: '2026-03-07T00:01:00.000Z' },
      ]));
      open('no-log', 'pending:c', undefined);
      open('missing-log', 'pending:d', path.join(tempDir, 'missing.jsonl'));
      // The agent's session shows no reply, but the person resumed the saved chat and answered in the new row.
      open('resumed-launch', 'pending:e', await write('resumed-launch', [
        { type: 'agent-input', text: 'another thing', timestamp: '2026-03-07T00:01:00.000Z' },
      ]));
      db.boundSessions.upsert({ ...endedSession('resumed-launch', 'pending:e'), resumeConversationRef: 'native-e', eventLogPath: path.join(tempDir, 'resumed-launch.jsonl') });
      db.boundSessions.upsert({ ...endedSession('resumed-by-me', 'native-e'), eventLogPath: await write('resumed-by-me', [
        { type: 'user-input', text: 'picking this back up', timestamp: '2026-03-07T00:20:00.000Z' },
      ]) });

      await expect(backfillHumanReplies(db)).resolves.toBe(2);
      expect(db.boundSessions.getById('answered')?.launchContext?.humanRepliedAt).toBe('2026-03-07T00:03:00.000Z');
      expect(db.boundSessions.getById('resumed-launch')?.launchContext?.humanRepliedAt).toBe('2026-03-07T00:20:00.000Z');
      expect(db.boundSessions.getById('agent-only')?.launchContext?.humanRepliedAt).toBeUndefined();
      expect(db.boundSessions.getById('no-log')?.launchContext?.humanRepliedAt).toBeUndefined();
      // A second pass has nothing left to do.
      await expect(backfillHumanReplies(db)).resolves.toBe(0);
      db.close();
    });
  });
});
