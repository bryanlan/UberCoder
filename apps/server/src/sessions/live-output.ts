import fs from 'node:fs/promises';
import type { BoundSession, MessageRole, NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText, normalizeWhitespace, stableTextHash, stripAnsiAndControl, truncate } from '../lib/text.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyChunk(text: string): MessageRole {
  const trimmed = text.trim();
  if (!trimmed) return 'status';
  if (
    /^(thinking|running|tool|read|write|edit|apply|status|error|warning|diff|command|tip:|message; enter confirms|openai codex|claude code|model:|directory:|permissions:|approval:|sandbox:|context window:|use medium effort|with medium effort|1 mcp server failed)/i.test(trimmed)
    || /^(?:ran \d+ shell commands?|background command\b)/i.test(trimmed)
    || /^(?:baked for|cooked for|gusting\b|code \d+$)/i.test(trimmed)
    || /(booting mcp server|esc to interrupt|\b\d+% left\b)/i.test(trimmed)
    || /^~\/|^\/home\//.test(trimmed)
  ) {
    return 'status';
  }
  return 'assistant';
}

function looksLikeNoise(line: string): boolean {
  if (!/[A-Za-z0-9]/.test(line)) return true;
  if (/^[>\-_+=|/\\[\]{}()<>.:;,*'"`~!?@#$%^&]+$/.test(line)) return true;
  if (/^[▐▛▜▘▝▪•─│╭╰]+$/.test(line)) return true;
  if (/^[A-Z]$/.test(line)) return true;
  if (/^[*·]\d+$/.test(line)) return true;
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

function looksLikeFragmentCluster(lines: string[]): boolean {
  return lines.length >= 4 && lines.every((line) => {
    const token = line
      .replace(/^[*·✻✽✢✶]+/u, '')
      .replace(/…+$/u, '');
    return /^[A-Za-z]{1,6}$/.test(token) && (token.length === 1 || !/^[A-Z0-9_]+$/.test(token));
  });
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
    .replace(/\s*(?:❯|›|>_?)\s*(?:Implement \{feature\}|Write tests for @filename|Find and fix a bug in @filename|Explain this codebase|Summarize recent commits).*$/i, '')
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

function removePreviouslySeenAssistantText(line: string, messages: NormalizedMessage[]): string {
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

function shouldDropPreSubmitPromptEcho(
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

  return normalized;
}

interface SessionEventLine {
  type: 'user-input' | 'raw-output' | 'status';
  text: string;
  timestamp: string;
}

interface ReadLiveMessagesOptions {
  maxBytesFromEnd?: number;
}

interface CachedLiveMessages {
  messages: NormalizedMessage[];
}

interface EventLogReadResult {
  text: string;
  lastUserInputBeforeText?: string;
}

const liveMessageCache = new Map<string, CachedLiveMessages>();
const MAX_LIVE_MESSAGE_CACHE_ENTRIES = 64;
const MAX_EVENT_LOG_ROW_BACKTRACK_BYTES = 4 * 1024 * 1024;

function cloneMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function rememberLiveMessages(cacheKey: string, messages: NormalizedMessage[]): void {
  liveMessageCache.set(cacheKey, { messages: cloneMessages(messages) });
  if (liveMessageCache.size <= MAX_LIVE_MESSAGE_CACHE_ENTRIES) {
    return;
  }

  const oldestKey = liveMessageCache.keys().next().value as string | undefined;
  if (oldestKey) {
    liveMessageCache.delete(oldestKey);
  }
}

async function getEventLogReadPlan(
  filePath: string,
  options: ReadLiveMessagesOptions,
): Promise<{ cacheKey: string; size: number; maxBytes?: number }> {
  const stat = await fs.stat(filePath);
  const maxBytes = options.maxBytesFromEnd;
  const cacheKey = [
    filePath,
    stat.size,
    stat.mtimeMs,
    maxBytes ?? 'all',
  ].join(':');
  return { cacheKey, size: stat.size, maxBytes };
}

async function readEventLogText(
  filePath: string,
  plan: { size: number; maxBytes?: number },
): Promise<EventLogReadResult> {
  if (!plan.maxBytes || plan.size <= plan.maxBytes) {
    return { text: await fs.readFile(filePath, 'utf8') };
  }

  const start = Math.max(0, plan.size - plan.maxBytes);
  const length = plan.size - start;
  const text = await readFileSlice(filePath, start, length);
  if (start === 0) {
    return { text };
  }

  const firstNewline = text.indexOf('\n');
  if (firstNewline !== -1) {
    const rowStart = start + firstNewline + 1;
    const completeTail = text.slice(firstNewline + 1);
    if (completeTail.trim()) {
      return {
        text: completeTail,
        lastUserInputBeforeText: await findLastUserInputBefore(filePath, rowStart),
      };
    }
  }

  const rowStart = await findBoundedRowStart(filePath, start);
  if (rowStart === undefined) {
    return { text: '' };
  }
  return {
    text: await readFileSlice(filePath, rowStart, plan.size - rowStart),
    lastUserInputBeforeText: await findLastUserInputBefore(filePath, rowStart),
  };
}

async function readFileSlice(filePath: string, start: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(filePath, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function findBoundedRowStart(filePath: string, offset: number): Promise<number | undefined> {
  const backtrackStart = Math.max(0, offset - MAX_EVENT_LOG_ROW_BACKTRACK_BYTES);
  const prefix = await readFileSlice(filePath, backtrackStart, offset - backtrackStart);
  const previousNewline = prefix.lastIndexOf('\n');
  if (previousNewline !== -1) {
    return backtrackStart + previousNewline + 1;
  }
  return backtrackStart === 0 ? 0 : undefined;
}

function parseSessionEventLine(line: string): SessionEventLine | undefined {
  try {
    return JSON.parse(line) as SessionEventLine;
  } catch {
    return undefined;
  }
}

async function findLastUserInputBefore(filePath: string, offset: number): Promise<string | undefined> {
  if (offset <= 0) {
    return undefined;
  }

  const backtrackStart = Math.max(0, offset - MAX_EVENT_LOG_ROW_BACKTRACK_BYTES);
  const prefix = await readFileSlice(filePath, backtrackStart, offset - backtrackStart);
  const lines = prefix.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseSessionEventLine(lines[index] ?? '');
    if (event?.type === 'user-input') {
      const text = event.text.trim();
      return text || undefined;
    }
  }
  return undefined;
}

function nearbyRawEventContext(events: SessionEventLine[], index: number): string {
  const context: string[] = [];
  const start = Math.max(0, index - 4);
  const end = Math.min(events.length - 1, index + 4);
  for (let cursor = start; cursor <= end; cursor += 1) {
    if (cursor === index) {
      continue;
    }
    const event = events[cursor];
    if (event?.type === 'raw-output' || event?.type === 'status') {
      context.push(stripAnsiAndControl(event.text));
    }
  }
  return context.join('\n');
}

function userInputLooksLikeProviderCommandControl(text: string, events: SessionEventLine[], index: number): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/')) {
    return true;
  }
  if (!/^\d{1,8}$/.test(trimmed)) {
    return false;
  }

  const context = nearbyRawEventContext(events, index);
  return /(?:Select model|Switch between Claude models|Your pick becomes the default|For other\/previous model names|Enter to set as default|s to use this session only|Set\s*model\s*to|Set\s*mode\s*to|saved as your default for new sessions|Select Model and Effort|Effort not supported|Faster Smarter|lowmediumhighxhighmax|Enter to confirm\s*·\s*Esc to exit|Press enter to confirm or esc to go back)/i.test(context);
}

export async function readLiveMessages(session: BoundSession, options: ReadLiveMessagesOptions = {}): Promise<NormalizedMessage[]> {
  if (!session.eventLogPath) return [];
  try {
    const plan = await getEventLogReadPlan(session.eventLogPath, options);
    const { cacheKey } = plan;
    const cached = liveMessageCache.get(cacheKey);
    if (cached) {
      return cloneMessages(cached.messages);
    }
    const readResult = await readEventLogText(session.eventLogPath, plan);

    const events = readResult.text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const event = parseSessionEventLine(line);
      return event ? [event] : [];
    });

    const grouped: NormalizedMessage[] = [];
    let lastUserInput = readResult.lastUserInputBeforeText;
    let hasTrackedUserTurn = Boolean(readResult.lastUserInputBeforeText?.trim());
    const priorUserInputEchoes = readResult.lastUserInputBeforeText ? [readResult.lastUserInputBeforeText] : [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex]!;
      if (event.type === 'user-input') {
        const text = event.text.trim();
        if (!text) continue;
        if (userInputLooksLikeProviderCommandControl(text, events, eventIndex)) {
          continue;
        }
        if (shouldDropPreSubmitPromptEcho(grouped.at(-1), text, event.timestamp)) {
          grouped.pop();
        }
        lastUserInput = text;
        hasTrackedUserTurn = true;
        priorUserInputEchoes.push(text);
        grouped.push({
          id: stableTextHash(`${session.id}:${event.timestamp}:user:${text}`),
          provider: session.provider,
          role: 'user',
          lifecycle: 'durable',
          text,
          timestamp: event.timestamp,
          conversationRef: session.conversationRef,
          source: 'user-input',
        });
        continue;
      }

      if (event.type === 'raw-output' && !hasTrackedUserTurn) {
        continue;
      }

      const lines = event.type === 'status'
        ? [truncate(normalizeWhitespace(stripAnsiAndControl(event.text)), 240)].filter(Boolean)
        : normalizeRawOutputLines(event.text, lastUserInput, priorUserInputEchoes);

      for (const line of lines) {
        const dedupedLine = event.type === 'raw-output'
          ? removePreviouslySeenAssistantText(line, grouped)
          : line;
        if (!dedupedLine) {
          continue;
        }
        const role = event.type === 'status' ? 'status' : classifyChunk(dedupedLine);
        const text = role === 'status' ? truncate(dedupedLine, 240) : dedupedLine;
        const previous = grouped.at(-1);
        if (previous && previous.role === role && previous.source === 'live-output' && event.type === 'raw-output') {
          previous.text = role === 'status'
            ? text
            : `${previous.text}\n${text}`.trim();
          previous.timestamp = event.timestamp;
          continue;
        }
        grouped.push({
          id: stableTextHash(`${session.id}:${event.timestamp}:${role}:${text}`),
          provider: session.provider,
          role,
          lifecycle: role === 'status' ? 'status' : 'pending',
          text,
          timestamp: event.timestamp,
          conversationRef: session.conversationRef,
          source: event.type === 'status' ? 'synthetic-status' : 'live-output',
        });
      }
    }
    rememberLiveMessages(cacheKey, grouped);
    return cloneMessages(grouped);
  } catch {
    return [];
  }
}
