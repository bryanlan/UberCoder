import type { SessionScreen } from '@agent-console/shared';
import { describe, expect, it } from 'vitest';
import { planKeystrokeSend } from '../src/sessions/keystroke-transport.js';

function screen(input: Partial<SessionScreen>): SessionScreen {
  return {
    content: '',
    inputText: '',
    status: '',
    capturedAt: '2026-07-01T00:00:00.000Z',
    ...input,
  };
}

describe('keystroke transport planner', () => {
  it('plans Codex text-only sends to inspect readiness before writing unless the ready cache is valid', () => {
    const cold = planKeystrokeSend(undefined, { text: 'hello', deferScreenUpdate: true }, 'codex');
    expect(cold).toMatchObject({
      hasSpecialKeys: false,
      isTextOnlySend: true,
      shouldCapturePreparedScreenBeforeText: true,
      useBracketedPasteTransport: false,
    });

    const ready = planKeystrokeSend(
      undefined,
      { text: 'hello', deferScreenUpdate: true },
      'codex',
      { deferredTextReady: true },
    );
    expect(ready.shouldCapturePreparedScreenBeforeText).toBe(false);
  });

  it('classifies deferred numeric picker input as selection control text', () => {
    const plan = planKeystrokeSend(
      undefined,
      { text: '2', deferScreenUpdate: true },
      'claude',
    );

    expect(plan.shouldProbeDeferredSelection).toBe(true);
    expect(plan.shouldProbeClaudeResumePrompt).toBe(true);
    expect(plan.trimmedTransportText).toBe('2');
  });

  it('keeps combined text plus Enter visible-input expectations explicit', () => {
    const composer = screen({
      inputText: 'recap where we left things',
    });
    const plan = planKeystrokeSend(
      composer,
      { text: 'recap where we left things', keys: ['Enter'], submittedText: 'recap where we left things' },
      'codex',
    );

    expect(plan).toMatchObject({
      hasSpecialKeys: true,
      textAlreadyVisible: true,
      submittedText: 'recap where we left things',
      shouldRecordTextAsUserInput: true,
      transportTextShouldCreateUserTurn: true,
    });
  });

  it('does not treat model-picker numeric selections as user-turn text', () => {
    const picker = screen({
      content: [
        'Select model',
        '❯ 1. Opus 4.1',
        '  2. Sonnet 4.5',
        'Enter to confirm · Esc to exit',
      ].join('\n'),
    });

    const plan = planKeystrokeSend(
      picker,
      { text: '1', keys: ['Enter'], submittedText: '1' },
      'claude',
    );

    expect(plan.shouldRecordTextAsUserInput).toBe(false);
    expect(plan.transportTextShouldCreateUserTurn).toBe(false);
  });
});
