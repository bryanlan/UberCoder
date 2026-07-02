import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@agent-console/shared';
import { applySessionEvent } from './apply-session-event';

function context(overrides: Partial<Parameters<typeof applySessionEvent>[1]> = {}): Parameters<typeof applySessionEvent>[1] {
  return {
    queryClient: new QueryClient(),
    selectedProjectSlug: 'demo',
    selectedProvider: 'codex',
    selectedConversationRef: 'real-conversation',
    selectedConversationRouteActive: true,
    timelineBoundSessionId: 'session-1',
    debugOpen: false,
    appendMessageToConversationCache: vi.fn(),
    scheduleTimelineMessageRefresh: vi.fn(),
    ...overrides,
  };
}

function transcriptUpdatedEvent(overrides: Partial<Extract<SessionEvent, { type: 'session.transcript-updated' }>> = {}): Extract<SessionEvent, { type: 'session.transcript-updated' }> {
  return {
    type: 'session.transcript-updated',
    sessionId: 'session-1',
    projectSlug: 'demo',
    provider: 'codex',
    conversationRef: 'real-conversation',
    timestamp: '2026-07-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('applySessionEvent', () => {
  it('refreshes selected timeline messages when the provider transcript changes', () => {
    const testContext = context();

    applySessionEvent(transcriptUpdatedEvent(), testContext);

    expect(testContext.scheduleTimelineMessageRefresh).toHaveBeenCalledWith(
      'demo',
      'codex',
      'real-conversation',
    );
    expect(testContext.appendMessageToConversationCache).not.toHaveBeenCalled();
  });

  it('does not refresh timeline messages for unrelated transcript changes', () => {
    const testContext = context();

    applySessionEvent(transcriptUpdatedEvent({
      sessionId: 'session-2',
      conversationRef: 'other-conversation',
    }), testContext);

    expect(testContext.scheduleTimelineMessageRefresh).not.toHaveBeenCalled();
  });
});
