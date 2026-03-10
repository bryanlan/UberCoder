import type { ConversationSummary, NormalizedMessage, ProviderId } from '@agent-console/shared';

export interface TranscriptParseInput {
  filePath: string;
  provider: ProviderId;
  projectSlug: string;
  conversationRef: string;
}

export interface ParsedTranscript {
  summary: ConversationSummary;
  messages: NormalizedMessage[];
  displayMessages: NormalizedMessage[];
  projectPaths: Set<string>;
  authoritativeProjectPaths: Set<string>;
}
