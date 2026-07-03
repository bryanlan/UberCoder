import { describe, expect, it } from 'vitest';
import type { BoundSession, ConversationTimeline, NormalizedMessage } from '@agent-console/shared';
import { timelineMessagesRefetchInterval } from './useConversationData';

function session(overrides: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-1',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'conversation-1',
    tmuxSessionName: 'ac-codex-demo-one',
    status: 'bound',
    shouldRestore: true,
    title: 'Demo',
    startedAt: '2026-07-03T15:00:00.000Z',
    updatedAt: '2026-07-03T15:00:00.000Z',
    isWorking: false,
    ...overrides,
  };
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'message-1',
    provider: 'codex',
    role: 'assistant',
    lifecycle: 'durable',
    text: 'answer',
    timestamp: '2026-07-03T15:00:00.000Z',
    conversationRef: 'conversation-1',
    source: 'history-file',
    ...overrides,
  };
}

function page(messages: NormalizedMessage[]): ConversationTimeline {
  return {
    conversation: {
      ref: 'conversation-1',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Demo',
      updatedAt: '2026-07-03T15:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-1',
      degraded: false,
    },
    messages,
    boundSession: session(),
    messagePage: { hasOlder: false, total: messages.length },
  };
}

describe('timelineMessagesRefetchInterval', () => {
  it('polls while the selected bound session is working', () => {
    expect(timelineMessagesRefetchInterval({
      boundSession: session({ isWorking: true }),
      pages: [page([message()])],
    })).toBe(1200);
  });

  it('keeps polling when the visible tail is still a submitted user turn', () => {
    expect(timelineMessagesRefetchInterval({
      boundSession: session({ isWorking: false }),
      pages: [page([
        message({ id: 'user-1', role: 'user', text: 'question', timestamp: '2026-07-03T15:49:41.000Z' }),
      ])],
    })).toBe(1200);
  });

  it('keeps polling when the session completed after the visible transcript tail', () => {
    expect(timelineMessagesRefetchInterval({
      boundSession: session({
        isWorking: false,
        lastCompletedAt: '2026-07-03T15:51:44.000Z',
      }),
      pages: [page([
        message({ id: 'old-answer', timestamp: '2026-07-03T15:49:41.000Z' }),
      ])],
    })).toBe(1200);
  });

  it('keeps polling when live output is newer than the visible transcript tail', () => {
    expect(timelineMessagesRefetchInterval({
      boundSession: session({
        isWorking: false,
        lastOutputAt: '2026-07-03T15:52:30.000Z',
      }),
      pages: [page([
        message({ id: 'old-answer', timestamp: '2026-07-03T15:49:41.000Z' }),
      ])],
    })).toBe(1200);
  });

  it('stops polling once the assistant transcript tail has caught up with completion', () => {
    expect(timelineMessagesRefetchInterval({
      boundSession: session({
        isWorking: false,
        lastCompletedAt: '2026-07-03T15:51:44.000Z',
      }),
      pages: [page([
        message({ id: 'new-answer', timestamp: '2026-07-03T15:51:42.000Z' }),
      ])],
    })).toBe(false);
  });
});
