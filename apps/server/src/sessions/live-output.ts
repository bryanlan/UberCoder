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

function normalizeRawOutputLines(text: string, lastUserInput?: string): string[] {
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
    if (!line || looksLikeNoise(line) || looksLikeTerminalChrome(line)) continue;
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

export async function readLiveMessages(session: BoundSession): Promise<NormalizedMessage[]> {
  if (!session.eventLogPath) return [];
  try {
    const text = await fs.readFile(session.eventLogPath, 'utf8');
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
    return grouped;
  } catch {
    return [];
  }
}
