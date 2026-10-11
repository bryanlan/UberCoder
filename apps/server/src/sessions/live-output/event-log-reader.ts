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
  identity: string;
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
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    maxBytes ?? 'all',
  ].join(':');
  return { cacheKey, identity: `${stat.dev}:${stat.ino}`, size: stat.size, maxBytes };
}

export async function readEventLogText(
  filePath: string,
  plan: { size: number; maxBytes?: number },
): Promise<EventLogReadResult> {
  if (!plan.maxBytes || plan.size <= plan.maxBytes) {
    return { text: (await readFileBytes(filePath, 0, plan.size)).toString('utf8'), startOffset: 0 };
  }

  const start = Math.max(0, plan.size - plan.maxBytes);
  const length = plan.size - start;
  const bytes = await readFileBytes(filePath, start, length);
  if (start === 0) {
    return { text: bytes.toString('utf8'), startOffset: 0 };
  }

  const firstNewline = bytes.indexOf(10);
  if (firstNewline !== -1) {
    const rowStart = start + firstNewline + 1;
    const completeTail = bytes.subarray(firstNewline + 1).toString('utf8');
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
    text: (await readFileBytes(filePath, rowStart, plan.size - rowStart)).toString('utf8'),
    startOffset: rowStart,
    lastUserInputBeforeText: await findLastUserInputBefore(filePath, rowStart),
  };
}

export async function parseSessionEventEntries(readResult: EventLogReadResult): Promise<SessionEventEntry[]> {
  const entries: SessionEventEntry[] = [];
  let cursor = 0;
  let byteOffset = readResult.startOffset;
  let yieldedAt = performance.now();

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
    if (performance.now() - yieldedAt >= 8) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      yieldedAt = performance.now();
    }
  }

  return entries;
}

/** Reuse an append-only tail, verifying file identity and the old EOF anchor.
 * A changed/truncated file or a partial last record is reconstructed normally. */
export async function readAppendedEventLogText(
  filePath: string,
  plan: EventLogReadPlan,
  previous?: { plan: EventLogReadPlan; read: EventLogReadResult },
): Promise<EventLogReadResult> {
  if (!previous || previous.plan.identity !== plan.identity
    || plan.size <= previous.plan.size || !previous.read.text.endsWith('\n')
    || plan.size - previous.plan.size > (plan.maxBytes ?? 2 * 1024 * 1024)) {
    return readEventLogText(filePath, plan);
  }
  const old = Buffer.from(previous.read.text, 'utf8');
  if (previous.read.startOffset + old.length !== previous.plan.size) return readEventLogText(filePath, plan);
  const anchorSize = Math.min(256, old.length);
  const anchor = await readFileBytes(filePath, previous.plan.size - anchorSize, anchorSize);
  if (!anchor.equals(old.subarray(old.length - anchorSize))) return readEventLogText(filePath, plan);
  const appended = await readFileBytes(filePath, previous.plan.size, plan.size - previous.plan.size);
  const combined = Buffer.concat([old, appended]);
  const cutoff = plan.maxBytes && plan.size > plan.maxBytes ? plan.size - plan.maxBytes : 0;
  if (cutoff < previous.read.startOffset) return readEventLogText(filePath, plan);
  if (cutoff === 0) return { text: combined.toString('utf8'), startOffset: 0 };
  const newline = combined.indexOf(10, cutoff - previous.read.startOffset);
  if (newline < 0 || !combined.subarray(newline + 1).toString('utf8').trim()) return readEventLogText(filePath, plan);
  const startOffset = previous.read.startOffset + newline + 1;
  return {
    text: combined.subarray(newline + 1).toString('utf8'),
    startOffset,
    lastUserInputBeforeText: startOffset === previous.read.startOffset
      ? previous.read.lastUserInputBeforeText : await findLastUserInputBefore(filePath, startOffset),
  };
}

function parseSessionEventLine(line: string): SessionEventLine | undefined {
  try {
    return JSON.parse(line) as SessionEventLine;
  } catch {
    return undefined;
  }
}

async function readFileBytes(filePath: string, start: number, length: number): Promise<Buffer> {
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
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function findBoundedRowStart(filePath: string, offset: number): Promise<number | undefined> {
  const backtrackStart = Math.max(0, offset - MAX_EVENT_LOG_ROW_BACKTRACK_BYTES);
  const prefix = await readFileBytes(filePath, backtrackStart, offset - backtrackStart);
  const previousNewline = prefix.lastIndexOf(10);
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
  const prefix = (await readFileBytes(filePath, backtrackStart, offset - backtrackStart)).toString('utf8');
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
