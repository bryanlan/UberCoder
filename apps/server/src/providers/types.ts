import type { ConversationSummary, NormalizedMessage, ProviderId } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';

export interface LaunchCommand {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
}

export interface ProviderConversation {
  summary: ConversationSummary;
  messages: NormalizedMessage[];
  allMessages?: NormalizedMessage[];
}

/**
 * Version stamp persisted with every transcript parse-cache row. Bump this
 * whenever parser output changes (summary fields, project-path extraction,
 * message filtering that affects titles/excerpts) so stale cached artifacts
 * from older parser code are re-derived instead of served forever.
 */
export const TRANSCRIPT_PARSER_VERSION = 1;

/**
 * Persisted per-file parse artifacts keyed by (path, size, mtimeMs, parser
 * version) so discovery refreshes can skip re-reading transcript files that
 * have not changed on disk. 'head' rows record only the project paths
 * extracted from the file head (enough to re-check project membership);
 * 'full' rows also carry the parsed summary. A cached summary's projectSlug
 * is whatever project triggered the parse — consumers must override it with
 * their own project before use.
 */
export interface TranscriptParseCacheEntry {
  scope: 'head' | 'full';
  summary?: ConversationSummary;
  projectPaths: string[];
  authoritativeProjectPaths: string[];
}

export interface TranscriptParseCache {
  get(path: string, size: number, mtimeMs: number): TranscriptParseCacheEntry | undefined;
  put(path: string, size: number, mtimeMs: number, entry: TranscriptParseCacheEntry): void;
  /** Drops rows under the directory prefix whose path is not in keepPaths. */
  retainUnderPrefix?(directoryPrefix: string, keepPaths: Iterable<string>): void;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>>;
  listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]>;
  listPendingAdoptionCandidates?(
    project: ActiveProject,
    pending: ConversationSummary,
    settings: MergedProviderSettings,
  ): Promise<ConversationSummary[]>;
  getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null>;
  getLaunchCommand(
    project: ActiveProject,
    conversationRef: string | null,
    settings: MergedProviderSettings,
    options?: { initialPrompt?: string },
  ): LaunchCommand;
}
