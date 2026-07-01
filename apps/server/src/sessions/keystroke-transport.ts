import type { ProviderId, SessionScreen } from '@agent-console/shared';
import {
  screenAllowsLiteralSelectionTokenWithoutInput,
  screenAllowsLiteralSelectionWithoutInput,
  screenInputMatchesText,
  screenShowsClaudeResumeSessionChoice,
  shouldUseBracketedPasteTransport,
  submittedTextShouldCreateUserTurn,
} from './screen-heuristics.js';

export interface KeystrokeSendPayload {
  text?: string;
  keys?: string[];
  deferScreenUpdate?: boolean;
  submittedText?: string;
}

export interface KeystrokeSendPlan {
  hasSpecialKeys: boolean;
  isTextOnlySend: boolean;
  submittedText?: string;
  transportText?: string;
  trimmedTransportText: string;
  useBracketedPasteTransport: boolean;
  shouldProbeDeferredSelection: boolean;
  shouldProbeClaudeResumePrompt: boolean;
  shouldCapturePreparedScreenBeforeText: boolean;
  shouldPrepareClaudeResumePrompt: boolean;
  expectsVisibleInputChange: boolean;
  shouldRecordTextAsUserInput: boolean;
  textAlreadyVisible: boolean;
  transportTextShouldCreateUserTurn: boolean;
}

interface KeystrokePlannerOptions {
  deferredTextReady?: boolean;
}

export function planKeystrokeSend(
  screen: SessionScreen | undefined,
  payload: KeystrokeSendPayload,
  provider: ProviderId,
  options: KeystrokePlannerOptions = {},
): KeystrokeSendPlan {
  const hasSpecialKeys = Boolean(payload.keys?.length);
  const isTextOnlySend = Boolean(payload.text) && !hasSpecialKeys;
  const transportText = payload.text;
  const trimmedTransportText = transportText?.trim() ?? '';
  const submittedText = payload.keys?.includes('Enter') ? payload.submittedText?.trim() : undefined;
  const useBracketedPaste = transportText ? shouldUseBracketedPasteTransport(transportText) : false;
  const shouldProbeDeferredSelection = payload.deferScreenUpdate === true && /^\d{1,8}$/.test(trimmedTransportText);
  const shouldProbeClaudeResumePrompt = payload.deferScreenUpdate === true && provider === 'claude';

  const expectsVisibleInputChange = Boolean(
    screen && transportText && !screenAllowsLiteralSelectionWithoutInput(screen, transportText),
  );
  const shouldRecordTextAsUserInput = Boolean(
    screen && transportText && !screenAllowsLiteralSelectionTokenWithoutInput(screen, transportText),
  );
  const shouldPrepareClaudeResumePrompt = Boolean(
    screen && provider === 'claude' && screenShowsClaudeResumeSessionChoice(screen),
  );
  const textAlreadyVisible = Boolean(
    screen && hasSpecialKeys && transportText && screenInputMatchesText(screen, transportText),
  );
  const transportTextShouldCreateUserTurn = Boolean(
    screen && transportText && submittedTextShouldCreateUserTurn(screen, transportText),
  );

  return {
    hasSpecialKeys,
    isTextOnlySend,
    submittedText,
    transportText,
    trimmedTransportText,
    useBracketedPasteTransport: useBracketedPaste,
    shouldProbeDeferredSelection,
    shouldProbeClaudeResumePrompt,
    shouldCapturePreparedScreenBeforeText: isTextOnlySend
      && !options.deferredTextReady
      && (provider === 'codex' || shouldProbeDeferredSelection || shouldProbeClaudeResumePrompt),
    shouldPrepareClaudeResumePrompt,
    expectsVisibleInputChange,
    shouldRecordTextAsUserInput,
    textAlreadyVisible,
    transportTextShouldCreateUserTurn,
  };
}
