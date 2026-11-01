import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { pathExists, statFileSafe } from './file-utils.js';
import { compareConversationDiscoveryOrder } from './provider-utils.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation, TranscriptParseCache } from './types.js';
import { conversationBelongsToProject, loadCachedTranscriptParse } from './transcripts/base.js';
import { parseGrokConversationFile } from './transcripts/grok.js';

/** `<grok home>/sessions`: Grok groups conversations by working directory, one folder per URL-encoded directory. */
export function grokSessionsRoot(grokHome: string): string {
  return path.join(grokHome, 'sessions');
}

/** The folders Grok would use for a project: one per path the project answers to. */
export function getGrokProjectGroups(project: ActiveProject, grokHome: string): string[] {
  const root = grokSessionsRoot(grokHome);
  return [...new Set(project.matchPaths.map(projectPath => path.join(root, encodeURIComponent(projectPath))))];
}

/**
 * Past Grok conversations are read from Grok's own session folders (no Grok process is needed): the working directory in
 * `summary.json` decides the project, `updates.jsonl` is the transcript. Grok has no terminal transport here, so
 * `getLaunchCommand` refuses: a Grok conversation is only ever driven over ACP (docs/structured-providers.md, "Grok plugin").
 */
export class GrokProvider implements ProviderAdapter {
  readonly id = 'grok' as const;

  constructor(private readonly parseCache?: TranscriptParseCache) {}

  async discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    return {
      grokHome: settings.discoveryRoot,
      sessionsRoot: grokSessionsRoot(settings.discoveryRoot),
      candidates: getGrokProjectGroups(project, settings.discoveryRoot),
    };
  }

  /** The `updates.jsonl` of every conversation saved for the project, by session id. */
  private async resolveTranscriptFiles(project: ActiveProject, settings: MergedProviderSettings): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const group of getGrokProjectGroups(project, settings.discoveryRoot)) {
      if (!(await pathExists(group))) continue;
      let entries;
      try {
        entries = await fs.readdir(group, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcript = path.join(group, entry.name, 'updates.jsonl');
        if (await pathExists(transcript)) files.set(entry.name, transcript);
      }
    }
    return files;
  }

  async listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]> {
    const files = await this.resolveTranscriptFiles(project, settings);
    const summaries: ConversationSummary[] = [];
    for (const [sessionId, filePath] of files) {
      const fingerprint = await statFileSafe(filePath);
      if (!fingerprint) continue;
      const parsed = await loadCachedTranscriptParse({
        cache: this.parseCache,
        filePath,
        fingerprint,
        parse: () => parseGrokConversationFile({ filePath, provider: this.id, projectSlug: project.slug, conversationRef: sessionId }),
      });
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.matchPaths, parsed.projectPaths);
      if (!belongs) continue;
      summaries.push({
        ...parsed.summary,
        projectSlug: project.slug,
        degraded: parsed.summary.degraded || parsed.projectPaths.size === 0,
      });
    }
    return summaries.sort(compareConversationDiscoveryOrder);
  }

  async getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null> {
    const filePath = (await this.resolveTranscriptFiles(project, settings)).get(conversationRef);
    if (!filePath) return null;
    const parsed = await parseGrokConversationFile({ filePath, provider: this.id, projectSlug: project.slug, conversationRef });
    return { summary: parsed.summary, messages: parsed.displayMessages, allMessages: parsed.messages };
  }

  getLaunchCommand(): LaunchCommand {
    throw new Error('Grok runs on the structured transport only; it has no terminal launch command.');
  }
}
