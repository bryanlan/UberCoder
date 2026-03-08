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
    expect(parsed.status).toBe('gpt-5.4 medium · 96% left · ~/code/demo');
    expect(parsed.capturedAt).toBe('2026-03-07T01:02:03.000Z');
  });

  it('falls back to a startup placeholder when the pane is still empty', () => {
    const parsed = parseSessionScreenSnapshot('\n\n');
    expect(parsed.content).toBe('Waiting for session output…');
    expect(parsed.status).toBe('Starting session…');
  });
});
