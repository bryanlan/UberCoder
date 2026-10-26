import type { PendingRequestSummary, ProviderId } from '@agent-console/shared';

// Requests a structured provider is waiting on (a question for the person). The service owns the list and writes
// it to the meta table under `structuredRequestsKey`; the bound-sessions repository projects it onto the row as
// `pendingRequests`. A stale key from an earlier backend process is deleted at boot, because the provider
// connection that raised the request is gone with that process.

export const STRUCTURED_REQUESTS_KEY_PREFIX = 'structured-requests:';

export function structuredRequestsKey(sessionId: string): string {
  return `${STRUCTURED_REQUESTS_KEY_PREFIX}${sessionId}`;
}

function isSummary(value: unknown): value is PendingRequestSummary {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.requestId === 'string' && typeof row.kind === 'string' && typeof row.summary === 'string'
    && typeof row.openedAt === 'string' && Array.isArray(row.questions);
}

/** Reads the stored JSON array; anything unreadable counts as no pending requests. */
export function parsePendingRequests(raw: string | undefined | null): PendingRequestSummary[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSummary) : [];
  } catch {
    return [];
  }
}

/** What the browser notification for a new question needs. The question text itself is the summary. */
export interface StructuredQuestionNotice {
  sessionId: string;
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  requestId: string;
  summary: string;
}
