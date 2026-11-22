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
import { isCodexExecInvocationConversation } from '../lib/conversation-visibility.js';

/** The session_meta fields of a Codex transcript's first line, which the head read always covers. */
function codexSessionMetaFromHead(head: string): Record<string, unknown> | undefined {
  const firstLine = head.split('\n', 1)[0];
  if (!firstLine) return undefined;
  try {
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: Record<string, unknown> };
    if (record.type !== 'session_meta' || !record.payload) return undefined;
    return {
      originator: record.payload.originator,
      source: record.payload.source,
      threadSource: record.payload.thread_source,
    };
  } catch {
    return undefined;
  }
}

function isAutomatedCodexThread(metadata: Record<string, unknown> | undefined): boolean {
  return isCodexExecInvocationConversation({ provider: 'codex', rawMetadata: metadata })
    || metadata?.threadSource === 'subagent';
}

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;

  createRunMonitor(): CodexRunMonitor { return new CodexRunMonitor(); }

  /** Exec and subagent transcripts the per-file index already skipped, by path, with their size and mtime. */
  private readonly automatedThreadFiles = new Map<string, string>();

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
      for (const summary of await this.summarizeFile(filePath, projects, fallbackProject.slug, false)) {
        results.get(summary.projectSlug)?.push(summary);
      }
    }

    this.parseCache?.retainUnderPrefix?.(sessionsRoot + path.sep, files);

    for (const [projectSlug, conversations] of results) {
      results.set(projectSlug, conversations.sort(compareConversationDiscoveryOrder));
    }

    return results;
  }

  /**
   * One transcript's summary for each project it belongs to, for the automatic per-file index.
   * Exec runs and subagent threads return none: nobody opens them as chats, and the
   * exec runs alone are most of the history on disk. A manual refresh still lists them.
   */
  async summarizeFileForProjects(filePath: string, projects: ActiveProject[]): Promise<ConversationSummary[]> {
    if (projects.length === 0) return [];
    return this.summarizeFile(filePath, projects, projects[0]!.slug, true);
  }

  private async summarizeFile(
    filePath: string,
    projects: ActiveProject[],
    fallbackProjectSlug: string,
    skipAutomatedThreads: boolean,
  ): Promise<ConversationSummary[]> {
    const fingerprint = await statFileSafe(filePath);
    const fingerprintKey = fingerprint ? `${fingerprint.size}:${fingerprint.mtimeMs}` : undefined;
    if (skipAutomatedThreads && fingerprintKey && this.automatedThreadFiles.get(filePath) === fingerprintKey) {
      return [];
    }
    const cached = fingerprint
      ? this.parseCache?.get(filePath, fingerprint.size, fingerprint.mtimeMs)
      : undefined;

    // Authoritative paths gate whether the file is worth a full parse at all.
    // Cached rows may carry full-file paths (a superset of the head's), which
    // only widens this gate; final project assignment below always uses the
    // full parse's paths, so cold and warm passes assign identically.
    let head: string | undefined;
    const knownAuthoritativePaths = cached
      ? new Set(cached.authoritativeProjectPaths)
      : extractAuthoritativeProjectPathsFromJsonlText(head = await readTextHead(filePath));
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
      return [];
    }

    if (skipAutomatedThreads) {
      const metadata = cached?.scope === 'full' && cached.summary
        ? cached.summary.rawMetadata
        : codexSessionMetaFromHead(head ?? await readTextHead(filePath));
      if (isAutomatedCodexThread(metadata)) {
        if (fingerprintKey) this.automatedThreadFiles.set(filePath, fingerprintKey);
        return [];
      }
    }

    const parsed = await this.loadOrParseFile(filePath, fingerprint, fallbackProjectSlug, cached);
    const projectPaths = parsed.authoritativeProjectPaths.size > 0 ? parsed.authoritativeProjectPaths : parsed.projectPaths;
    if (projectPaths.size === 0) {
      return [];
    }
    return projects
      .filter((project) => conversationBelongsToProject(project.matchPaths, projectPaths))
      .map((project) => ({
        ...parsed.summary,
        projectSlug: project.slug,
        degraded: parsed.summary.degraded || parsed.authoritativeProjectPaths.size === 0,
      }));
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
