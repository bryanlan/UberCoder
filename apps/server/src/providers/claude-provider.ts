import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { renderTemplateTokens } from '../lib/shell.js';
import { toPosixPath } from '../lib/path-utils.js';
import { listFilesRecursive, pathExists } from './file-utils.js';
import { conversationBelongsToProject, deriveConversationRef, parseJsonlConversationFile } from './jsonl.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation } from './types.js';

function isTopLevelClaudeTranscript(filePath: string): boolean {
  return filePath.endsWith('.jsonl') && !filePath.split(path.sep).includes('subagents');
}

function encodeClaudeCandidates(projectPath: string): string[] {
  const posix = toPosixPath(projectPath);
  const encoded = posix.replace(/[^A-Za-z0-9]/g, '-');
  return Array.from(new Set([
    encoded,
    encoded.endsWith('-') ? encoded : `${encoded}-`,
    encoded.startsWith('-') ? encoded.slice(1) : encoded,
    encoded.startsWith('-') ? encoded : `-${encoded}`,
  ]));
}

async function readClaudeHistory(projectPath: string, claudeHome: string): Promise<string[]> {
  const historyPath = path.join(claudeHome, 'history.jsonl');
  if (!(await pathExists(historyPath))) return [];
  const lines = (await fs.readFile(historyPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const pathCandidate = typeof record.cwd === 'string' ? record.cwd : typeof record.project_path === 'string' ? record.project_path : undefined;
      const transcriptPath = typeof record.transcript_path === 'string' ? record.transcript_path : undefined;
      if (pathCandidate && path.resolve(pathCandidate) === path.resolve(projectPath) && transcriptPath && isTopLevelClaudeTranscript(transcriptPath)) {
        files.push(transcriptPath);
      }
    } catch {
      // ignore malformed history lines
    }
  }
  return files;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;

  async discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    const claudeHome = settings.discoveryRoot;
    const projectsRoot = path.join(claudeHome, 'projects');
    const candidates = encodeClaudeCandidates(project.path).map((candidate) => path.join(projectsRoot, candidate));
    return {
      claudeHome,
      projectsRoot,
      candidates,
      historyPath: path.join(claudeHome, 'history.jsonl'),
    };
  }

  private async resolveTranscriptFiles(project: ActiveProject, settings: MergedProviderSettings): Promise<string[]> {
    const claudeHome = settings.discoveryRoot;
    const projectsRoot = path.join(claudeHome, 'projects');
    const candidates = encodeClaudeCandidates(project.path);
    const files = new Set<string>();
    for (const candidate of candidates) {
      const candidatePath = path.join(projectsRoot, candidate);
      if (await pathExists(candidatePath)) {
        for (const filePath of await listFilesRecursive(candidatePath, isTopLevelClaudeTranscript)) {
          files.add(filePath);
        }
      }
    }
    for (const filePath of await readClaudeHistory(project.path, claudeHome)) {
      if (isTopLevelClaudeTranscript(filePath)) {
        files.add(filePath);
      }
    }
    return [...files].sort();
  }

  async listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]> {
    const files = await this.resolveTranscriptFiles(project, settings);
    const summaries: ConversationSummary[] = [];
    for (const filePath of files) {
      if (!(await pathExists(filePath))) continue;
      const conversationRef = deriveConversationRef(filePath);
      const parsed = await parseJsonlConversationFile({
        filePath,
        provider: this.id,
        projectSlug: project.slug,
        conversationRef,
      });
      const belongs = parsed.projectPaths.size === 0 || conversationBelongsToProject(project.path, parsed.projectPaths);
      if (!belongs) continue;
      summaries.push({
        ...parsed.summary,
        degraded: parsed.summary.degraded || parsed.projectPaths.size === 0,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null> {
    const files = await this.resolveTranscriptFiles(project, settings);
    const filePath = files.find((candidate) => candidate.includes(conversationRef));
    if (!filePath) return null;
    const parsed = await parseJsonlConversationFile({
      filePath,
      provider: this.id,
      projectSlug: project.slug,
      conversationRef,
    });
    return {
      summary: parsed.summary,
      messages: parsed.messages,
    };
  }

  getLaunchCommand(project: ActiveProject, conversationRef: string | null, settings: MergedProviderSettings): LaunchCommand {
    const template = conversationRef ? settings.commands.resumeCommand : settings.commands.newCommand;
    return {
      cwd: project.path,
      argv: renderTemplateTokens(template, {
        conversationId: conversationRef ?? '',
        projectPath: project.path,
        projectSlug: project.slug,
      }),
      env: settings.commands.env,
    };
  }
}
