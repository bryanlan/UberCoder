import { describe, expect, it } from 'vitest';
import { isWorkingStatusLine, parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';

describe('parseSessionScreenSnapshot', () => {
  it('keeps wrapped composer text in inputText and leaves the footer status intact', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      '❯ draft a long prompt that fills the composer width',
      'wrapped prompt text should stay attached to the composer buffer',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('draft a long prompt that fills the composer width wrapped prompt text should stay attached to the composer buffer');
    expect(screen.status).toContain('98% left');
    expect(screen.status).not.toContain('wrapped prompt text');
  });

  it('does not surface wrapped input text in the footer status area', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      '❯ draft a long prompt that fills the composer width',
      '',
      'wrapped prompt text should stay out of the footer status area',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('draft a long prompt that fills the composer width');
    expect(screen.status).toContain('98% left');
    expect(screen.status).not.toContain('wrapped prompt text');
  });

  it('keeps trailing interactive picker output in the main content and reserves status for footer metadata only', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '',
      'Working tree clean.',
      'Choose how to continue',
      '❯ Continue with current branch',
      '  Create a new branch',
      'Enter to confirm · Esc to exit',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).toContain('Working tree clean.');
    expect(screen.content).toContain('Choose how to continue');
    expect(screen.content).toContain('Continue with current branch');
    expect(screen.content).toContain('Create a new branch');
    expect(screen.content).toContain('Enter to confirm');
    expect(screen.status).toBe('Session active');
    expect(screen.awaitingUserInput).toBe(true);
  });

  it('keeps a short real prompt in inputText even when a footer status is present', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      '❯ hi',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('hi');
    expect(screen.status).toContain('98% left');
    expect(screen.awaitingUserInput).toBe(true);
  });

  it('keeps Claude pasted-text placeholders attached to the active composer input', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '',
      'Ready for input.',
      '',
      '❯ ',
      '⎿ [Pasted text #1 +58 lines]',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n'));

    expect(screen.inputText).toBe('[Pasted text #1 +58 lines]');
    expect(screen.content).toContain('Ready for input.');
    expect(screen.content).not.toContain('Pasted text #1');
    expect(screen.status).toContain('bypass permissions on');
    expect(screen.awaitingUserInput).toBe(true);
  });

  it('keeps timed Working lines in the main content when the composer is visible', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '',
      '• Working (2m 46s • esc to interrupt)',
      '',
      '› Run /review on my current changes',
      'gpt-5.4 xhigh · 93% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('Run /review on my current changes');
    expect(screen.content).toContain('Investigating recency updates…');
    expect(screen.content).toContain('Working (2m 46s • esc to interrupt)');
    expect(screen.status).not.toContain('Working (2m 46s • esc to interrupt)');
    expect(screen.status).toContain('93% left');
    expect(screen.awaitingUserInput).toBe(true);
  });

  it('does not treat previously submitted prompt lines as the active composer after assistant output follows', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Message: fix live session reliability and sidebar state',
      '',
      'I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
      'unstaged and out of this commit.',
      '',
      '› Run /review on my current changes',
      '',
      '  Message: fix live session reliability and sidebar state',
      '',
      '  I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
      '  unstaged and out of this commit.',
      'gpt-5.4 xhigh · 65% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).toContain('Run /review on my current changes');
    expect(screen.status).toContain('65% left');
  });

  it('extracts model and context from Codex footer status line', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Ready for input.',
      '❯ hello',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.model).toBe('gpt-5.4 medium');
    expect(screen.contextPercent).toBe(98);
  });

  it('recognizes working status lines with alternate bullet glyphs', () => {
    expect(isWorkingStatusLine('◦ Working (12s • esc to interrupt)')).toBe(true);
    expect(isWorkingStatusLine('▪ Working...')).toBe(true);
    expect(isWorkingStatusLine('Thinking about the repository…')).toBe(true);
    expect(isWorkingStatusLine('Applying patch...')).toBe(true);
  });

  it('recognizes working status lines with Braille spinner characters', () => {
    expect(isWorkingStatusLine('⠋ Working (12s · esc to interrupt)')).toBe(true);
    expect(isWorkingStatusLine('⠙ Working...')).toBe(true);
    expect(isWorkingStatusLine('⠸ bash(ls -la)')).toBe(true);
    expect(isWorkingStatusLine('⠼ Read(/path/to/file)')).toBe(true);
  });

  it('keeps a trailing numbered plan in the main content instead of treating it like a picker', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Here is the plan:',
      '1. restore the toggle',
      '2. add persistent manual project order',
      '3. add drag-and-drop for project rows when the toggle is off',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).toContain('1. restore the toggle');
    expect(screen.content).toContain('2. add persistent manual project order');
    expect(screen.content).toContain('3. add drag-and-drop for project rows when the toggle is off');
    expect(screen.status).toContain('98% left');
    expect(screen.status).not.toContain('restore the toggle');
    expect(screen.awaitingUserInput).toBe(false);
  });

  it('treats an empty composer prompt as waiting for user input', () => {
    const screen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      'Ready for input.',
      '❯ ',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.awaitingUserInput).toBe(true);
  });
});
