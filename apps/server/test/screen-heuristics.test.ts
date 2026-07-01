import { describe, expect, it } from 'vitest';
import type { SessionScreen } from '@agent-console/shared';
import {
  extractLastClaudeModelFromText,
  screenAllowsLiteralSelectionTokenWithoutInput,
  screenLooksReadyForLiteralPrompt,
  screenShowsClaudeResumeSessionChoice,
  screenShowsQueuedMessageHint,
  shouldUseBracketedPasteTransport,
  submittedTextShouldCreateUserTurn,
} from '../src/sessions/screen-heuristics.js';

function screen(input: Partial<SessionScreen>): SessionScreen {
  return {
    content: '',
    inputText: '',
    status: '',
    capturedAt: '2026-03-01T00:00:00.000Z',
    ...input,
  };
}

describe('screen heuristics', () => {
  it('detects Codex queue-message mode without treating queued text as ready input', () => {
    const queued = screen({
      content: [
        'Working',
        'tab to queue message                                        37% context left',
      ].join('\n'),
      inputText: '',
    });

    expect(screenShowsQueuedMessageHint(queued)).toBe(true);
    expect(screenLooksReadyForLiteralPrompt(queued)).toBe(false);
  });

  it('detects Claude resume choices and waits until they clear before literal prompt entry', () => {
    const resumePrompt = screen({
      content: [
        'This session is 12 days old and 186k tokens.',
        '❯ 1. Resume from summary (recommended)',
        '  2. Resume full session as-is',
        "  3. Don't ask me again",
        'Enter to confirm · Esc to cancel',
      ].join('\n'),
      status: '⏵⏵ bypass permissions on (shift+tab to cycle)',
    });

    expect(screenShowsClaudeResumeSessionChoice(resumePrompt)).toBe(true);
    expect(screenLooksReadyForLiteralPrompt(resumePrompt)).toBe(false);
  });

  it('treats numeric selection tokens as UI control input rather than user turns', () => {
    const picker = screen({
      content: [
        'Select model',
        '❯ 1. Opus 4.1',
        '  2. Sonnet 4.5',
        'Enter to confirm · Esc to exit',
      ].join('\n'),
    });

    expect(screenAllowsLiteralSelectionTokenWithoutInput(picker, '1')).toBe(true);
    expect(submittedTextShouldCreateUserTurn(picker, '1')).toBe(false);
    expect(submittedTextShouldCreateUserTurn(picker, 'normal user reply')).toBe(true);
  });

  it('keeps Claude model extraction and paste-threshold behavior stable', () => {
    expect(extractLastClaudeModelFromText('Set model to Opus 4.1')).toBe('Opus 4.1');
    expect(shouldUseBracketedPasteTransport('single line')).toBe(false);
    expect(shouldUseBracketedPasteTransport(`line one\nline two`)).toBe(true);
    expect(shouldUseBracketedPasteTransport('x'.repeat(513))).toBe(true);
  });
});
