import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@agent-console/shared';
import { mergeTimelineMessages, messagesShareTimelinePageRun } from '../src/sessions/timeline-merge.js';

function message(input: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'id' | 'role' | 'text' | 'timestamp'>): NormalizedMessage {
  return {
    source: 'history-file',
    lifecycle: 'durable',
    provider: 'codex',
    conversationRef: 'conversation-1',
    ...input,
  };
}

describe('timeline merge', () => {
  it('keeps pending live user rows but drops raw-output assistant rows for transcript-backed timelines', () => {
    const transcript = [
      message({ id: 'provider-user-1', role: 'user', text: 'recap where we left things', timestamp: '2026-03-14T18:00:00.000Z' }),
      message({ id: 'provider-assistant-1', role: 'assistant', text: 'We left the usage-tracking work implemented and committed.', timestamp: '2026-03-14T18:00:05.000Z' }),
    ];
    const live = [
      message({
        id: 'live-duplicate',
        role: 'assistant',
        text: 'We left the usage-tracking work implemented and committed.',
        timestamp: '2026-03-14T18:00:06.000Z',
        source: 'live-output',
        lifecycle: 'pending',
      }),
      message({
        id: 'live-user-2',
        role: 'user',
        text: 'what was result',
        timestamp: '2026-03-14T18:00:07.000Z',
        source: 'user-input',
        lifecycle: 'pending',
      }),
      message({
        id: 'live-assistant-2',
        role: 'assistant',
        text: 'The result was clean.',
        timestamp: '2026-03-14T18:00:08.000Z',
        source: 'live-output',
        lifecycle: 'pending',
      }),
    ];

    const merged = mergeTimelineMessages({
      allMessages: transcript,
      visibleMessages: transcript,
      liveMessages: live,
    });

    expect(merged.mergedMessages.map((entry) => entry.text)).toEqual([
      'recap where we left things',
      'We left the usage-tracking work implemented and committed.',
      'what was result',
    ]);
  });

  it('does not surface raw-output assistant rows when provider history only has the submitted user turn', () => {
    const userPrompt = 'Please repeat this exactly.';
    const repeatedReply = 'Repeated reply.';
    const transcript = [
      message({ id: 'provider-user-1', role: 'user', text: userPrompt, timestamp: '2026-03-14T18:00:00.000Z' }),
    ];

    const merged = mergeTimelineMessages({
      allMessages: transcript,
      visibleMessages: transcript,
      liveMessages: [
        message({
          id: 'live-reply-1',
          role: 'assistant',
          text: repeatedReply,
          timestamp: '2026-03-14T18:00:01.000Z',
          source: 'live-output',
          lifecycle: 'pending',
        }),
        message({
          id: 'live-reply-2',
          role: 'assistant',
          text: repeatedReply,
          timestamp: '2026-03-14T18:00:02.000Z',
          source: 'live-output',
          lifecycle: 'pending',
        }),
      ],
    });

    expect(merged.mergedMessages.map((entry) => entry.text)).toEqual([
      userPrompt,
    ]);
  });

  it('drops terminal progress repaint fragments from transcript-backed timelines', () => {
    const transcript = [
      message({ id: 'provider-user-1', role: 'user', text: 'previous prompt', timestamp: '2026-07-02T16:20:00.000Z' }),
      message({ id: 'provider-assistant-1', role: 'assistant', text: 'Previous answer.', timestamp: '2026-07-02T16:20:05.000Z' }),
    ];

    const merged = mergeTimelineMessages({
      allMessages: transcript,
      visibleMessages: transcript,
      liveMessages: [
        message({
          id: 'live-user-2',
          role: 'user',
          text: 'did yo udo it?',
          timestamp: '2026-07-02T16:24:17.000Z',
          source: 'user-input',
          lifecycle: 'pending',
        }),
        message({
          id: 'live-progress-garbage',
          role: 'assistant',
          text: '▰2\n▰7\n▰9\n◐medium· /effort\n7\n8\n9',
          timestamp: '2026-07-02T16:24:18.000Z',
          source: 'live-output',
          lifecycle: 'pending',
        }),
      ],
    });

    expect(merged.mergedMessages.map((entry) => entry.text)).toEqual([
      'previous prompt',
      'Previous answer.',
      'did yo udo it?',
    ]);
  });

  it('drops live assistant chunks already contained in the durable transcript answer', () => {
    const durableAnswer = [
      'The deploy finished and the smoke test passed for the visible console.',
      'I also removed the stale reconnect banner so restored sessions no longer show duplicate progress rows.',
      'The only remaining note is that Playwright e2e still needs the opt-in headed browser run.',
    ].join(' ');
    const containedLiveChunk = [
      'removed the stale reconnect banner so restored sessions no longer show',
      'duplicate progress rows. The only remaining note is that Playwright e2e',
      'still needs the opt-in headed browser run.',
    ].join(' ');
    const transcript = [
      message({ id: 'provider-user-1', role: 'user', text: 'is the console fixed?', timestamp: '2026-07-03T18:00:00.000Z' }),
      message({ id: 'provider-assistant-1', role: 'assistant', text: durableAnswer, timestamp: '2026-07-03T18:00:05.000Z' }),
    ];

    const merged = mergeTimelineMessages({
      allMessages: transcript,
      visibleMessages: transcript,
      liveMessages: [
        message({
          id: 'live-contained-answer',
          role: 'assistant',
          text: containedLiveChunk,
          timestamp: '2026-07-03T18:00:08.000Z',
          source: 'live-output',
          lifecycle: 'pending',
        }),
        message({
          id: 'live-user-2',
          role: 'user',
          text: 'what should I run next?',
          timestamp: '2026-07-03T18:00:09.000Z',
          source: 'user-input',
          lifecycle: 'pending',
        }),
      ],
    });

    expect(merged.mergedMessages.map((entry) => entry.id)).toEqual([
      'provider-user-1',
      'provider-assistant-1',
      'live-user-2',
    ]);
  });

  it('keeps same-role messages together at page boundaries', () => {
    expect(messagesShareTimelinePageRun(
      message({ id: 'a1', role: 'assistant', text: 'one', timestamp: '2026-03-14T18:00:00.000Z' }),
      message({ id: 'a2', role: 'assistant', text: 'two', timestamp: '2026-03-14T18:00:01.000Z' }),
    )).toBe(true);
    expect(messagesShareTimelinePageRun(
      message({ id: 'u1', role: 'user', text: 'one', timestamp: '2026-03-14T18:00:00.000Z' }),
      message({ id: 'a1', role: 'assistant', text: 'two', timestamp: '2026-03-14T18:00:01.000Z' }),
    )).toBe(false);
  });
});
