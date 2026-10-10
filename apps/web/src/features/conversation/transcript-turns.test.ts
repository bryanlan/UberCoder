import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@agent-console/shared';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { groupTranscriptTurns, shouldShowInMainTranscript, TranscriptDocumentTurn } from './transcript-turns';

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

it('shows normalized provider failures while keeping raw status output hidden', () => {
  const failure = message({ role: 'status', statusKind: 'run-failure' });
  expect(shouldShowInMainTranscript(failure)).toBe(true);
  expect(shouldShowInMainTranscript({ ...failure, statusKind: undefined })).toBe(false);
  expect(shouldShowInMainTranscript({ ...failure, source: 'live-output' })).toBe(false);
});

it('renders Claude compaction as a separate green tag with the preceding chat preserved', () => {
  const marker = message({ id: 'summary', provider: 'claude', role: 'status', statusKind: 'compaction',
    text: '[Claude auto summarized]', timestamp: '2026-07-03T15:55:00.000Z' });
  expect(shouldShowInMainTranscript(marker)).toBe(true);
  expect(shouldShowInMainTranscript({ ...marker, source: 'live-output' })).toBe(false);
  const turns = groupTranscriptTurns([
    message({ id: 'prompt', provider: 'claude', role: 'user', text: 'My earlier prompt' }), marker,
    message({ id: 'next-prompt', provider: 'claude', role: 'user', text: 'My next prompt', timestamp: '2026-07-03T16:00:00.000Z' }),
  ]);
  expect(turns).toHaveLength(3);
  render(createElement('div', null, ...turns.map(turn => createElement(TranscriptDocumentTurn, { key: turn.id, turn }))));
  expect(screen.getByText('My earlier prompt')).toBeVisible();
  expect(screen.getByText('My next prompt')).toBeVisible();
  expect(screen.getByText('[Claude auto summarized]')).toHaveClass('text-emerald-500');
  expect(screen.getAllByText('You')).toHaveLength(2);
  expect(screen.queryByText('Status')).not.toBeInTheDocument();
});
