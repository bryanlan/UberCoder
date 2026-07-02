import type { NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText, uniqueBy } from '../lib/text.js';
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

function toComparableMessage(message: NormalizedMessage): ComparableMessage | undefined {
  const comparable = normalizeComparableText(message.text);
  if (!comparable) {
    return undefined;
  }

  const timestampMs = Date.parse(message.timestamp);
  return {
    role: message.role,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
    comparable,
    compact: comparable.replace(/[^a-z0-9]+/g, ''),
  };
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

function filterTranscriptBackedLiveMessages(
  liveMessages: NormalizedMessage[],
  transcriptMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const transcriptIndex = buildTranscriptMessageIndex(transcriptMessages);
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
  mergedAllMessages: NormalizedMessage[];
  mergedMessages: NormalizedMessage[];
} {
  const providerHasTranscript = input.allMessages.some((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
  const mergedAllMessages = uniqueBy(
    [
      ...input.allMessages,
      ...(providerHasTranscript
        ? input.liveMessages.filter((message) => message.role === 'status')
        : input.liveMessages),
    ],
    (message) => `${message.source}:${message.timestamp}:${message.role}:${message.text.trim()}`,
  )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const liveMessagesNotInTranscript = filterTranscriptBackedLiveMessages(input.liveMessages, input.visibleMessages);
  const latestVisibleTranscriptMessage = latestMessageByTimestamp(input.visibleMessages);
  const mergedMessages = uniqueBy(
    [
      ...input.visibleMessages,
      ...(providerHasTranscript
        ? filterPendingLiveUserMessagesAfterTranscript(liveMessagesNotInTranscript, latestVisibleTranscriptMessage)
        : filterUserVisibleMessages(input.liveMessages)),
    ],
    (message) => `${message.source}:${message.timestamp}:${message.role}:${message.text.trim()}`,
  ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { mergedAllMessages, mergedMessages };
}
