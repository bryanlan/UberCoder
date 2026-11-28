import fs from 'node:fs/promises';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { pathExists, statFileSafe } from './file-utils.js';
import { compareConversationDiscoveryOrder } from './provider-utils.js';
import type { ProviderAdapter, ProviderConversation, TranscriptParseCache } from './types.js';
import { conversationBelongsToProject, loadCachedTranscriptParse } from './transcripts/base.js';
import { parseAntigravityConversationFile } from './transcripts/antigravity.js';
import {
  antigravityBrainRoot,
  antigravityTranscriptPath,
  AntigravityStoreFormatError,
  readAntigravityMetadataMap,
  type AntigravityConversationMeta,
} from './antigravity-store.js';

export interface AntigravityProviderLog {
  warn(fields: object, message: string): void;
}

/**
 * Past Antigravity conversations are read from `~/.gemini/antigravity-cli` (no `agy` process is needed).
 * Workspace URIs in `cache/conversation_metadata.json` decide which project owns each conversation;
 * messages come from `brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
 */
export class AntigravityProvider implements ProviderAdapter {
  readonly id = 'antigravity' as const;

  constructor(private readonly parseCache?: TranscriptParseCache, private readonly log?: AntigravityProviderLog) {}

  async discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    return {
      antigravityHome: settings.discoveryRoot,
      brainRoot: antigravityBrainRoot(settings.discoveryRoot),
      project: project.slug,
    };
  }

  private async sessionFiles(settings: MergedProviderSettings): Promise<Map<string, string>> {
    const brainRoot = antigravityBrainRoot(settings.discoveryRoot);
    const files = new Map<string, string>();
    if (!(await pathExists(brainRoot))) return files;
    let entries;
    try {
      entries = await fs.readdir(brainRoot, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const transcript = antigravityTranscriptPath(settings.discoveryRoot, entry.name);
      if (await pathExists(transcript)) files.set(entry.name, transcript);
    }
    return files;
  }

  private async summaryFor(
    project: ActiveProject,
    sessionId: string,
    filePath: string,
    meta: AntigravityConversationMeta | undefined,
  ): Promise<ConversationSummary | undefined> {
    if (meta?.isInternal) return undefined;
    const fingerprint = await statFileSafe(filePath);
    if (!fingerprint) return undefined;
    try {
      const parsed = await loadCachedTranscriptParse({
        cache: this.parseCache,
        filePath,
        fingerprint,
        parse: () => parseAntigravityConversationFile(
          { filePath, provider: this.id, projectSlug: project.slug, conversationRef: sessionId },
          meta,
        ),
      });
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.matchPaths, parsed.projectPaths);
      if (!belongs) return undefined;
      return {
        ...parsed.summary,
        projectSlug: project.slug,
        degraded: parsed.summary.degraded || parsed.projectPaths.size === 0,
      };
    } catch (error) {
      this.warnSkipped(sessionId, error);
      return undefined;
    }
  }

  private warnSkipped(sessionId: string, error: unknown): void {
    const reason = error instanceof AntigravityStoreFormatError
      ? error.reason
      : 'The Antigravity conversation transcript could not be read.';
    this.log?.warn({ sessionId, reason }, 'skipped an Antigravity conversation whose store could not be read');
  }

  async listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]> {
    const files = await this.sessionFiles(settings);
    const metadataMap = readAntigravityMetadataMap(settings.discoveryRoot);
    const summaries: ConversationSummary[] = [];
    for (const [sessionId, filePath] of files) {
      const summary = await this.summaryFor(project, sessionId, filePath, metadataMap.get(sessionId));
      if (summary) summaries.push(summary);
    }
    return summaries.sort(compareConversationDiscoveryOrder);
  }

  async getConversation(
    project: ActiveProject,
    conversationRef: string,
    settings: MergedProviderSettings,
  ): Promise<ProviderConversation | null> {
    const filePath = (await this.sessionFiles(settings)).get(conversationRef);
    if (!filePath) return null;
    const meta = readAntigravityMetadataMap(settings.discoveryRoot).get(conversationRef);
    if (meta?.isInternal) return null;
    try {
      const parsed = await parseAntigravityConversationFile(
        { filePath, provider: this.id, projectSlug: project.slug, conversationRef },
        meta,
      );
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.matchPaths, parsed.projectPaths);
      if (!belongs) return null;
      return {
        summary: {
          ...parsed.summary,
          projectSlug: project.slug,
          degraded: parsed.summary.degraded || parsed.projectPaths.size === 0,
        },
        messages: parsed.displayMessages,
        allMessages: parsed.messages,
      };
    } catch (error) {
      this.warnSkipped(conversationRef, error);
      return null;
    }
  }
}
