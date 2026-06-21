import fs from 'node:fs/promises';
import type { BoundSession, MessageRole, NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText, normalizeWhitespace, stableTextHash, stripAnsiAndControl, truncate } from '../lib/text.js';

function classifyChunk(text: string): MessageRole {
  const trimmed = text.trim();
  if (!trimmed) return 'status';
  if (
    /^(thinking|running|tool|read|write|edit|apply|status|error|warning|diff|command|tip:|message; enter confirms|openai codex|claude code|model:|directory:|approval:|sandbox:|context window:|use medium effort|with medium effort|1 mcp server failed)/i.test(trimmed)
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
  if (/^[A-Za-z]{1,3}$/.test(line)) return true;
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4) {
    const shortTokenCount = tokens.filter((token) => /^[A-Za-z]{1,3}$/.test(token)).length;
    if (shortTokenCount / tokens.length >= 0.6) return true;
  }
  return false;
}

function looksLikeTerminalChrome(line: string): boolean {
  return /(?:^|\s)(?:OpenAI Codex|Claude Code|model:|directory:|approval:|sandbox:|context window:|Use medium effort|with medium effort|Use \/skills to list available|loading \/model to change)/i.test(line)
    || /^(?:We recommend .+ effort|Effort determines|recommend .+ effort for most tasks|and maximize rate limits|Use ultrathink)/i.test(line)
    || /^(?:\d+\.\s+Use .+ effort|gpt-[\w.]+ .+ left .+|Opus .+ Claude Max)$/i.test(line);
}

function looksLikeIdleHousekeeping(line: string): boolean {
  return /^(?:Checking for updates|How is Claude doing this session\? \(optional\)|Set model to .+)$/i.test(line)
    || /^(?:\d+\s*:\s*Bad\s+\d+\s*:\s*Fine\s+\d+\s*:\s*Good\s+\d+\s*:\s*Dismiss)$/i.test(line)
    || /^(?:Select model|Enter to confirm(?:\s*·\s*Esc to exit)?|Esc to exit)$/i.test(line);
}

function normalizeTerminalLine(text: string): string {
  return normalizeWhitespace(
    text
      .trimStart()
      .replace(/^(?:❯|›|>_?|▋|▌|▐)\s*/u, '')
      .replace(/[│╭╮╰╯─┌┐└┘├┤┬┴┼█▛▜▐▌▝▘]+/gu, ' ')
      .replace(/[•▪◦]+/gu, ' ')
      .replace(/\s+/g, ' '),
  );
}

export function normalizeRawOutputLines(text: string, lastUserInput?: string): string[] {
  const cleaned = stripAnsiAndControl(text);
  const candidateLines = cleaned
    .split(/\n+/)
    .map((rawLine) => normalizeTerminalLine(rawLine))
    .filter(Boolean);
  if (candidateLines.length >= 4 && candidateLines.every((line) => /^[A-Za-z]{1,4}$/.test(line))) {
    return [];
  }
  const comparableUserInput = lastUserInput ? normalizeComparableText(lastUserInput) : undefined;
  const compactUserInput = comparableUserInput?.replace(/\s+/g, '');
  const normalized: string[] = [];

  for (const line of candidateLines) {
    if (!line || looksLikeNoise(line) || looksLikeTerminalChrome(line) || looksLikeIdleHousekeeping(line)) continue;
    if (comparableUserInput) {
      const comparableLine = normalizeComparableText(line);
      const compactLine = comparableLine.replace(/\s+/g, '');
      if (
        comparableLine === comparableUserInput
        || comparableLine.includes(comparableUserInput)
        || (compactUserInput ? compactLine.includes(compactUserInput) : false)
      ) continue;
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
): Promise<string> {
  if (!plan.maxBytes || plan.size <= plan.maxBytes) {
    return fs.readFile(filePath, 'utf8');
  }

  const start = Math.max(0, plan.size - plan.maxBytes);
  const length = plan.size - start;
  const text = await readFileSlice(filePath, start, length);
  if (start === 0) {
    return text;
  }

  const firstNewline = text.indexOf('\n');
  if (firstNewline !== -1) {
    const completeTail = text.slice(firstNewline + 1);
    if (completeTail.trim()) {
      return completeTail;
    }
  }

  const rowStart = await findBoundedRowStart(filePath, start);
  return rowStart === undefined ? '' : readFileSlice(filePath, rowStart, plan.size - rowStart);
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

export async function readLiveMessages(session: BoundSession, options: ReadLiveMessagesOptions = {}): Promise<NormalizedMessage[]> {
  if (!session.eventLogPath) return [];
  try {
    const plan = await getEventLogReadPlan(session.eventLogPath, options);
    const { cacheKey } = plan;
    const cached = liveMessageCache.get(cacheKey);
    if (cached) {
      return cloneMessages(cached.messages);
    }
    const text = await readEventLogText(session.eventLogPath, plan);

    const events = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEventLine];
      } catch {
        return [];
      }
    });

    const grouped: NormalizedMessage[] = [];
    let lastUserInput: string | undefined;
    for (const event of events) {
      if (event.type === 'user-input') {
        const text = event.text.trim();
        if (!text) continue;
        lastUserInput = text;
        grouped.push({
          id: stableTextHash(`${session.id}:${event.timestamp}:user:${text}`),
          provider: session.provider,
          role: 'user',
          text,
          timestamp: event.timestamp,
          conversationRef: session.conversationRef,
          source: 'user-input',
        });
        continue;
      }

      const lines = event.type === 'status'
        ? [truncate(normalizeWhitespace(stripAnsiAndControl(event.text)), 240)].filter(Boolean)
        : normalizeRawOutputLines(event.text, lastUserInput);

      for (const line of lines) {
        const role = event.type === 'status' ? 'status' : classifyChunk(line);
        const text = role === 'status' ? truncate(line, 240) : line;
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
