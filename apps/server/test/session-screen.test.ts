import { describe, expect, it } from 'vitest';
import { isWorkingStatusLine, parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';

describe('parseSessionScreenSnapshot', () => {
  it('trims boxed Codex startup chrome before the first real live content line', () => {
    const screen = parseSessionScreenSnapshot([
      '╭──────────────────────────────────────────────────────╮',
      '│ OpenAI Codex                                         │',
      '│ model:     gpt-5                                     │',
      '│ directory: ~/code/agent-console-mvp/agent-console    │',
      '│ permissions: YOLO mode                               │',
      '╰──────────────────────────────────────────────────────╯',
      '',
      'Tip: New Use /fast to enable our fastest inference with increased plan usage.',
      '',
      '• I’ve adjusted the summary expectations to the corrected chat-prose window.',
      '  I’m rerunning the affected tests.',
      'gpt-5.4 xhigh · 65% left · ~/demo',
    ].join('\n'));

    expect(screen.content).toContain('I’ve adjusted the summary expectations');
    expect(screen.content).not.toContain('directory:');
    expect(screen.content).not.toContain('permissions:');
    expect(screen.content).not.toContain('/fast');
    expect(screen.status).toContain('65% left');
  });

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

  it('treats the Codex startup placeholder as an empty composer', () => {
    for (const placeholder of ['Implement {feature}', 'Write tests for @filename', 'Find and fix a bug in @filename', 'Explain this codebase', 'Summarize recent commits']) {
      const screen = parseSessionScreenSnapshot([
        `› ${placeholder}`,
        '',
        'gpt-5.5 medium · ~/code/UberCoder/agent-console-mvp/agent-console',
        '',
        '│ >_ OpenAI Codex (v0.142.4)                            │',
        '│ model:       gpt-5.5 medium   /model to change        │',
        '│ directory:   ~/code/…/agent-console-mvp/agent-console │',
        '│ permissions: YOLO mode                                │',
        '',
        'Tip: Use /status to see the current model, approvals, and token usage.',
      ].join('\n'));

      expect(screen.inputText).toBe('');
      expect(screen.content).not.toContain(placeholder);
    }
  });

  it('keeps Codex starter prompt text when it is real active input', () => {
    for (const prompt of ['Explain this codebase', 'Write tests for @filename']) {
      const screen = parseSessionScreenSnapshot([
        'OpenAI Codex',
        '',
        'Ready for input.',
        `❯ ${prompt}`,
        'gpt-5.4 medium · 98% left · ~/demo',
      ].join('\n'));

      expect(screen.inputText).toBe(prompt);
      expect(screen.content).toContain('Ready for input.');
      expect(screen.status).toContain('98% left');
    }
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
  });

  it('treats Claude startup suggestion placeholders as an empty composer', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code v2.1.197',
      'Opus 4.8 (1M context) with medium effort · Claude Max',
      '~/code/UberCoder/agent-console-mvp/agent-console',
      '',
      '⚠ 2 MCP servers need authentication · run /mcp',
      '',
      '▎ Meet Sonnet 5, smarter and more efficient for everyday work. Switch anytime',
      '▎ with /model.',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ Try "edit session-manager.test.ts to..."',
      '────────────────────────────────────────────────────────────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).not.toContain('Try "edit');
    expect(screen.status).toContain('bypass permissions on');
  });

  it('does not treat Claude slash-command suggestions as active composer input', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code v2.1.197',
      'Haiku 4.5 · Claude Max',
      '~/code/UberCoder/agent-console-mvp/agent-console',
      '',
      '/model                          Set the AI model for Claude Code (currently',
      '                                Haiku 4.5)',
      '/waltium-portfolio-data         Use for deterministic Waltium portfolio',
      '                                records and portfolio data configuration: a…',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ /model',
      '────────────────────────────────────────────────────────────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).toContain('/model');
    expect(screen.status).toContain('bypass permissions on');
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

    const bulletOutputScreen = parseSessionScreenSnapshot([
      'OpenAI Codex',
      '',
      '› Reply exactly AGENT_CONSOLE_BYPASS_OK',
      '',
      '• AGENT_CONSOLE_BYPASS_OK',
      'gpt-5.4-mini medium · ~/demo',
    ].join('\n'));

    expect(bulletOutputScreen.inputText).toBe('');
    expect(bulletOutputScreen.content).toContain('Reply exactly AGENT_CONSOLE_BYPASS_OK');
    expect(bulletOutputScreen.content).toContain('AGENT_CONSOLE_BYPASS_OK');
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

  it('extracts the Claude model name from the header when the footer has no model metadata', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '▐▛███▜▌ Opus 4.7 (1M context) with medium effort · Claude Max',
      '▝▜█████▛▘ ~/code/plaidbasic',
      '',
      'Ready for input.',
      '❯ hello',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n'));

    expect(screen.model).toBe('Opus 4.7');
    expect(screen.contextPercent).toBeUndefined();
    expect(screen.status).toContain('bypass permissions on');
  });

  it('extracts the checked Claude model from the model picker instead of the first menu option', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '',
      'Select model',
      '  1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,',
      '                            complex tasks',
      '  2. Opus                   Opus 4.8 with 1M context · Best for everyday,',
      '                            complex tasks',
      '  3. Sonnet                 Sonnet 5 · Efficient for routine tasks',
      '❯ 4. Haiku ✔                Haiku 4.5 · Fastest for quick answers',
      '  5. Fable (disabled)       Claude Fable 5 is currently unavailable.',
      '',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n'));

    expect(screen.model).toBe('Haiku 4.5');
  });

  it('extracts the latest Claude model confirmation from visible output', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '',
      '  1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,',
      '❯ 4. Haiku ✔                Haiku 4.5 · Fastest for quick answers',
      '',
      '❯ /model',
      '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n'));

    expect(screen.model).toBe('Haiku 4.5');
    expect(screen.status).toContain('bypass permissions on');
  });

  it('recognizes working status lines with alternate bullet glyphs', () => {
    expect(isWorkingStatusLine('◦ Working (12s • esc to interrupt)')).toBe(true);
    expect(isWorkingStatusLine('▪ Working...')).toBe(true);
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

  it('keeps Claude numbered response menus in content and out of the composer buffer', () => {
    const screen = parseSessionScreenSnapshot([
      'Claude Code',
      '',
      'Sonnet sub-agent hit Cloudflare Turnstile error 600010 on RC login.',
      '',
      '❯ 1. I\'ll log in manually first, then you resume',
      '  You open Chrome, log in to RC with 2FA, then I send the agent back to take over.',
      '2. Export cookies from my logged-in session, paste them in',
      '  You export rightcapital.com cookies from your browser, paste them, and the agent injects them.',
      '3. You should just download the PDF manually via a different method',
      '4. This is new — weekly download has been failing too',
      '5. Type something.',
      'Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel',
    ].join('\n'));

    expect(screen.inputText).toBe('');
    expect(screen.content).toContain('1. I\'ll log in manually first, then you resume');
    expect(screen.content).toContain('5. Type something.');
    expect(screen.content).toContain('Enter to select');
    expect(screen.status).toBe('Session active');
  });
});
