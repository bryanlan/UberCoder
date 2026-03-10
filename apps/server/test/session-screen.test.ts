import { describe, expect, it } from 'vitest';
import { parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';

describe('parseSessionScreenSnapshot', () => {
  it('splits content from the bottom status row', () => {
    const snapshot = [
      'OpenAI Codex',
      '',
      'Inspecting src/session-manager.ts',
      'Planning patch for route invalidation',
      '',
      'gpt-5.4 medium · 96% left · ~/code/demo',
    ].join('\n');

    const parsed = parseSessionScreenSnapshot(snapshot, '2026-03-07T01:02:03.000Z');
    expect(parsed.content).toContain('Inspecting src/session-manager.ts');
    expect(parsed.content).toContain('Planning patch for route invalidation');
    expect(parsed.inputText).toBe('');
    expect(parsed.status).toBe('gpt-5.4 medium · 96% left · ~/code/demo');
    expect(parsed.capturedAt).toBe('2026-03-07T01:02:03.000Z');
  });

  it('falls back to a startup placeholder when the pane is still empty', () => {
    const parsed = parseSessionScreenSnapshot('\n\n');
    expect(parsed.content).toBe('Waiting for session output…');
    expect(parsed.inputText).toBe('');
    expect(parsed.status).toBe('Starting session…');
  });

  it('moves the active command menu into the footer pane instead of the main content', () => {
    const snapshot = [
      'Claude Code v2.1.71',
      'Opus 4.6 · Claude Max',
      '~/code/cfplearner',
      '',
      '❯ /model',
      '────────────────────────────────────────────────────────────────────────────────',
      '  \u001b[7m/mcp-builder                 (example-skills) Guide for creating high-quali…\u001b[27m',
      '  /status                      Show Claude Code status including version, mod…',
      '  /web-artifacts-builder       (example-skills) Suite of tools for creating e…',
      '  /fast                        Toggle fast mode (Opus 4.6 only)',
      '  /vim                         Toggle between Vim and Normal editing modes',
      '  /plan                        Enable plan mode or view the current session p…',
    ].join('\n');

    const parsed = parseSessionScreenSnapshot(snapshot, '2026-03-09T19:55:00.000Z');
    expect(parsed.content).not.toContain('❯ /model');
    expect(parsed.content).not.toContain('/plan');
    expect(parsed.content).not.toContain('/status');
    expect(parsed.inputText).toBe('/model');
    expect(parsed.status).toContain('/plan');
    expect(parsed.status).toContain('/status');
    expect(parsed.statusAnsi).toContain('\u001b[7m');
  });

  it('still extracts a real footer hint into the status box when present', () => {
    const snapshot = [
      'Select model',
      '  1. Default',
      '❯ 2. Sonnet',
      '  3. Haiku',
      '',
      'Enter to confirm · Esc to exit',
    ].join('\n');

    const parsed = parseSessionScreenSnapshot(snapshot, '2026-03-09T19:56:00.000Z');
    expect(parsed.content).toContain('❯ 2. Sonnet');
    expect(parsed.inputText).toBe('');
    expect(parsed.status).toBe('Enter to confirm · Esc to exit');
  });

  it('keeps wrapped composer text out of the live output pane', () => {
    const snapshot = [
      'Claude Code v2.1.71',
      'Opus 4.6 · Claude Max',
      '~/code/cfplearner',
      '',
      '● Previous assistant reply',
      '',
      '❯ this is a very long line that wraps once it reaches the edge of the tmux pane and',
      '  keeps going on the next visual line',
      '',
      'esc to interrupt',
    ].join('\n');

    const parsed = parseSessionScreenSnapshot(snapshot, '2026-03-10T05:01:00.000Z');
    expect(parsed.content).not.toContain('keeps going on the next visual line');
    expect(parsed.inputText).toBe('this is a very long line that wraps once it reaches the edge of the tmux pane and keeps going on the next visual line');
    expect(parsed.status).toBe('esc to interrupt');
  });
});
