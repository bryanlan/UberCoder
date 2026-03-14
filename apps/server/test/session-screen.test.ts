import { describe, expect, it } from 'vitest';
import { parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';

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
  });
});
