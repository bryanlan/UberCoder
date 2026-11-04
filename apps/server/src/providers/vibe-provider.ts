import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { pathExists, statFileSafe } from './file-utils.js';
import { compareConversationDiscoveryOrder } from './provider-utils.js';
import type { ProviderAdapter, ProviderConversation, TranscriptParseCache } from './types.js';
import { conversationBelongsToProject, loadCachedTranscriptParse } from './transcripts/base.js';
import { parseVibeConversationFile } from './transcripts/vibe.js';
import { VibeStoreFormatError } from './vibe-store.js';

/** `<vibe home>/logs/session/unified`: one directory per session id. `VIBE_HOME` overrides `~/.vibe`. */
export function vibeSessionsRoot(vibeHome: string): string {
  return path.join(vibeHome, 'logs', 'session', 'unified');
}

export interface VibeProviderLog {
  warn(fields: object, message: string): void;
}

/**
 * Past Vibe conversations are read from Vibe's unified session store (no Vibe process is needed). The working directory
 * in `meta.json` decides the project. A store whose format this Console does not know is skipped and the reason is logged.
 * A live Vibe conversation is driven over ACP by its transport plugin.
 */
export class VibeProvider implements ProviderAdapter {
  readonly id = 'vibe' as const;

  constructor(private readonly parseCache?: TranscriptParseCache, private readonly log?: VibeProviderLog) {}

  async discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    return { vibeHome: settings.discoveryRoot, sessionsRoot: vibeSessionsRoot(settings.discoveryRoot), project: project.slug };
  }

  private async sessionFiles(settings: MergedProviderSettings): Promise<Map<string, string>> {
    const root = vibeSessionsRoot(settings.discoveryRoot);
    const files = new Map<string, string>();
    if (!(await pathExists(root))) return files;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pointer = path.join(root, entry.name, 'CURRENT');
      if (await pathExists(pointer)) files.set(entry.name, pointer);
    }
    return files;
  }

  private async summaryFor(project: ActiveProject, sessionId: string, filePath: string): Promise<ConversationSummary | undefined> {
    const fingerprint = await statFileSafe(filePath);
    if (!fingerprint) return undefined;
    try {
      const parsed = await loadCachedTranscriptParse({
        cache: this.parseCache,
        filePath,
        fingerprint,
        parse: () => parseVibeConversationFile({ filePath, provider: this.id, projectSlug: project.slug, conversationRef: sessionId }),
      });
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.matchPaths, parsed.projectPaths);
      if (!belongs) return undefined;
      return { ...parsed.summary, projectSlug: project.slug, degraded: parsed.summary.degraded || parsed.projectPaths.size === 0 };
    } catch (error) {
      this.warnSkipped(sessionId, error);
      return undefined;
    }
  }

  private warnSkipped(sessionId: string, error: unknown): void {
    const reason = error instanceof VibeStoreFormatError ? error.reason : 'The Vibe session store could not be read.';
    this.log?.warn({ sessionId, reason }, 'skipped a Vibe conversation whose store could not be read');
  }

  async listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]> {
    const files = await this.sessionFiles(settings);
    const summaries: ConversationSummary[] = [];
    for (const [sessionId, filePath] of files) {
      const summary = await this.summaryFor(project, sessionId, filePath);
      if (summary) summaries.push(summary);
    }
    return summaries.sort(compareConversationDiscoveryOrder);
  }

  async getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null> {
    const filePath = (await this.sessionFiles(settings)).get(conversationRef);
    if (!filePath) return null;
    try {
      const parsed = await parseVibeConversationFile({ filePath, provider: this.id, projectSlug: project.slug, conversationRef });
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.matchPaths, parsed.projectPaths);
      if (!belongs) return null;
      return {
        summary: { ...parsed.summary, projectSlug: project.slug, degraded: parsed.summary.degraded || parsed.projectPaths.size === 0 },
        messages: parsed.displayMessages,
        allMessages: parsed.messages,
      };
    } catch (error) {
      this.warnSkipped(conversationRef, error);
      return null;
    }
  }
}
