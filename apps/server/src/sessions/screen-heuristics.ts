import type { SessionScreen } from '@agent-console/shared';
import { normalizeComparableText, normalizeWhitespace, stableTextHash, stripAnsiAndControl } from '../lib/text.js';
import { isWorkingStatusLine } from './session-screen.js';

const MIN_COMBINED_TEXT_KEY_SETTLE_WAIT_MS = 700;
const MAX_COMBINED_TEXT_KEY_SETTLE_WAIT_MS = 3_000;
export const TMUX_LITERAL_TEXT_CHUNK_SIZE = 512;

export function sessionScreenShowsWorking(screen: SessionScreen): boolean {
  return [screen.status, screen.statusAnsi ?? '', ...screen.content.split('\n').slice(-8)]
    .flatMap((block) => block.split('\n'))
    .map((line) => normalizeWhitespace(line))
    .some((line) => isWorkingStatusLine(line));
}

export function screenInputChanged(previous: SessionScreen, next: SessionScreen): boolean {
  return normalizeComparableText(previous.inputText) !== normalizeComparableText(next.inputText);
}

export function screenInputMatchesText(screen: SessionScreen, text: string | undefined): boolean {
  if (!text?.trim()) {
    return false;
  }
  return normalizeComparableText(screen.inputText) === normalizeComparableText(text);
}

export function screenShowsQueuedMessageHint(screen: SessionScreen): boolean {
  return `${screen.content}\n${screen.status}\n${screen.statusAnsi ?? ''}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .some((line) => /tab to queue message/i.test(line));
}

export function screenIsStartingUp(screen: SessionScreen): boolean {
  const normalizedStatus = normalizeWhitespace(screen.status);
  const normalizedContent = normalizeWhitespace(screen.content);
  return /^starting session/i.test(normalizedStatus)
    || /^waiting for session output/i.test(normalizedContent)
    || /starting mcp servers/i.test(`${normalizedContent}\n${normalizedStatus}`);
}

export function screenAllowsLiteralSelectionWithoutInput(screen: SessionScreen, text: string | undefined): boolean {
  if (!text || text.length > 8 || !/^[\w./:-]+$/u.test(text.trim())) {
    return false;
  }

  const normalizedLines = `${screen.content}\n${screen.status}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const trailingLines = normalizedLines.slice(-8);

  if (trailingLines.some((line) => /Enter to confirm · Esc to exit/i.test(line)
    || /Press enter to confirm or esc to go back/i.test(line)
    || /Enter to set as default · s to use this session only · Esc to cancel/i.test(line))) {
    return true;
  }

  if (trailingLines.some((line) => /Esc to cancel · Tab to amend/i.test(line))) {
    return true;
  }

  if (trailingLines.some((line) => /(?:^|\s)\d:\s+\S/.test(line))) {
    return true;
  }

  const numberedChoices = trailingLines.filter((line) => /^(?:[❯›>]\s*)?\d+\.\s/.test(line));
  return numberedChoices.length >= 2;
}

function formatClaudeModelName(name: string, version: string): string {
  return `${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()} ${version}`;
}

export function extractLastClaudeModelFromText(text: string): string | undefined {
  const plain = stripAnsiAndControl(text).replace(/\u00a0/g, ' ');
  const explicitSelections = [...plain.matchAll(/\bSet\s+model\s+to\s+(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)?)/gi)];
  const latestExplicitSelection = explicitSelections.at(-1);
  if (latestExplicitSelection) {
    return formatClaudeModelName(latestExplicitSelection[1]!, latestExplicitSelection[2]!);
  }

  const checkedOptions = [...plain.matchAll(/\b(Opus|Sonnet|Haiku|Fable)\s*✔[^\n]*(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)?)/gi)];
  const latestCheckedOption = checkedOptions.at(-1);
  if (latestCheckedOption) {
    return formatClaudeModelName(latestCheckedOption[2]!, latestCheckedOption[3]!);
  }

  const headers = [...plain.matchAll(/\b(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)?)(?:\s+\([^)]*\))?\s+.*?Claude Max\b/gi)];
  const latestHeader = headers.at(-1);
  if (latestHeader) {
    return formatClaudeModelName(latestHeader[1]!, latestHeader[2]!);
  }

  return undefined;
}

export function screenShowsInteractiveSelectionHint(screen: SessionScreen): boolean {
  return `${screen.content}\n${screen.status}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(-8)
    .some((line) => /Enter to confirm · Esc to exit/i.test(line)
      || /Press enter to confirm or esc to go back/i.test(line)
      || /Enter to set as default · s to use this session only · Esc to cancel/i.test(line)
      || /Esc to cancel · Tab to amend/i.test(line)
      || /Enter to select · .*Esc to cancel/i.test(line));
}

export function screenShowsClaudeResumeSessionChoice(screen: SessionScreen): boolean {
  if (screen.inputText.trim()) {
    return false;
  }

  const normalized = normalizeWhitespace(`${screen.content}\n${screen.status}`);
  return /This session is .+ old and .+ tokens/i.test(normalized)
    && /Resume from summary/i.test(normalized)
    && /Resume full session as-is/i.test(normalized)
    && /Don't ask me again/i.test(normalized)
    && /Enter to confirm · Esc to cancel/i.test(normalized);
}

export function screenLooksReadyForLiteralPrompt(screen: SessionScreen): boolean {
  const hasClaudeInputFooter = /bypass permissions on/i.test(screen.status);
  if (
    (screenIsStartingUp(screen) && !hasClaudeInputFooter)
    || screenShowsClaudeResumeSessionChoice(screen)
    || sessionScreenShowsWorking(screen)
  ) {
    return false;
  }

  const normalized = normalizeWhitespace(`${screen.content}\n${screen.status}`);
  return hasClaudeInputFooter
    && !/Enter to confirm · Esc to cancel/i.test(normalized)
    && !/Press enter to confirm or esc to go back/i.test(normalized)
    && !/Enter to set as default · s to use this session only · Esc to cancel/i.test(normalized);
}

export function screenAllowsLiteralSelectionTokenWithoutInput(screen: SessionScreen, text: string | undefined): boolean {
  return Boolean(text?.trim().match(/^\d{1,8}$/)) && screenShowsInteractiveSelectionHint(screen);
}

export function submittedTextShouldCreateUserTurn(screen: SessionScreen, text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/')) {
    return false;
  }
  return !screenAllowsLiteralSelectionTokenWithoutInput(screen, trimmed);
}

export function hashScreen(screen: SessionScreen): string {
  return stableTextHash(
    `${screen.contentAnsi ?? screen.content}\n---\n${screen.inputText}\n---\n${screen.statusAnsi ?? screen.status}`,
  );
}

export function combinedTextKeySettleWaitMs(text: string): number {
  const lengthFactorMs = Math.max(0, text.length - 32) * 4;
  return Math.min(
    MAX_COMBINED_TEXT_KEY_SETTLE_WAIT_MS,
    Math.max(MIN_COMBINED_TEXT_KEY_SETTLE_WAIT_MS, 450 + lengthFactorMs),
  );
}

export function shouldUseBracketedPasteTransport(text: string): boolean {
  return text.length > TMUX_LITERAL_TEXT_CHUNK_SIZE || /[\r\n]/.test(text);
}
