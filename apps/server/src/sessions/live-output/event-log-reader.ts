import fs from 'node:fs/promises';

export interface SessionEventLine {
  type: 'user-input' | 'raw-output' | 'status';
  text: string;
  timestamp: string;
}

export interface SessionEventEntry {
  event: SessionEventLine;
  offset: number;
}

export interface ReadLiveMessagesOptions {
  maxBytesFromEnd?: number;
}

export interface EventLogReadPlan {
  cacheKey: string;
  size: number;
  maxBytes?: number;
}

export interface EventLogReadResult {
  text: string;
  startOffset: number;
  lastUserInputBeforeText?: string;
}

const MAX_EVENT_LOG_ROW_BACKTRACK_BYTES = 4 * 1024 * 1024;

export async function getEventLogReadPlan(
  filePath: string,
  options: ReadLiveMessagesOptions,
): Promise<EventLogReadPlan> {
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

export async function readEventLogText(
  filePath: string,
  plan: { size: number; maxBytes?: number },
): Promise<EventLogReadResult> {
  if (!plan.maxBytes || plan.size <= plan.maxBytes) {
    return { text: await fs.readFile(filePath, 'utf8'), startOffset: 0 };
  }

  const start = Math.max(0, plan.size - plan.maxBytes);
  const length = plan.size - start;
  const text = await readFileSlice(filePath, start, length);
  if (start === 0) {
    return { text, startOffset: 0 };
  }

  const firstNewline = text.indexOf('\n');
  if (firstNewline !== -1) {
    const rowStart = start + firstNewline + 1;
    const completeTail = text.slice(firstNewline + 1);
    if (completeTail.trim()) {
      return {
        text: completeTail,
        startOffset: rowStart,
        lastUserInputBeforeText: await findLastUserInputBefore(filePath, rowStart),
      };
    }
  }

  const rowStart = await findBoundedRowStart(filePath, start);
  if (rowStart === undefined) {
    return { text: '', startOffset: plan.size };
  }
  return {
    text: await readFileSlice(filePath, rowStart, plan.size - rowStart),
    startOffset: rowStart,
    lastUserInputBeforeText: await findLastUserInputBefore(filePath, rowStart),
  };
}

export function parseSessionEventEntries(readResult: EventLogReadResult): SessionEventEntry[] {
  const entries: SessionEventEntry[] = [];
  let cursor = 0;
  let byteOffset = readResult.startOffset;

  while (cursor < readResult.text.length) {
    const nextNewline = readResult.text.indexOf('\n', cursor);
    const segment = nextNewline === -1
      ? readResult.text.slice(cursor)
      : readResult.text.slice(cursor, nextNewline + 1);
    const rawLine = segment.endsWith('\n')
      ? segment.slice(0, -1).replace(/\r$/u, '')
      : segment.replace(/\r$/u, '');
    const event = rawLine.trim() ? parseSessionEventLine(rawLine) : undefined;
    if (event) {
      entries.push({ event, offset: byteOffset });
    }
    byteOffset += Buffer.byteLength(segment, 'utf8');
    if (nextNewline === -1) {
      break;
    }
    cursor = nextNewline + 1;
  }

  return entries;
}

function parseSessionEventLine(line: string): SessionEventLine | undefined {
  try {
    return JSON.parse(line) as SessionEventLine;
  } catch {
    return undefined;
  }
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
