import { describe, expect, it } from 'vitest';
import type { SessionScreen } from '@agent-console/shared';
import { parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';
import {
  extractLastClaudeModelFromText,
  hashScreen,
  screenInputMatchesText,
  screenAllowsLiteralSelectionTokenWithoutInput,
  screenLooksReadyForLiteralPrompt,
  screenShowsClaudeResumeSessionChoice,
  screenShowsInteractiveSelectionHint,
  screenShowsQueuedMessageHint,
  shouldUseBracketedPasteTransport,
  submittedTextShouldCreateUserTurn,
} from '../src/sessions/screen-heuristics.js';

function screen(input: Partial<SessionScreen>): SessionScreen {
  return {
    content: '',
    inputText: '',
    inputActive: false,
    status: '',
    capturedAt: '2026-03-01T00:00:00.000Z',
    ...input,
  };
}

describe('screen heuristics', () => {
  it('matches native Codex rows that wrap inside a word without ignoring within-row spaces', () => {
    const draft = parseSessionScreenSnapshot([
      '› Explain model usage from 2026-10-01 to 2026-11-',
      '  01',
      '  text-generation 1,000 input tokens $0.10',
      '',
      '  Include both entries.',
      '  GPT-6.1-Sol xhigh fast · ~/code/demo',
    ].join('\n'));
    const text = 'Explain model usage from 2026-10-01 to 2026-11-01\ntext-generation\t1,000 input tokens $0.10\n\nInclude both entries.';
    expect(draft.inputText).toContain('2026-11-\n01');
    expect(screenInputMatchesText(draft, text)).toBe(true);
    expect(screenInputMatchesText(draft, text.replace('1,000', '2,000'))).toBe(false);
    expect(screenInputMatchesText(draft, text.replace('input tokens', 'inputtokens'))).toBe(false);
    expect(screenInputMatchesText(draft, `${text}\n${text}`)).toBe(false);
  });

  it('recognizes a real Claude composer without requiring the permissions footer', () => {
    const ready = parseSessionScreenSnapshot('Claude Code\nThe answer is ready.\n────────────────────\n❯ ');
    expect(ready.inputActive).toBe(true);
    expect(screenLooksReadyForLiteralPrompt(ready)).toBe(true);
    expect(screenLooksReadyForLiteralPrompt(parseSessionScreenSnapshot('Claude Code\n❯ '))).toBe(true);
  });

  it('requires a composer even when the permissions footer is visible', () => {
    const footerOnly = screen({ content: 'Finishing Stop hooks…', status: '⏵⏵ bypass permissions on' });
    expect(screenLooksReadyForLiteralPrompt(footerOnly)).toBe(false);
  });

  it('keeps quoted picker instructions from blocking a real composer', () => {
    const ready = parseSessionScreenSnapshot([
      'Claude Code',
      'The picker says:',
      'Enter to confirm · Esc to cancel',
      'Press enter to confirm or esc to go back',
      '────────────────────',
      '❯ ',
      '────────────────────',
      '⏵⏵ bypass permissions on',
    ].join('\n'));
    expect(ready.inputActive).toBe(true);
    expect(screenLooksReadyForLiteralPrompt(ready)).toBe(true);
  });

  it('distinguishes an empty composer from a selection with otherwise identical display text', () => {
    const selection = screen({ content: 'Choose an option', inputActive: false });
    const composer = { ...selection, inputActive: true };
    expect(hashScreen(composer)).not.toBe(hashScreen(selection));
  });
  it.each([
    'enter select · esc back',
    'enter default · s session · esc back',
  ])('recognizes the current Codex model picker control: %s', (footer) => {
    const picker = screen({ content: `Select Model and Effort\n› 2. GPT-6-Sol (current)\n${footer}` });
    expect(screenShowsInteractiveSelectionHint(picker)).toBe(true);
    expect(screenAllowsLiteralSelectionTokenWithoutInput(picker, '2')).toBe(true);
    expect(submittedTextShouldCreateUserTurn(picker, '2')).toBe(false);
  });
  it('detects Codex queue-message mode without treating queued text as ready input', () => {
    const queued = screen({
      content: [
        'Working',
        'tab to queue message                                        37% context left',
      ].join('\n'),
      inputText: '',
      inputActive: false,
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
