import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@agent-console/shared';
import { groupTranscriptTurns } from './transcript-turns';

function message(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: overrides.id ?? 'message-1',
    provider: 'codex',
    role: 'assistant',
    lifecycle: 'durable',
    text: 'Text',
    timestamp: '2026-07-03T15:00:00.000Z',
    conversationRef: 'conversation-1',
    source: 'history-file',
    ...overrides,
  };
}

describe('groupTranscriptTurns', () => {
  it('keeps pending assistant progress separate from durable assistant answers', () => {
    const turns = groupTranscriptTurns([
      message({
        id: 'pending-progress',
        lifecycle: 'pending',
        text: 'Still checking.',
        timestamp: '2026-07-03T15:00:00.000Z',
      }),
      message({
        id: 'final-answer',
        lifecycle: 'durable',
        text: 'Done.',
        timestamp: '2026-07-03T15:00:10.000Z',
      }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.lifecycle)).toEqual(['pending', 'durable']);
    expect(turns.map((turn) => turn.messages.map((item) => item.text))).toEqual([
      ['Still checking.'],
      ['Done.'],
    ]);
  });
});
