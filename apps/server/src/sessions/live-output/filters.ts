import type { MessageRole, NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText, normalizeWhitespace, stripAnsiAndControl, truncate } from '../../lib/text.js';

export function classifyChunk(text: string): MessageRole {
  const trimmed = text.trim();
  if (!trimmed) return 'status';
  if (
    /^(thinking|running|tool|read|write|edit|apply|status|error|warning|diff|command|tip:|message; enter confirms|openai codex|claude code|model:|directory:|permissions:|approval:|sandbox:|context window:|use medium effort|with medium effort|1 mcp server failed|explored(?:\s|$)|search(?:ed|ing)?(?:\s|$)|searched the web(?:\s|$)|searching the web(?:\s|$)|waiting for background terminal)/i.test(trimmed)
    || /^ran\s+(?:[\w./-]+|mkdir|pwd|codex|npm|npx|git|python3?|node|rg|sed|cat|ls|find|curl)(?:\s|$)/i.test(trimmed)
    || /^(?:mkdir|pwd|codex|npm|npx|git|python3?|node|rg|sed|cat|ls|find|curl|repo-check|check)(?:\s|$)/i.test(trimmed)
    || /^(?:ran \d+ shell commands?|background command\b)/i.test(trimmed)
    || /^(?:run codex non-interactively|print version|-V,\s*--version|for more information, try '--help'\.?)/i.test(trimmed)
    || /^(?:baked for|cooked for|gusting\b|code \d+$)/i.test(trimmed)
    || /^(?:import\s+\w+|from\s+\S+\s+import|with\s+open\(|for\s+\w+\s+in\s+|if\s+.*:|[A-Za-z_]\w*\s*=|json\.dump|raise\s+\w+|traceback\b|file\s+["'])/i.test(trimmed)
    || looksLikeToolFileListLine(trimmed)
    || looksLikeSearchContinuationLine(trimmed)
    || /^… \+\d+ lines(?: \(ctrl \+ t to view transcript\))?$/i.test(trimmed)
    || /(booting mcp server|esc to interrupt|\b\d+% left\b)/i.test(trimmed)
    || /^~\/|^\/home\//.test(trimmed)
    || /\/home\/bryan\/code\//.test(trimmed)
  ) {
    return 'status';
  }
  return 'assistant';
}

function looksLikeToolFileListLine(line: string): boolean {
  const tokens = line
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 12) return false;
  const fileTokenCount = tokens.filter((token) => /^[\w./-]+\.(?:py|ts|tsx|js|md|toml|json|yml|yaml|sql)(?::\d+)?$/i.test(token)).length;
  return fileTokenCount > 0 && fileTokenCount / tokens.length >= 0.5;
}

function looksLikeSearchContinuationLine(line: string): boolean {
  const pipeCount = (line.match(/\|/g) ?? []).length;
  if (pipeCount < 2) return false;
  return !/[.!?]\s+[A-Z]/.test(line);
}

function looksLikeNoise(line: string): boolean {
  if (!/[A-Za-z0-9]/.test(line)) return true;
  if (/^[>\-_+=|/\\[\]{}()<>.:;,*'"`~!?@#$%^&]+$/.test(line)) return true;
  if (/^[▐▛▜▘▝▪•─│╭╰]+$/.test(line)) return true;
  if (/^[A-Za-z]$/.test(line)) return true;
  if (/^PY$/.test(line)) return true;
  if (/^[*·]\d+$/.test(line)) return true;
  if (/^… \+\d+ lines(?: \(ctrl \+ t to view transcript\))?$/i.test(line)) return true;
  if (line.endsWith('…') && line.length <= 24) return true;
  if (/^(?:thinking|unravelling|scampering|gallivanting|brewed|churned|cooked|crunched|worked|saut(?:é|e)ed|baked|cogitated)(?:\s+for\s+\d+s)?\.?$/i.test(line)) return true;
  if (/^thought\s+for\s+\d+s\.?$/i.test(line)) return true;
  if (/^(?:\d[\d,]*\s*)?tokens?(?:\s+(?:left|remaining|used))?$/i.test(line)) return true;
  if (/^for agents$/i.test(line)) return true;
  if (/(?:Sttarr|WWoorr|Wng|Wog|MCP.*Working|Starting MCP servers)/i.test(line)) return true;
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4) {
    const shortTokenCount = tokens.filter((token) => /^[A-Za-z]{1,3}$/.test(token)).length;
    if (shortTokenCount / tokens.length > 0.75) return true;
  }
  return false;
}

function adjacentDuplicateLetterRatio(text: string): number {
  const letters = text.match(/[A-Za-z]/g)?.join('').toLowerCase() ?? '';
  if (!letters) return 0;
  let duplicateCount = 0;
  for (let index = 1; index < letters.length; index += 1) {
    if (letters[index] === letters[index - 1]) {
      duplicateCount += 1;
    }
  }
  return duplicateCount / letters.length;
}

function collapseRepeatedLetters(text: string): string {
  return text.replace(/([a-z])\1+/g, '$1');
}

function looksLikeProviderStatusRepaint(line: string): boolean {
  const compact = normalizeFragmentToken(line);
  if (!compact) return true;
  if (/^(?:ngg|kiin|inng|rkkiinngg|rkkiin|rkki|wogor|woorrk|wo)$/.test(compact)) {
    return true;
  }

  const collapsed = collapseRepeatedLetters(compact);
  const hasRepaintMarker = /\d/.test(compact)
    || adjacentDuplicateLetterRatio(line) >= 0.18
    || /(?:ww|oo|rr|kk|ii|nn|gg)/.test(compact);
  if (
    compact.length <= 28
    && hasRepaintMarker
    && (
      /w{1,2}o{1,2}r+\d*r?k?/.test(compact)
      || /r+k+i+n+g?/.test(compact)
      || /k+i+n+g+/.test(compact)
      || /^(?:i*n+g+\d*|g+\d*|e?r+l*r*m+i+n+a+l+|t*e*a*l*e?r+l*r*m+i+n+a+l+)$/.test(compact)
      || /^\d+w$/.test(compact)
      || /^g\d+(?:w|wo|wor|work|rk|ki|in|ng)/.test(collapsed)
      || /(?:wo|wor|ork|rki|kin|ing)\d+(?:wo|wor|ork|rki|kin|ing)/.test(collapsed)
    )
  ) {
    return true;
  }

  if (
    /mcp/.test(collapsed)
    && /(?:serv|sers|start|stin|stng|esc|interrupt|chrome|playwright|codexapps|openaideveloperdocs)/.test(collapsed)
  ) {
    return true;
  }

  if (
    /(?:working|workin|rking|waiting|waitin|background|terminal|searchingtheweb|summarizerecentcommits)/.test(collapsed)
    && (
      /[\d•◦·]/u.test(line)
      || adjacentDuplicateLetterRatio(line) >= 0.18
      || compact.length <= 32
    )
  ) {
    return true;
  }

  return /(?:fockork|fitfotior|baou|acuncknd|troteouer|tnateal|lrmmiinnaall|unrmndmid)/.test(collapsed);
}

function looksLikeShortCursorFragment(line: string): boolean {
  const trimmed = line.trim().replace(/^[*·✻✽✢✶]+/u, '');
  if (/%/.test(trimmed)) return false;
  const compact = normalizeFragmentToken(line);
  if (!compact) return true;
  if (/^\d+$/.test(compact)) return true;
  if (compact.length <= 4 && /\d/.test(compact)) return true;
  if (compact.length <= 3 && /^[a-z]{1,3}$/i.test(trimmed)) return true;
  if (compact.length > 4) return false;
  return /^[a-z]{1,4}(?:\.+|…+)?$/.test(trimmed);
}

function removeTrailingProviderRepaintSuffix(line: string): string {
  return line
    .replace(/\s+WWo$/u, '')
    .replace(/(?:\.?\s*)(?:ngg|WWo+|Wo+\s*or|Worr?k+|orrk|rkki+|kiin(?:gg?)?|inngg?|in\s+ngg|erl\s*rmmiinnaall|tealerlrmmi\s*innaall)(?:\s+\d+)?$/iu, '')
    .trim();
}

function looksLikeFragmentCluster(lines: string[]): boolean {
  return lines.length >= 4 && lines.every((line) => {
    const token = line
      .replace(/^[*·✻✽✢✶]+/u, '')
      .replace(/…+$/u, '');
    return /^[A-Za-z]{1,6}$/.test(token) && (token.length === 1 || !/^[A-Z0-9_]+$/.test(token));
  });
}

function normalizeFragmentToken(line: string): string {
  return normalizeComparableText(line
    .replace(/[▰▱█▐▌▛▜▘▝*·✻✽✢✶…]+/gu, ' ')
    .replace(/\([^)]*\)/g, ' '))
    .replace(/[^a-z0-9]+/g, '');
}

function looksLikeRepaintFragment(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^\d{1,3}%?$/.test(trimmed)) return true;
  const compact = normalizeFragmentToken(trimmed);
  if (!compact) return true;
  if (/^\d{1,3}$/.test(compact)) return true;
  if (/^[a-z]{1,7}\d{0,3}$/.test(compact) && trimmed.length <= 14) return true;
  if (/^[a-z]{1,5}\s+[a-z]{1,3}$/i.test(trimmed)) return true;
  return false;
}

function looksLikeTerminalRepaintFragmentCluster(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const fragmentCount = lines.filter(looksLikeRepaintFragment).length;
  const hasSubstantiveLine = lines.some((line) => {
    if (looksLikeRepaintFragment(line)) return false;
    const compact = normalizeFragmentToken(line);
    return compact.length >= 14 || /[.!?][)"']?$/.test(line.trim());
  });
  return !hasSubstantiveLine && fragmentCount / lines.length >= 0.75;
}

export function rawOutputStartsProviderProgress(text: string): boolean {
  const cleaned = stripAnsiAndControl(text);
  const lines = cleaned
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const hasCompactCommandLine = lines.some((line) => /^(?:[❯›>]\s*)?\/compact(?:\s|$)/i.test(line));
  const hasCompactingProgressLine = lines.some((line) => (
    /compactingconversation/.test(normalizeComparableText(line).replace(/\s+/g, ''))
  ));
  const hasProgressBarLine = lines.some((line) => /[▰▱█]{3,}.*\d{1,3}%?$/.test(line) || /^\d{1,3}%?$/.test(line));
  return hasCompactingProgressLine && (hasCompactCommandLine || hasProgressBarLine);
}

function lineLooksLikeProviderProgressControl(line: string, options: { allowBarePercent?: boolean } = {}): boolean {
  const trimmed = normalizeWhitespace(line);
  if (!trimmed) return true;
  if (/^(?:[❯›>]\s*)?\/compact(?:\s|$)/i.test(trimmed)) return true;
  if (/[▰▱█]{3,}.*\d{1,3}%?$/.test(trimmed)) return true;
  if (options.allowBarePercent === true && /^\d{1,3}%$/.test(trimmed)) return true;
  const compact = normalizeComparableText(trimmed).replace(/[^a-z0-9]+/g, '');
  return /compactingconversation/.test(compact);
}

export function splitRawOutputAtProviderProgress(text: string, lastUserInput: string | undefined): {
  beforeProgressText: string;
  echoedUserInputAfterProgress: boolean;
  progressStarted: boolean;
} {
  const comparable = normalizeComparableText(lastUserInput ?? '');
  const compact = comparable.replace(/\s+/g, '');
  const beforeProgressLines: string[] = [];
  let sawProviderProgress = false;
  let echoedUserInputAfterProgress = false;

  for (const rawLine of stripAnsiAndControl(text).split(/\n/)) {
    const line = normalizeTerminalLine(rawLine);
    if (!line) {
      continue;
    }
    if (lineLooksLikeProviderProgressControl(line, { allowBarePercent: true })) {
      sawProviderProgress = true;
      continue;
    }
    if (!sawProviderProgress) {
      beforeProgressLines.push(rawLine);
      continue;
    }
    if (!compact) continue;
    const comparableLine = normalizeComparableText(line);
    const compactLine = comparableLine.replace(/\s+/g, '');
    if (lineEchoesUserInput(comparableLine, compactLine, comparable, compact)) {
      echoedUserInputAfterProgress = true;
    }
  }
  return {
    beforeProgressText: beforeProgressLines.join('\n'),
    echoedUserInputAfterProgress,
    progressStarted: sawProviderProgress,
  };
}

export function linesAreOnlyProviderProgressRepaint(lines: string[]): boolean {
  if (lines.length === 0) return true;
  if (lines.every((line) => lineLooksLikeProviderProgressControl(line))) return true;
  return looksLikeTerminalRepaintFragmentCluster(lines);
}

function looksLikeTerminalChrome(line: string): boolean {
  return /(?:^|\s)(?:OpenAI Codex|Claude Code|model:|directory:|permissions:|approval:|sandbox:|context window:|Use medium effort|with medium effort|Use \/skills to list available|loading \/model to change)/i.test(line)
    || /^(?:We recommend .+ effort|Effort determines|recommend .+ effort for most tasks|and maximize rate limits|Use ultrathink)/i.test(line)
    || /^(?:\d+\.\s+Use .+ effort|gpt-[\w.]+ .+ left .+|(?:Opus|Sonnet|Haiku|Fable) .+ Claude Max)$/i.test(line);
}

function looksLikeIdleHousekeeping(line: string): boolean {
  const compact = line.replace(/\s+/g, '').toLowerCase();
  if (/^setmodelto(?:haiku|opus|sonnet|fable|default)/.test(compact)) return true;
  if (/^tip:connectclaudetoyouride/.test(compact)) return true;
  return /^(?:Checking for updates|How is Claude doing this session\? \(optional\)|Set model to .+)$/i.test(line)
    || /^free up context\.?$/i.test(line)
    || /^(?:\d+\s*:\s*Bad\s+\d+\s*:\s*Fine\s+\d+\s*:\s*Good\s+\d+\s*:\s*Dismiss)$/i.test(line)
    || /^(?:Select model|Switch between Claude models\.?|Your pick becomes the default|For other\/previous model names|Enter to confirm(?:\s*·\s*Esc to exit)?|Press enter to confirm or esc to go back|Enter to set as default.*Esc to cancel|Esc to exit|Cancelled)$/i.test(line)
    || /(?:Switch between Claude models|Your pick becomes the default|For other\/previous model names|Fable.+unavailable|Sonnet 5|Efficient for routine tasks)/i.test(line)
    || /^(?:Effort|Faster Smarter|lowmediumhighxhighmax|.*to adjust.*Enter.*Esc to cancel|.*Effort not supported.*)$/i.test(line)
    || /^(?:\d+\.\s+(?:Default|Opus|Sonnet|Haiku|Fable)|Default \(recommended\)|Sonnet|Opus|Haiku|Fable \(disabled\)|complex tasks)$/i.test(line)
    || /^\/[a-z][\w-]*(?:\s|$)/i.test(line)
    || /(?:MCP servers? need authentication|tmux detected|bypass permissions on|focus-events|set -g mouse|shift\+tab|← for agents|esc to interrupt|Press up to edit queued messages|Tip: Run \/install-github-app)/i.test(line)
    || /(?:Learn more|https?:\/\/|fable-mythos-access|reuse\/simplification\/efficiency|Queued follow-up inputs|shift\s+\+\s+←\s+edit)/i.test(line)
    || /(?:You have \d+ usage limit resets available|Run \/usage to use one|Starting MCP servers)/i.test(line)
    || /(?:I'm not sure what you're asking for with\s*\/model|A few possibilities|Check the current model\?|Switch to a faster mode\?|Invoke a skill\?|What did you have in mind\?|You're running on Claude Haiku|Use\s*\/fast\s*to toggle|Skills use the format)/i.test(line)
    || /^↳\s*\S+/.test(line);
}

function looksLikeProviderMenuLine(line: string): boolean {
  return /(?:Select model|Switch between Claude models|Your pick becomes the default|For other\/previous model names|Enter to set as default|Effort not supported|Use\s*\/fast\s*to turn on Fast mode)/i.test(line)
    || /(?:Default\s*\(?recommended\)?.*Opus|Opus\s*Opus|Haiku\s*✔?\s*Haiku|Fable.*disabled|thos-access)/i.test(line)
    || /^\d+\.\s*(?:Default|Opus|Sonnet|Haiku|Fable)/i.test(line);
}

function looksLikeBareNumericLine(line: string): boolean {
  return /^\d+$/.test(line);
}

function looksLikePickerChunk(lines: string[]): boolean {
  return lines.some((line) => looksLikeProviderMenuLine(line)
    || /(?:Select model|Enter to confirm|Enter to set as default|Press enter to confirm|Esc to exit|Esc to cancel|Switch between Claude models)/i.test(line));
}

function removeKnownPromptPlaceholders(line: string): string {
  return line
    .replace(/\s*(?:❯|›|>_?)\s*(?:Implement \{feature\}|Write tests for @filename|Improve documentation in @filename|Find and fix a bug in @filename|Explain this codebase|Summarize recent commits|Run \/review on my current changes).*$/i, '')
    .trim();
}

function removeKnownStatusAffixes(line: string): string {
  return line
    .replace(/^You\s*have\s*\d+\s*usage\s*limit\s*resets\s*available\.?\s*Run\s*\/usage\s*to\s*use\s*one\.?\s*/i, '')
    .replace(/(?:worked|churned|cooked|crunched|saut(?:é|e)ed|baked)\s*for\s*\d+s\.?$/i, '')
    .trim();
}

function normalizeTerminalLine(text: string): string {
  return removeKnownStatusAffixes(normalizeWhitespace(
    removeKnownPromptPlaceholders(
      text
        .trimStart()
        .replace(/[│╭╮╰╯─┌┐└┘├┤┬┴┼█▛▜▐▌▝▘]+/gu, ' ')
        .replace(/[•▪◦]+/gu, ' ')
        .replace(/\s+/g, ' '),
    ).replace(/^(?:❯|›|>_?|▋|▌|▐|●|✻|✽|✢|✶|⎿)\s*/u, ''),
  ));
}

function extractExactReplyRequest(text: string | undefined): string | undefined {
  const match = text?.trim().match(/^reply\s+exactly\s+(.+)$/i);
  const expected = match?.[1]?.trim();
  return expected || undefined;
}

export function removePreviouslySeenAssistantText(line: string, messages: NormalizedMessage[]): string {
  const normalizedLine = line.trim();
  const currentAssistantRun: NormalizedMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      break;
    }
    if (message.role === 'assistant' && message.source === 'live-output') {
      currentAssistantRun.push(message);
    }
  }
  const previousAssistantLines = new Set(currentAssistantRun
    .flatMap((message) => message.text.split(/\n+/))
    .map((text) => text.trim())
    .filter((text) => text.length >= 6));
  return previousAssistantLines.has(normalizedLine) ? '' : line;
}

export function shouldDropPreSubmitPromptEcho(
  previous: NormalizedMessage | undefined,
  inputText: string,
  inputTimestamp: string,
): boolean {
  if (!previous || previous.role !== 'assistant' || previous.source !== 'live-output') {
    return false;
  }
  if (previous.text.trim() !== inputText) {
    return false;
  }
  const previousTime = Date.parse(previous.timestamp);
  const inputTime = Date.parse(inputTimestamp);
  return Number.isFinite(previousTime) && Number.isFinite(inputTime)
    && inputTime >= previousTime
    && inputTime - previousTime <= 2_000;
}

function lineEchoesUserInput(comparableLine: string, compactLine: string, comparable: string, compact: string): boolean {
  if (!comparable || !compact) return false;
  if (comparableLine === comparable || compactLine === compact) return true;
  if (comparable.length >= 16 && (comparableLine.startsWith(comparable) || compactLine.startsWith(compact))) return true;
  if (compactLine.length >= 16 && compact.includes(compactLine)) return true;
  return false;
}

function looksLikeExactReplyFragment(line: string, exactReply: string | undefined): boolean {
  if (!exactReply) return false;
  const trimmed = line.trim();
  const expected = exactReply.trim();
  if (!trimmed || trimmed === expected) return false;

  const shortRepaintToken = trimmed
    .replace(/^[*·✻✽✢✶]+/u, '')
    .replace(/…+$/u, '');
  if (
    shortRepaintToken
    && shortRepaintToken !== expected
    && /^[A-Za-z]{1,6}$/.test(shortRepaintToken)
    && (shortRepaintToken.length === 1 || !/^[A-Z0-9_]+$/.test(shortRepaintToken))
  ) {
    return true;
  }

  if (!/^[A-Z0-9_ -]{6,}$/.test(trimmed)) return false;

  const compactLine = normalizeComparableText(trimmed).replace(/\s+/g, '');
  const compactExpected = normalizeComparableText(expected).replace(/\s+/g, '');
  if (!compactLine || compactLine.length >= compactExpected.length) return false;
  if (compactExpected.includes(compactLine)) return true;

  const upperLine = trimmed.toUpperCase();
  const sharedToken = expected
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length >= 5 && !/^\d+$/.test(token))
    .some((token) => upperLine.includes(token));
  return sharedToken && /\d/.test(trimmed);
}

function isKnownExactReplyChromeCompact(text: string): boolean {
  if (!text) return true;
  return /^(?:worked|churned|cooked|crunched|saut(?:é|e)ed|baked|cogitated|thought)for\d+s\.?$/i.test(text);
}

function compactLineIsExactReplyAnswer(compactLine: string, expectedCompact: string): boolean {
  if (!compactLine || !expectedCompact) return false;
  const expectedIndex = compactLine.indexOf(expectedCompact);
  if (expectedIndex === -1) return false;
  const prefix = compactLine.slice(0, expectedIndex);
  const suffix = compactLine.slice(expectedIndex + expectedCompact.length);
  return isKnownExactReplyChromeCompact(prefix) && isKnownExactReplyChromeCompact(suffix);
}

function lineHasExactReplyAnswer(line: string, exactReply: string, lastUserInput: string | undefined): boolean {
  const expectedComparable = normalizeComparableText(exactReply);
  const expectedCompact = expectedComparable.replace(/\s+/g, '');
  const comparableLine = normalizeComparableText(line);
  const compactLine = comparableLine.replace(/\s+/g, '');
  if (comparableLine === expectedComparable || compactLine === expectedCompact) {
    return true;
  }

  const latestUserCompact = normalizeComparableText(lastUserInput ?? '').replace(/\s+/g, '');
  const compactWithoutPrompt = latestUserCompact
    ? compactLine.replace(latestUserCompact, '')
    : compactLine;
  return compactLineIsExactReplyAnswer(compactLine, expectedCompact)
    || compactLineIsExactReplyAnswer(compactWithoutPrompt, expectedCompact);
}

export function normalizeRawOutputLines(text: string, lastUserInput?: string, userInputEchoes: string[] = []): string[] {
  const cleaned = stripAnsiAndControl(text);
  const candidateLines = cleaned
    .split(/\n+/)
    .map((rawLine) => normalizeTerminalLine(rawLine))
    .map((line) => removeTrailingProviderRepaintSuffix(line))
    .filter(Boolean);
  if (candidateLines.length >= 4 && candidateLines.every((line) => /^[A-Za-z]{1,4}$/.test(line))) {
    return [];
  }
  if (looksLikeFragmentCluster(candidateLines)) {
    return [];
  }
  const hasPickerContext = looksLikePickerChunk(candidateLines);
  const comparableUserInputs = [...new Set([lastUserInput, ...userInputEchoes].filter((input): input is string => Boolean(input?.trim())))]
    .map((input) => {
      const comparable = normalizeComparableText(input);
      return { comparable, compact: comparable.replace(/\s+/g, '') };
    });
  const exactReply = extractExactReplyRequest(lastUserInput);
  if (exactReply) {
    const hasExpectedAnswer = candidateLines.some((line) => lineHasExactReplyAnswer(line, exactReply, lastUserInput));
    if (hasExpectedAnswer) {
      return [exactReply];
    }
  }
  const normalized: string[] = [];

  for (const line of candidateLines) {
    if (
      !line
      || looksLikeNoise(line)
      || looksLikeProviderStatusRepaint(line)
      || (candidateLines.length > 1 && looksLikeShortCursorFragment(line))
      || looksLikeTerminalChrome(line)
      || looksLikeIdleHousekeeping(line)
      || looksLikeProviderMenuLine(line)
      || (hasPickerContext && looksLikeBareNumericLine(line))
      || looksLikeExactReplyFragment(line, exactReply)
    ) continue;
    if (comparableUserInputs.length > 0) {
      const comparableLine = normalizeComparableText(line);
      const compactLine = comparableLine.replace(/\s+/g, '');
      const isUserEcho = comparableUserInputs.some(({ comparable, compact }) => lineEchoesUserInput(
        comparableLine,
        compactLine,
        comparable,
        compact,
      ));
      if (isUserEcho) continue;
    }

    const previous = normalized.at(-1);
    if (previous === line) continue;
    if (previous && line.startsWith(previous) && line.length <= previous.length + 16) {
      normalized[normalized.length - 1] = line;
      continue;
    }
    if (previous && previous.startsWith(line) && previous.length <= line.length + 16) {
      continue;
    }
    normalized.push(line);
  }

  if (looksLikeTerminalRepaintFragmentCluster(normalized)) {
    return [];
  }

  return normalized
    .map((line) => line.replace(/\s+WWo$/u, '').trim())
    .filter(Boolean);
}
