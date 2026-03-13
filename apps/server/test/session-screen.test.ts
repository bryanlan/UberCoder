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
});
