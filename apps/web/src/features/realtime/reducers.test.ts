import { describe, expect, it } from 'vitest';
import type { BoundSession, ConversationTimeline, NormalizedMessage, ProjectSummary, TreeResponse } from '@agent-console/shared';
import {
  applySessionActivityToTimeline,
  applySessionActivityToTree,
  applySessionUpdateToTimeline,
  applySessionUpdateToTree,
  appendTimelineMessage,
  buildLiveUserMessage,
  removeTimelineMessage,
  replaceTimelineMessage,
} from './reducers';

const baseTime = '2026-03-07T00:00:00.000Z';

function project(conversations: ProjectSummary['providers']['codex']['conversations'] = []): ProjectSummary {
  return {
    slug: 'demo',
    directoryName: 'demo',
    displayName: 'Demo',
    path: '/tmp/demo',
    tags: [],
    allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations },
      claude: { id: 'claude', label: 'Claude', conversations: [] },
    },
  };
}

function tree(conversations: ProjectSummary['providers']['codex']['conversations'] = [], boundSessions: BoundSession[] = []): TreeResponse {
  return {
    projects: [project(conversations)],
    boundSessions,
  };
}

function session(overrides: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-1',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'pending:one',
    tmuxSessionName: 'ac-codex-demo-one',
    status: 'bound',
    shouldRestore: true,
    title: 'Live pending',
    startedAt: baseTime,
    updatedAt: baseTime,
    ...overrides,
  };
}

function conversationTimeline(input: {
  conversationRef?: string;
  boundSession?: BoundSession;
  messages?: NormalizedMessage[];
} = {}): ConversationTimeline {
  return {
    conversation: {
      ref: input.conversationRef ?? 'pending:one',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Live pending',
      updatedAt: baseTime,
      isBound: Boolean(input.boundSession),
      boundSessionId: input.boundSession?.id,
      degraded: false,
    },
    messages: input.messages ?? [],
    boundSession: input.boundSession,
    messagePage: { hasOlder: false, total: input.messages?.length ?? 0 },
  };
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'message-1',
    provider: 'codex',
    role: 'user',
    lifecycle: 'durable',
    text: 'hello',
    timestamp: baseTime,
    conversationRef: 'pending:one',
    source: 'user-input',
    ...overrides,
  };
}

describe('realtime reducers', () => {
  it('adds and removes synthetic conversations from session updates', () => {
    const activeSession = session();
    const withSynthetic = applySessionUpdateToTree(tree(), activeSession);

    expect(withSynthetic?.boundSessions.map((item) => item.id)).toEqual(['session-1']);
    expect(withSynthetic?.projects[0]?.providers.codex.conversations[0]).toMatchObject({
      ref: 'pending:one',
      isBound: true,
      boundSessionId: 'session-1',
      rawMetadata: { syntheticSessionPlaceholder: true },
    });

    const ended = applySessionUpdateToTree(withSynthetic, {
      ...activeSession,
      status: 'ended',
      shouldRestore: false,
      updatedAt: '2026-03-07T00:01:00.000Z',
    });

    expect(ended?.boundSessions).toEqual([]);
    expect(ended?.projects[0]?.providers.codex.conversations).toEqual([]);
  });

  it('updates activity timestamps only for the matching bound session', () => {
    const current = conversationTimeline({ boundSession: session() });
    const updated = applySessionActivityToTimeline(current, {
      sessionId: 'session-1',
      timestamp: '2026-03-07T00:02:00.000Z',
    });
    const treeUpdated = applySessionActivityToTree(tree([], [session()]), {
      sessionId: 'session-1',
      timestamp: '2026-03-07T00:02:00.000Z',
    });

    expect(updated?.boundSession).toMatchObject({
      updatedAt: '2026-03-07T00:02:00.000Z',
      lastActivityAt: '2026-03-07T00:02:00.000Z',
      lastOutputAt: '2026-03-07T00:02:00.000Z',
    });
    expect(treeUpdated?.boundSessions[0]).toMatchObject({
      updatedAt: '2026-03-07T00:02:00.000Z',
      lastActivityAt: '2026-03-07T00:02:00.000Z',
      lastOutputAt: '2026-03-07T00:02:00.000Z',
    });
    expect(applySessionActivityToTimeline(current, { sessionId: 'other', timestamp: '2026-03-07T00:03:00.000Z' })).toBe(current);
  });

  it('adopts the session conversation ref into the current timeline', () => {
    const current = conversationTimeline({
      conversationRef: 'pending:one',
      boundSession: session({ conversationRef: 'pending:one' }),
    });
    const updated = applySessionUpdateToTimeline(current, session({
      conversationRef: 'history-one',
      title: 'Adopted history',
      lastCompletedAt: '2026-03-07T00:04:00.000Z',
    }));

    expect(updated?.conversation).toMatchObject({
      ref: 'history-one',
      kind: 'history',
      title: 'Adopted history',
      updatedAt: '2026-03-07T00:04:00.000Z',
      isBound: true,
      boundSessionId: 'session-1',
    });
  });

  it('removes stale pending aliases when a bound session adopts history', () => {
    const activeSession = session({ conversationRef: 'pending:one' });
    const current = tree([
      {
        ref: 'pending:one',
        kind: 'pending',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Live pending',
        updatedAt: baseTime,
        isBound: true,
        boundSessionId: 'session-1',
        degraded: false,
        rawMetadata: { pending: true },
      },
      {
        ref: 'history-one',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'History transcript',
        updatedAt: baseTime,
        isBound: false,
        degraded: false,
      },
    ], [activeSession]);

    const updated = applySessionUpdateToTree(current, session({
      conversationRef: 'history-one',
      title: 'Adopted history',
      lastCompletedAt: '2026-03-07T00:04:00.000Z',
    }));

    expect(updated?.projects[0]?.providers.codex.conversations.map((item) => item.ref)).toEqual(['history-one']);
    expect(updated?.projects[0]?.providers.codex.conversations[0]).toMatchObject({
      ref: 'history-one',
      title: 'Adopted history',
      updatedAt: '2026-03-07T00:04:00.000Z',
      isBound: true,
      boundSessionId: 'session-1',
    });
  });

  it('does not merge nearby user text without a stable id match', () => {
    const optimistic = message({
      id: 'optimistic:session-1',
      text: 'recap where we left things',
      timestamp: baseTime,
      rawMetadata: { optimistic: true },
    });
    const recorded = message({
      id: 'live:session-1:120',
      text: 'recap where we left things',
      timestamp: '2026-03-07T00:00:02.000Z',
    });

    const updated = appendTimelineMessage(conversationTimeline({ messages: [optimistic] }), recorded);

    expect(updated?.messages.map((item) => item.id)).toEqual(['optimistic:session-1', 'live:session-1:120']);
    expect(updated?.messagePage?.total).toBe(2);
  });

  it('replaces optimistic user text only through the recorded id swap', () => {
    const optimistic = message({
      id: 'optimistic:session-1:nonce-1',
      text: 'recap where we left things',
      timestamp: baseTime,
      rawMetadata: { optimistic: true, optimisticNonce: 'nonce-1' },
    });
    const recorded = message({
      id: 'live:session-1:120',
      text: 'recap where we left things',
      timestamp: '2026-03-07T00:00:02.000Z',
    });

    const updated = replaceTimelineMessage(
      conversationTimeline({ messages: [optimistic] }),
      { replaceMessageId: optimistic.id, message: recorded },
    );

    expect(updated?.messages).toHaveLength(1);
    expect(updated?.messages[0]).toMatchObject({ id: 'live:session-1:120' });
    expect(updated?.messages[0]?.rawMetadata).toBeUndefined();
    expect(updated?.messagePage?.total).toBe(1);
  });

  it('builds and removes submitted live user messages by stable id', () => {
    const live = buildLiveUserMessage({
      sessionId: 'session-1',
      projectSlug: 'demo',
      provider: 'codex',
      conversationRef: 'pending:one',
      messageId: 'live:session-1:44',
      text: 'what was result',
      timestamp: baseTime,
    });
    const current = appendTimelineMessage(conversationTimeline(), live);
    const removed = removeTimelineMessage(current, 'live:session-1:44');

    expect(live).toMatchObject({
      id: 'live:session-1:44',
      role: 'user',
      source: 'user-input',
      text: 'what was result',
    });
    expect(current?.messages).toHaveLength(1);
    expect(removed?.messages).toEqual([]);
    expect(removed?.messagePage?.total).toBe(0);
  });
});
