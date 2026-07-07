import type { NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText } from '../lib/text.js';
import { filterUserVisibleMessages } from '../providers/transcripts/base.js';

const LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const SHORT_EXACT_DUPLICATE_WINDOW_MS = 30 * 1000;
const CONTAINMENT_DUPLICATE_MIN_LENGTH = 80;

export function messagesShareTimelinePageRun(previous: NormalizedMessage, next: NormalizedMessage): boolean {
  return previous.role === next.role
    && (previous.role === 'assistant' || previous.role === 'user');
}

interface ComparableMessage {
  role: NormalizedMessage['role'];
  timestampMs?: number;
  comparable: string;
  compact: string;
}

interface TranscriptMessageIndex {
  bucketedByRole: Map<NormalizedMessage['role'], Map<number, ComparableMessage[]>>;
  untimedByRole: Map<NormalizedMessage['role'], ComparableMessage[]>;
}

function messageTimestampMs(message: NormalizedMessage): number | undefined {
  const timestampMs = Date.parse(message.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function toComparableMessage(message: NormalizedMessage): ComparableMessage | undefined {
  const comparable = normalizeComparableText(message.text);
  if (!comparable) {
    return undefined;
  }

  return {
    role: message.role,
    timestampMs: messageTimestampMs(message),
    comparable,
    compact: comparable.replace(/[^a-z0-9]+/g, ''),
  };
}

/**
 * Removes messages that share (source, timestamp, role) and trimmed text with an
 * earlier message, preserving order. Equivalent to keying on the full text, but
 * avoids building a large text-bearing key string per message.
 */
function dedupeTimelineMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const groups = new Map<string, NormalizedMessage[]>();
  const deduped: NormalizedMessage[] = [];
  for (const message of messages) {
    const key = `${message.source}:${message.timestamp}:${message.role}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, [message]);
      deduped.push(message);
      continue;
    }
    const text = message.text.trim();
    if (group.some((existing) => existing.text.trim() === text)) {
      continue;
    }
    group.push(message);
    deduped.push(message);
  }
  return deduped;
}

function timestampBucket(timestampMs: number): number {
  return Math.floor(timestampMs / LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS);
}

function appendComparableMessage(
  map: Map<NormalizedMessage['role'], ComparableMessage[]>,
  message: ComparableMessage,
): void {
  const existing = map.get(message.role);
  if (existing) {
    existing.push(message);
    return;
  }
  map.set(message.role, [message]);
}

function buildTranscriptMessageIndex(messages: NormalizedMessage[]): TranscriptMessageIndex {
  const bucketedByRole = new Map<NormalizedMessage['role'], Map<number, ComparableMessage[]>>();
  const untimedByRole = new Map<NormalizedMessage['role'], ComparableMessage[]>();

  for (const message of messages) {
    const comparable = toComparableMessage(message);
    if (!comparable) {
      continue;
    }

    if (comparable.timestampMs === undefined) {
      appendComparableMessage(untimedByRole, comparable);
      continue;
    }

    const bucket = timestampBucket(comparable.timestampMs);
    let roleBuckets = bucketedByRole.get(comparable.role);
    if (!roleBuckets) {
      roleBuckets = new Map<number, ComparableMessage[]>();
      bucketedByRole.set(comparable.role, roleBuckets);
    }
    const bucketMessages = roleBuckets.get(bucket);
    if (bucketMessages) {
      bucketMessages.push(comparable);
    } else {
      roleBuckets.set(bucket, [comparable]);
    }
  }

  return { bucketedByRole, untimedByRole };
}

function comparableTextsMatch(a: ComparableMessage, b: ComparableMessage): boolean {
  const minLength = Math.min(a.comparable.length, b.comparable.length);
  if (a.comparable === b.comparable) {
    if (minLength >= CONTAINMENT_DUPLICATE_MIN_LENGTH) {
      return true;
    }
    return a.timestampMs !== undefined
      && b.timestampMs !== undefined
      && Math.abs(a.timestampMs - b.timestampMs) <= SHORT_EXACT_DUPLICATE_WINDOW_MS;
  }

  if (minLength < CONTAINMENT_DUPLICATE_MIN_LENGTH) {
    return false;
  }

  return a.compact.includes(b.compact) || b.compact.includes(a.compact);
}

function comparableTimestampsAreNear(a: ComparableMessage, b: ComparableMessage): boolean {
  if (a.timestampMs === undefined || b.timestampMs === undefined) {
    return true;
  }

  return Math.abs(a.timestampMs - b.timestampMs) <= LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS;
}

function getTranscriptCandidates(
  index: TranscriptMessageIndex,
  liveMessage: ComparableMessage,
): ComparableMessage[] {
  const untimed = index.untimedByRole.get(liveMessage.role) ?? [];
  if (liveMessage.timestampMs === undefined) {
    return untimed;
  }

  const roleBuckets = index.bucketedByRole.get(liveMessage.role);
  if (!roleBuckets) {
    return untimed;
  }

  const bucket = timestampBucket(liveMessage.timestampMs);
  return [
    ...(roleBuckets.get(bucket - 1) ?? []),
    ...(roleBuckets.get(bucket) ?? []),
    ...(roleBuckets.get(bucket + 1) ?? []),
    ...untimed,
  ];
}

function liveMessageIsInTranscript(
  liveMessage: NormalizedMessage,
  index: TranscriptMessageIndex,
): boolean {
  const comparableLiveMessage = toComparableMessage(liveMessage);
  if (!comparableLiveMessage) {
    return false;
  }

  return getTranscriptCandidates(index, comparableLiveMessage)
    .some((transcriptMessage) => (
      comparableTimestampsAreNear(comparableLiveMessage, transcriptMessage)
      && comparableTextsMatch(comparableLiveMessage, transcriptMessage)
    ));
}

function earliestLiveTimestampMs(liveMessages: NormalizedMessage[]): number | undefined {
  let earliest: number | undefined;
  for (const message of liveMessages) {
    const timestampMs = messageTimestampMs(message);
    if (timestampMs === undefined) {
      continue;
    }
    if (earliest === undefined || timestampMs < earliest) {
      earliest = timestampMs;
    }
  }
  return earliest;
}

function filterTranscriptBackedLiveMessages(
  liveMessages: NormalizedMessage[],
  transcriptMessages: NormalizedMessage[],
): NormalizedMessage[] {
  // Live messages can only duplicate transcript content near their own time range,
  // so restrict the (normalization-heavy) transcript index to that window instead of
  // indexing the entire conversation on every request.
  const earliestLiveMs = earliestLiveTimestampMs(liveMessages);
  const relevantTranscriptMessages = earliestLiveMs === undefined
    ? transcriptMessages
    : transcriptMessages.filter((message) => {
      const timestampMs = messageTimestampMs(message);
      return timestampMs === undefined || timestampMs >= earliestLiveMs - LIVE_TRANSCRIPT_DUPLICATE_WINDOW_MS;
    });
  const transcriptIndex = buildTranscriptMessageIndex(relevantTranscriptMessages);
  return liveMessages.filter((liveMessage) => !liveMessageIsInTranscript(liveMessage, transcriptIndex));
}

function latestMessageByTimestamp(messages: NormalizedMessage[]): NormalizedMessage | undefined {
  let latest: NormalizedMessage | undefined;
  let latestMs: number | undefined;
  for (const message of messages) {
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    if (latestMs === undefined || timestampMs > latestMs) {
      latest = message;
      latestMs = timestampMs;
    }
  }
  return latest;
}

function isPendingAfterTranscript(message: NormalizedMessage, latestTranscriptMs: number | undefined): boolean {
  if (message.lifecycle === 'status') {
    return false;
  }
  if (latestTranscriptMs === undefined) {
    return true;
  }
  const timestampMs = Date.parse(message.timestamp);
  return Number.isFinite(timestampMs) && timestampMs > latestTranscriptMs;
}

function filterPendingLiveUserMessagesAfterTranscript(
  liveMessages: NormalizedMessage[],
  latestTranscriptMessage: NormalizedMessage | undefined,
): NormalizedMessage[] {
  const latestTranscriptMs = latestTranscriptMessage ? Date.parse(latestTranscriptMessage.timestamp) : undefined;
  return liveMessages.filter((message) => (
    message.role === 'user'
    && message.source === 'user-input'
    && isPendingAfterTranscript(message, latestTranscriptMs)
  ));
}

export function mergeTimelineMessages(input: {
  allMessages: NormalizedMessage[];
  visibleMessages: NormalizedMessage[];
  liveMessages: NormalizedMessage[];
}): {
  mergedMessages: NormalizedMessage[];
} {
  if (input.liveMessages.length === 0) {
    // Provider transcripts arrive pre-sorted (buildParsedTranscript sorts both
    // message lists), so with nothing to merge only the duplicate scrub applies.
    return {
      mergedMessages: dedupeTimelineMessages(input.visibleMessages),
    };
  }

  const providerHasTranscript = input.allMessages.some((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
  const liveMessagesNotInTranscript = filterTranscriptBackedLiveMessages(input.liveMessages, input.visibleMessages);
  const latestVisibleTranscriptMessage = latestMessageByTimestamp(input.visibleMessages);
  const mergedMessages = dedupeTimelineMessages([
    ...input.visibleMessages,
    ...(providerHasTranscript
      ? filterPendingLiveUserMessagesAfterTranscript(liveMessagesNotInTranscript, latestVisibleTranscriptMessage)
      : filterUserVisibleMessages(input.liveMessages)),
  ]).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { mergedMessages };
}
