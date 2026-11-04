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
      grok: { id: 'grok', label: 'Grok', conversations: [] },
      vibe: { id: 'vibe', label: 'Mistral Vibe', conversations: [] },
    },
  };
}

function tree(conversations: ProjectSummary['providers']['codex']['conversations'] = [], boundSessions: BoundSession[] = []): TreeResponse {
  return {
    projects: [project(conversations)],
    boundSessions,
    structuredProviders: [],
  };
}

function session(overrides: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-1',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'pending:one',
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

  describe('a chat an agent launched', () => {
    const launched = (humanRepliedAt?: string): BoundSession => session({
      launchContext: {
        launchedBy: 'assignment-1', launcherName: 'Planner lead', grantIds: ['grant-1'], requestId: 'req', supervisorId: 'assignment-1',
        ...(humanRepliedAt ? { humanRepliedAt } : {}),
      },
    });
    const chatOf = (current: TreeResponse | undefined) => current?.projects[0]?.providers.codex.conversations[0];

    it('is labelled agent-driven until the person replies', () => {
      const withLaunch = applySessionUpdateToTree(tree(), launched());
      expect(chatOf(withLaunch)?.agentControlled).toEqual({ launcherName: 'Planner lead' });
      expect(chatOf(applySessionUpdateToTree(tree(), launched('2026-03-07T00:05:00.000Z')))?.agentControlled).toBeUndefined();
    });

    it('stops being agent-driven when the person sends a message, and a message the Console writes does not count', () => {
      const withLaunch = applySessionUpdateToTree(tree(), launched());
      const quiet = applySessionActivityToTree(withLaunch, { sessionId: 'session-1', timestamp: '2026-03-07T00:04:00.000Z' });
      expect(quiet?.boundSessions[0]?.launchContext?.humanRepliedAt).toBeUndefined();
      expect(chatOf(quiet)?.agentControlled).toEqual({ launcherName: 'Planner lead' });

      const replied = applySessionActivityToTree(withLaunch, { sessionId: 'session-1', timestamp: '2026-03-07T00:05:00.000Z', fromPerson: true });
      expect(replied?.boundSessions[0]?.launchContext?.humanRepliedAt).toBe('2026-03-07T00:05:00.000Z');
      expect(chatOf(replied)?.agentControlled).toBeUndefined();
      // The label that names who launched it stays; only the "agent-driven" test changes.
      expect(replied?.boundSessions[0]?.launchContext?.launcherName).toBe('Planner lead');
    });

    it('stays the person\'s when a later update was built before their reply was recorded', () => {
      const replied = applySessionActivityToTree(applySessionUpdateToTree(tree(), launched()), {
        sessionId: 'session-1', timestamp: '2026-03-07T00:05:00.000Z', fromPerson: true,
      });
      const stale = applySessionUpdateToTree(replied, { ...launched(), title: 'Renamed' });
      expect(stale?.boundSessions[0]?.launchContext?.humanRepliedAt).toBe('2026-03-07T00:05:00.000Z');
      expect(chatOf(stale)?.agentControlled).toBeUndefined();
    });

    it('leaves the agent group when the person reopens the saved chat and replies, though the new session has no launch record', () => {
      const saved = tree([{
        ref: 'pending:one', projectSlug: 'demo', provider: 'codex', kind: 'history', title: 'Saved agent chat', updatedAt: baseTime,
        isBound: true, boundSessionId: 'session-1', degraded: false, agentControlled: { launcherName: 'Planner lead' },
      }], [session()]);
      const replied = applySessionActivityToTree(saved, { sessionId: 'session-1', timestamp: '2026-03-07T00:05:00.000Z', fromPerson: true });
      expect(chatOf(replied)?.agentControlled).toBeUndefined();
      expect(replied?.boundSessions[0]?.launchContext).toBeUndefined();
      // Output the agent or provider writes does not do it.
      expect(chatOf(applySessionActivityToTree(saved, { sessionId: 'session-1', timestamp: '2026-03-07T00:05:00.000Z' }))?.agentControlled)
        .toEqual({ launcherName: 'Planner lead' });
    });

    it('ignores a reply in a chat the person started', () => {
      const mine = applySessionActivityToTree(tree([], [session()]), { sessionId: 'session-1', timestamp: baseTime, fromPerson: true });
      expect(mine?.boundSessions[0]?.launchContext).toBeUndefined();
    });
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

  it('shows an open question from a session update and drops it once the update no longer carries one', () => {
    const request = {
      requestId: 'q1', kind: 'question' as const, summary: 'Strict or flexible?', openedAt: baseTime,
      questions: [{ id: 'schema', question: 'Strict or flexible?', options: [{ label: 'Strict' }] }],
    };
    const current = conversationTimeline({ conversationRef: 'history-one', boundSession: session({ conversationRef: 'history-one' }) });
    const asking = applySessionUpdateToTimeline(current, session({ conversationRef: 'history-one', pendingRequests: [request] }));
    expect(asking?.boundSession?.pendingRequests).toEqual([request]);
    // The update after the answer has no pendingRequests key at all; the old list must not survive the merge.
    const answered = applySessionUpdateToTimeline(asking, session({ conversationRef: 'history-one' }));
    expect(answered?.boundSession?.pendingRequests).toBeUndefined();
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

  it('keeps the agent launch label after the session ends', () => {
    const indexed = tree([{
      ref: 'native',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Helper',
      updatedAt: baseTime,
      isBound: true,
      degraded: false,
    }]);
    const launched = session({
      conversationRef: 'native',
      launchContext: {
        launchedBy: 'assignment-1',
        launcherName: 'Planner lead',
        grantIds: ['grant-1'],
        requestId: 'req',
        supervisorId: 'assignment-1',
      },
    });

    const live = applySessionUpdateToTree(indexed, launched);
    const ended = applySessionUpdateToTree(live, { ...launched, status: 'ended', shouldRestore: false });

    expect(live?.projects[0]?.providers.codex.conversations[0]?.agentControlled).toEqual({ launcherName: 'Planner lead' });
    expect(ended?.boundSessions).toEqual([]);
    expect(ended?.projects[0]?.providers.codex.conversations[0]).toMatchObject({
      isBound: false,
      agentControlled: { launcherName: 'Planner lead' },
    });
  });
});
