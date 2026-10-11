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

/** Native task chrome can stay present while the foreground composer is ready. */
export function screenShowsBackgroundWork(screen: SessionScreen): boolean {
  const statusLines = stripAnsiAndControl(screen.status).split('\n').map(normalizeWhitespace);
  if (statusLines.some((line) => /(?:^|·)\s*[1-9]\d*\s+(?:shells?|(?:background\s+)?agents?|tasks?)(?:\s*·|$)/i.test(line)
    // Claude's native roster is separated into status by the screen parser.
    // A child remains part of this session until its roster row disappears.
    || /^[●◯○]\s+(?!main(?:\s|$))\S/u.test(line))) return true;
  const lastContentLine = stripAnsiAndControl(screen.content).split('\n').map(normalizeWhitespace).filter(Boolean).at(-1) ?? '';
  // Codex renders this live row immediately above its composer. Do not scan
  // older conversation prose mentioning a previously running terminal.
  return /^[1-9]\d* background terminals? running · \/ps to view · \/stop to close$/i.test(lastContentLine)
    || /^[✻✽✶✢✳*]\s+Waiting for [1-9]\d* background agents? to finish$/i.test(lastContentLine);
}

export function screenInputChanged(previous: SessionScreen, next: SessionScreen): boolean {
  return normalizeComparableText(previous.inputText) !== normalizeComparableText(next.inputText);
}

export function screenInputMatchesText(screen: SessionScreen, text: string | undefined): boolean {
  if (!text?.trim()) {
    return false;
  }
  // Native composer rows can wrap inside a word. Keep literal characters and
  // within-row spaces exact; only a rendered row boundary may add whitespace.
  const rows = screen.inputText.split('\n').map((row) => normalizeComparableText(row)).filter(Boolean);
  const pattern = rows.map((row) => row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ?');
  return Boolean(pattern) && new RegExp(`^${pattern}$`, 'u').test(normalizeComparableText(text));
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
  if (screen.inputActive || !text || text.length > 8 || !/^[\w./:-]+$/u.test(text.trim())) {
    return false;
  }

  const normalizedLines = `${screen.content}\n${screen.status}`
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const trailingLines = normalizedLines.slice(-8);

  if (trailingLines.some((line) => /Enter (?:select|default) · (?:s session · )?Esc back/i.test(line)
    || /Enter to confirm · Esc to (?:exit|cancel)/i.test(line)
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
    .some((line) => /Enter (?:select|default) · (?:s session · )?Esc back/i.test(line)
      || /Enter to confirm · Esc to (?:exit|cancel)/i.test(line)
      || /Press enter to confirm or esc to go back/i.test(line)
      || /Enter to set as default · s to use this session only · Esc to cancel/i.test(line)
      || /Esc to cancel · Tab to amend/i.test(line)
      || /Enter to select · .*Esc to cancel/i.test(line)
      || /^Enter continue · Esc skip$/i.test(line));
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

/** Only the active, complete native resume menu may be answered automatically. */
export function claudeFullSessionResumeSelection(screen: SessionScreen): 'summary' | 'full' | 'always' | undefined {
  if (screen.inputActive || screen.inputText.trim()) return undefined;
  const lines = stripAnsiAndControl(screen.content).split('\n').map(normalizeWhitespace).filter(Boolean);
  const menu = lines.slice(-4);
  if (menu[3] !== 'Enter to confirm · Esc to cancel'
    || !lines.slice(-12, -4).some((line) => /^This session is .+ old and .+ tokens\.?$/i.test(line))) return undefined;
  const choices = menu.slice(0, 3);
  const options = choices.map((line) => line.replace(/^[❯›>]\s*/u, ''));
  if (!/^1\. Resume from summary \((?:instant, )?recommended\)$/.test(options[0] ?? '')
    || options[1] !== '2. Resume full session as-is'
    || options[2] !== "3. Don't ask me again") return undefined;
  const selected = choices.map((line, index) => /^[❯›>]\s*/u.test(line) ? index : -1).filter((index) => index >= 0);
  if (selected.length !== 1) return undefined;
  return (['summary', 'full', 'always'] as const)[selected[0]!];
}

export function claudeFolderTrustSelection(screen: SessionScreen): 'accept' | 'exit' | undefined {
  if (screen.inputActive) return undefined;
  const lines = screen.content.split('\n').map(normalizeWhitespace).filter(Boolean);
  const text = lines.join(' ');
  if (!lines.includes('Accessing workspace:')
    || !/Quick safety check: Is this a project you created or one you trust\?/i.test(text)
    || !lines.includes('Enter to confirm · Esc to cancel')) return undefined;
  // Only the final choice block is active. Earlier trust dialogs can remain
  // in captured scrollback while a different approval is on screen.
  const menu = lines.slice(-3);
  if (menu[2] !== 'Enter to confirm · Esc to cancel') return undefined;
  const choices = menu.slice(0, 2);
  const options = choices.map((line) => line.replace(/^[❯›>]\s*/u, ''));
  if (!options.includes('No, exit') || !options.includes('Yes, I trust this folder')) return undefined;
  const selectedChoices = choices.filter((line) => /^[❯›>]/u.test(line));
  if (selectedChoices.length !== 1) return undefined;
  const selected = selectedChoices[0];
  if (/^[❯›>]\s*Yes, I trust this folder$/u.test(selected ?? '')) return 'accept';
  if (/^[❯›>]\s*No, exit$/u.test(selected ?? '')) return 'exit';
  return undefined;
}

export function screenLooksReadyForLiteralPrompt(screen: SessionScreen): boolean {
  // Claude can omit its permissions footer when notifications fill the pane.
  // The parsed composer is the readiness evidence; a footer alone is not.
  if (
    !screen.inputActive
    || screenShowsClaudeResumeSessionChoice(screen)
    || sessionScreenShowsWorking(screen)
    || screenShowsQueuedMessageHint(screen)
  ) {
    return false;
  }

  const normalized = normalizeWhitespace(`${screen.content}\n${screen.status}`);
  return !/starting mcp servers/i.test(normalized);
}

export function screenAllowsLiteralSelectionTokenWithoutInput(screen: SessionScreen, text: string | undefined): boolean {
  return !screen.inputActive && Boolean(text?.trim().match(/^\d{1,8}$/)) && screenShowsInteractiveSelectionHint(screen);
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
    `${screen.contentAnsi ?? screen.content}\n---\n${screen.inputText}\n---\n${screen.inputActive}\n---\n${screen.statusAnsi ?? screen.status}`,
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
