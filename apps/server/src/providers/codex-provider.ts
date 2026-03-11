import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { renderTemplateTokens } from '../lib/shell.js';
import { listFilesRecursive, pathExists, readTextHead } from './file-utils.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation } from './types.js';
import { conversationBelongsToProject, deriveConversationRef, extractAuthoritativeProjectPathsFromJsonlText } from './transcripts/base.js';
import { parseCodexConversationFile } from './transcripts/codex.js';

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;

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
    const sessionsRoot = path.join(settings.discoveryRoot, 'sessions');
    if (!(await pathExists(sessionsRoot))) return [];
    const files = await listFilesRecursive(sessionsRoot, (candidate) => candidate.endsWith('.jsonl'));
    const conversations: ConversationSummary[] = [];
    for (const filePath of files) {
      const authoritativeProjectPaths = extractAuthoritativeProjectPathsFromJsonlText(await readTextHead(filePath));
      if (authoritativeProjectPaths.size > 0 && !conversationBelongsToProject(project.matchPaths, authoritativeProjectPaths)) {
        continue;
      }
      const conversationRef = deriveConversationRef(filePath);
      const parsed = await parseCodexConversationFile({
        filePath,
        provider: this.id,
        projectSlug: project.slug,
        conversationRef,
      });
      const projectPaths = parsed.authoritativeProjectPaths.size > 0 ? parsed.authoritativeProjectPaths : parsed.projectPaths;
      const belongs = conversationBelongsToProject(project.matchPaths, projectPaths);
      if (!belongs || projectPaths.size === 0) continue;
      conversations.push({
        ...parsed.summary,
        degraded: parsed.summary.degraded || parsed.authoritativeProjectPaths.size === 0,
      });
    }
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const initialPrompt = conversationRef ? undefined : options?.initialPrompt?.trim();
    return {
      cwd: project.path,
      argv: [
        ...renderTemplateTokens(template, {
          conversationId: conversationRef ?? '',
          projectPath: project.path,
          projectSlug: project.slug,
        }),
        ...(initialPrompt ? [initialPrompt] : []),
      ],
      env: settings.commands.env,
    };
  }
}
