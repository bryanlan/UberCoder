import path from 'node:path';
import { CodexRunMonitor } from './transcripts/codex-run-state.js';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { listFilesRecursive, pathExists, readTextHead, statFileSafe, type FileFingerprint } from './file-utils.js';
import { compareConversationDiscoveryOrder } from './provider-utils.js';
import type { ProviderAdapter, ProviderConversation, TranscriptParseCache, TranscriptParseCacheEntry } from './types.js';
import {
  conversationBelongsToProject,
  deriveConversationRef,
  extractAuthoritativeProjectPathsFromJsonlText,
  loadCachedTranscriptParse,
  type CachedTranscriptParse,
} from './transcripts/base.js';
import { parseCodexConversationFile } from './transcripts/codex.js';

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;

  createRunMonitor(): CodexRunMonitor { return new CodexRunMonitor(); }

  constructor(private readonly parseCache?: TranscriptParseCache) {}

  private async loadOrParseFile(
    filePath: string,
    fingerprint: FileFingerprint | undefined,
    projectSlug: string,
    cached?: TranscriptParseCacheEntry,
  ): Promise<CachedTranscriptParse> {
    return loadCachedTranscriptParse({
      cache: this.parseCache,
      filePath,
      fingerprint,
      cached,
      parse: () => parseCodexConversationFile({
        filePath,
        provider: this.id,
        projectSlug,
        conversationRef: deriveConversationRef(filePath),
      }),
    });
  }

  async listConversationsForProjects(
    projects: ActiveProject[],
    settings: MergedProviderSettings,
  ): Promise<Map<string, ConversationSummary[]>> {
    const results = new Map(projects.map((project) => [project.slug, [] as ConversationSummary[]]));
    if (projects.length === 0) {
      return results;
    }

    const sessionsRoot = path.join(settings.discoveryRoot, 'sessions');
    if (!(await pathExists(sessionsRoot))) {
      return results;
    }

    const files = await listFilesRecursive(sessionsRoot, (candidate) => candidate.endsWith('.jsonl'));
    const fallbackProject = projects[0]!;

    for (const filePath of files) {
      const fingerprint = await statFileSafe(filePath);
      const cached = fingerprint
        ? this.parseCache?.get(filePath, fingerprint.size, fingerprint.mtimeMs)
        : undefined;

      // Authoritative paths gate whether the file is worth a full parse at all.
      // Cached rows may carry full-file paths (a superset of the head's), which
      // only widens this gate; final project assignment below always uses the
      // full parse's paths, so cold and warm passes assign identically.
      const knownAuthoritativePaths = cached
        ? new Set(cached.authoritativeProjectPaths)
        : extractAuthoritativeProjectPathsFromJsonlText(await readTextHead(filePath));
      const worthParsing = knownAuthoritativePaths.size === 0
        || projects.some((project) => conversationBelongsToProject(project.matchPaths, knownAuthoritativePaths));
      if (!worthParsing) {
        if (fingerprint && !cached) {
          this.parseCache?.put(filePath, fingerprint.size, fingerprint.mtimeMs, {
            scope: 'head',
            projectPaths: [],
            authoritativeProjectPaths: [...knownAuthoritativePaths],
          });
        }
        continue;
      }

      const parsed = await this.loadOrParseFile(filePath, fingerprint, fallbackProject.slug, cached);
      const projectPaths = parsed.authoritativeProjectPaths.size > 0 ? parsed.authoritativeProjectPaths : parsed.projectPaths;
      if (projectPaths.size === 0) {
        continue;
      }

      for (const project of projects) {
        if (!conversationBelongsToProject(project.matchPaths, projectPaths)) {
          continue;
        }
        results.get(project.slug)?.push({
          ...parsed.summary,
          projectSlug: project.slug,
          degraded: parsed.summary.degraded || parsed.authoritativeProjectPaths.size === 0,
        });
      }
    }

    this.parseCache?.retainUnderPrefix?.(sessionsRoot + path.sep, files);

    for (const [projectSlug, conversations] of results) {
      results.set(projectSlug, conversations.sort(compareConversationDiscoveryOrder));
    }

    return results;
  }

  async discoverLocalState(_project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    const codexHome = settings.discoveryRoot;
    const sessionsRoot = path.join(codexHome, 'sessions');
    const historyPath = path.join(codexHome, 'history.jsonl');
    return {
      codexHome,
      sessionsRoot,
      historyPath,
      sessionsRootExists: await pathExists(sessionsRoot),
      historyExists: await pathExists(historyPath),
    };
  }

  async listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]> {
    return (await this.listConversationsForProjects([project], settings)).get(project.slug) ?? [];
  }

  async getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null> {
    const sessionsRoot = path.join(settings.discoveryRoot, 'sessions');
    if (!(await pathExists(sessionsRoot))) return null;
    const files = await listFilesRecursive(sessionsRoot, (candidate) => candidate.endsWith('.jsonl') && candidate.includes(conversationRef));
    const filePath = files[0];
    if (!filePath) return null;
    const parsed = await parseCodexConversationFile({
      filePath,
      provider: this.id,
      projectSlug: project.slug,
      conversationRef,
    });
    return {
      summary: parsed.summary,
      messages: parsed.displayMessages,
      allMessages: parsed.messages,
    };
  }
}
