import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { agentControlledByConversation, type AgentLaunchMark } from '../src/lib/agent-controlled.js';

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
});
