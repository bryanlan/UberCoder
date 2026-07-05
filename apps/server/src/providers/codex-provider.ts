import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { renderTemplateTokens } from '../lib/shell.js';
import { normalizeWhitespace, stripAnsiAndControl } from '../lib/text.js';
import { listFilesRecursive, pathExists, readTextHead, readTextTail } from './file-utils.js';
import { compareConversationDiscoveryOrder, ensureProviderFlag } from './provider-utils.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation } from './types.js';
import { conversationBelongsToProject, deriveConversationRef, extractAuthoritativeProjectPathsFromJsonlText } from './transcripts/base.js';
import { parseCodexConversationFile } from './transcripts/codex.js';

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;

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
      const conversationRef = deriveConversationRef(filePath);
      const parsed = await parseCodexConversationFile({
        filePath,
        provider: this.id,
        projectSlug: project.slug,
        conversationRef,
      });
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

  private async fileContainsPendingPreview(filePath: string, needle: string | undefined): Promise<boolean> {
    if (!needle) {
      return true;
    }

    const haystack = normalizeWhitespace(stripAnsiAndControl([
      await readTextHead(filePath),
      await readTextTail(filePath),
    ].join('\n'))).toLowerCase();
    return haystack.includes(needle);
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
      const authoritativeProjectPaths = extractAuthoritativeProjectPathsFromJsonlText(await readTextHead(filePath));
      const candidateProjects = authoritativeProjectPaths.size > 0
        ? projects.filter((project) => conversationBelongsToProject(project.matchPaths, authoritativeProjectPaths))
        : projects;
      if (candidateProjects.length === 0) {
        continue;
      }

      const conversationRef = deriveConversationRef(filePath);
      const parsed = await parseCodexConversationFile({
        filePath,
        provider: this.id,
        projectSlug: candidateProjects[0]?.slug ?? fallbackProject.slug,
        conversationRef,
      });
      const projectPaths = parsed.authoritativeProjectPaths.size > 0 ? parsed.authoritativeProjectPaths : parsed.projectPaths;
      if (projectPaths.size === 0) {
        continue;
      }

      for (const project of candidateProjects) {
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
