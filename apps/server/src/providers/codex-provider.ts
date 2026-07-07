import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { renderTemplateTokens } from '../lib/shell.js';
import { normalizeWhitespace, stripAnsiAndControl } from '../lib/text.js';
import { listFilesRecursive, pathExists, readTextHead, readTextTail, statFileSafe, type FileFingerprint } from './file-utils.js';
import { compareConversationDiscoveryOrder, ensureProviderFlag } from './provider-utils.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation, TranscriptParseCache, TranscriptParseCacheEntry } from './types.js';
import {
  conversationBelongsToProject,
  deriveConversationRef,
  extractAuthoritativeProjectPathsFromJsonlText,
  loadCachedTranscriptParse,
  type CachedTranscriptParse,
} from './transcripts/base.js';
import { parseCodexConversationFile } from './transcripts/codex.js';

const PENDING_PREVIEW_MEMO_MAX_ENTRIES = 4096;

interface PendingPreviewMatchMemoEntry {
  size: number;
  mtimeMs: number;
  needle: string;
  matches: boolean;
}

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;

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

  private candidateSessionDayDirs(
    sessionsRoot: string,
    pending: ConversationSummary,
  ): string[] {
    const rawMetadata = pending.rawMetadata ?? {};
    const timestamps = [
      typeof rawMetadata.lastUserInputAt === 'string' ? rawMetadata.lastUserInputAt : undefined,
      pending.updatedAt,
      pending.createdAt,
    ].filter((value): value is string => typeof value === 'string');
    const dirs = new Set<string>();

    for (const timestamp of timestamps) {
      const parsed = Date.parse(timestamp);
      if (!Number.isFinite(parsed)) continue;
      for (const offsetDays of [-1, 0, 1]) {
        const candidate = new Date(parsed + offsetDays * 24 * 60 * 60 * 1000);
        dirs.add(path.join(
          sessionsRoot,
          String(candidate.getUTCFullYear()),
          String(candidate.getUTCMonth() + 1).padStart(2, '0'),
          String(candidate.getUTCDate()).padStart(2, '0'),
        ));
      }
    }

    return [...dirs].sort();
  }

  private async parseProjectConversationsFromFiles(
    project: ActiveProject,
    files: string[],
  ): Promise<ConversationSummary[]> {
    const conversations: ConversationSummary[] = [];
    for (const filePath of files) {
      const fingerprint = await statFileSafe(filePath);
      const parsed = await this.loadOrParseFile(filePath, fingerprint, project.slug);
      const projectPaths = parsed.authoritativeProjectPaths.size > 0 ? parsed.authoritativeProjectPaths : parsed.projectPaths;
      if (projectPaths.size === 0 || !conversationBelongsToProject(project.matchPaths, projectPaths)) {
        continue;
      }
      conversations.push({
        ...parsed.summary,
        projectSlug: project.slug,
        degraded: parsed.summary.degraded || parsed.authoritativeProjectPaths.size === 0,
      });
    }
    return conversations.sort(compareConversationDiscoveryOrder);
  }

  private pendingPreviewNeedle(pending: ConversationSummary): string | undefined {
    const preview = pending.rawMetadata?.lastUserInputPreview;
    if (typeof preview !== 'string') {
      return undefined;
    }

    const normalized = normalizeWhitespace(stripAnsiAndControl(preview.replace(/…$/u, ''))).toLowerCase();
    return normalized.length >= 20 ? normalized : undefined;
  }

  private readonly pendingPreviewMatchMemo = new Map<string, PendingPreviewMatchMemoEntry>();

  private async fileContainsPendingPreview(filePath: string, needle: string | undefined): Promise<boolean> {
    if (!needle) {
      return true;
    }

    const fingerprint = await statFileSafe(filePath);
    const memoized = fingerprint ? this.pendingPreviewMatchMemo.get(filePath) : undefined;
    if (
      memoized
      && memoized.size === fingerprint!.size
      && memoized.mtimeMs === fingerprint!.mtimeMs
      && memoized.needle === needle
    ) {
      return memoized.matches;
    }

    const haystack = normalizeWhitespace(stripAnsiAndControl([
      await readTextHead(filePath),
      await readTextTail(filePath),
    ].join('\n'))).toLowerCase();
    const matches = haystack.includes(needle);
    if (fingerprint) {
      // Keyed by path so a changed file replaces its own entry; evict the oldest
      // entries (insertion order) rather than clearing the whole memo.
      this.pendingPreviewMatchMemo.delete(filePath);
      this.pendingPreviewMatchMemo.set(filePath, { ...fingerprint, needle, matches });
      for (const oldestPath of this.pendingPreviewMatchMemo.keys()) {
        if (this.pendingPreviewMatchMemo.size <= PENDING_PREVIEW_MEMO_MAX_ENTRIES) {
          break;
        }
        this.pendingPreviewMatchMemo.delete(oldestPath);
      }
    }
    return matches;
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

  async listPendingAdoptionCandidates(
    project: ActiveProject,
    pending: ConversationSummary,
    settings: MergedProviderSettings,
  ): Promise<ConversationSummary[]> {
    const sessionsRoot = path.join(settings.discoveryRoot, 'sessions');
    if (!(await pathExists(sessionsRoot))) return [];

    const files = new Set<string>();
    for (const dayDir of this.candidateSessionDayDirs(sessionsRoot, pending)) {
      if (!(await pathExists(dayDir))) continue;
      for (const filePath of await listFilesRecursive(dayDir, (candidate) => candidate.endsWith('.jsonl'))) {
        files.add(filePath);
      }
    }

    const candidateFiles: string[] = [];
    const needle = this.pendingPreviewNeedle(pending);
    for (const filePath of [...files].sort()) {
      if (await this.fileContainsPendingPreview(filePath, needle)) {
        candidateFiles.push(filePath);
      }
    }

    return this.parseProjectConversationsFromFiles(project, candidateFiles);
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

  getLaunchCommand(
    project: ActiveProject,
    conversationRef: string | null,
    settings: MergedProviderSettings,
    options?: { initialPrompt?: string },
  ): LaunchCommand {
    const template = conversationRef ? settings.commands.resumeCommand : settings.commands.newCommand;
    const initialPrompt = options?.initialPrompt?.trim();
    const baseArgv = ensureProviderFlag(
      renderTemplateTokens(template, {
        conversationId: conversationRef ?? '',
        projectPath: project.path,
        projectSlug: project.slug,
      }),
      '--dangerously-bypass-approvals-and-sandbox',
    );
    return {
      cwd: project.path,
      argv: [
        ...baseArgv,
        ...(initialPrompt ? [initialPrompt] : []),
      ],
      env: settings.commands.env,
    };
  }
}
