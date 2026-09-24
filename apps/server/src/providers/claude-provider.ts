import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_COST_PROFILES, type ClaudeCostProfileKey, type ConversationSummary } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';
import { renderTemplateTokens } from '../lib/shell.js';
import { toPosixPath } from '../lib/path-utils.js';
import { listFilesRecursive, pathExists, statFileSafe } from './file-utils.js';
import { compareConversationDiscoveryOrder, ensureProviderFlag } from './provider-utils.js';
import type { LaunchCommand, ProviderAdapter, ProviderConversation, TranscriptParseCache } from './types.js';
import { conversationBelongsToProject, deriveConversationRef, loadCachedTranscriptParse } from './transcripts/base.js';
import { parseClaudeConversationFile } from './transcripts/claude.js';

function isTopLevelClaudeTranscript(filePath: string): boolean {
  return filePath.endsWith('.jsonl') && !filePath.split(path.sep).includes('subagents');
}

function hasConfiguredClaudeProfile(argv: string[]): boolean {
  return argv.some((arg) => arg === '--model' || arg.startsWith('--model=')
    || arg === '--effort' || arg.startsWith('--effort='));
}

function withoutConfiguredClaudeProfile(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--model' || arg === '--effort') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=') || arg.startsWith('--effort=')) continue;
    result.push(arg);
  }
  return result;
}

function encodeClaudeCandidates(projectPaths: string[]): string[] {
  return Array.from(new Set(projectPaths.flatMap((projectPath) => {
    const posix = toPosixPath(projectPath);
    const encoded = posix.replace(/[^A-Za-z0-9]/g, '-');
    return [
      encoded,
      encoded.endsWith('-') ? encoded : `${encoded}-`,
      encoded.startsWith('-') ? encoded.slice(1) : encoded,
      encoded.startsWith('-') ? encoded : `-${encoded}`,
    ];
  })));
}

export function getClaudeProjectTranscriptRoots(project: ActiveProject, claudeHome: string): string[] {
  const projectsRoot = path.join(claudeHome, 'projects');
  return encodeClaudeCandidates(project.matchPaths).map((candidate) => path.join(projectsRoot, candidate));
}

async function readClaudeHistory(projectPaths: string[], claudeHome: string): Promise<string[]> {
  const historyPath = path.join(claudeHome, 'history.jsonl');
  if (!(await pathExists(historyPath))) return [];
  const lines = (await fs.readFile(historyPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const pathCandidate = typeof record.cwd === 'string' ? record.cwd : typeof record.project_path === 'string' ? record.project_path : undefined;
      const transcriptPath = typeof record.transcript_path === 'string' ? record.transcript_path : undefined;
      if (
        pathCandidate
        && conversationBelongsToProject(projectPaths, new Set([path.resolve(pathCandidate)]))
        && transcriptPath
        && isTopLevelClaudeTranscript(transcriptPath)
      ) {
        files.push(transcriptPath);
      }
    } catch {
      continue;
    }
  }
  return files;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;

  constructor(private readonly parseCache?: TranscriptParseCache) {}

  async discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>> {
    const claudeHome = settings.discoveryRoot;
    const projectsRoot = path.join(claudeHome, 'projects');
    const candidates = getClaudeProjectTranscriptRoots(project, claudeHome);
    return {
      claudeHome,
      projectsRoot,
      candidates,
      historyPath: path.join(claudeHome, 'history.jsonl'),
    };
  }

  private async resolveTranscriptFiles(project: ActiveProject, settings: MergedProviderSettings): Promise<string[]> {
    const claudeHome = settings.discoveryRoot;
    const files = new Set<string>();
    for (const transcriptRoot of getClaudeProjectTranscriptRoots(project, claudeHome)) {
      if (await pathExists(transcriptRoot)) {
        for (const filePath of await listFilesRecursive(transcriptRoot, isTopLevelClaudeTranscript)) {
          files.add(filePath);
        }
      }
    }
    for (const filePath of await readClaudeHistory(project.matchPaths, claudeHome)) {
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
      const fingerprint = await statFileSafe(filePath);
      if (!fingerprint) continue;

      const parsed = await loadCachedTranscriptParse({
        cache: this.parseCache,
        filePath,
        fingerprint,
        parse: () => parseClaudeConversationFile({
          filePath,
          provider: this.id,
          projectSlug: project.slug,
          conversationRef: deriveConversationRef(filePath),
        }),
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
    const files = await this.resolveTranscriptFiles(project, settings);
    const filePath = files.find((candidate) => candidate.includes(conversationRef));
    if (!filePath) return null;
    const parsed = await parseClaudeConversationFile({
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
    options?: { initialPrompt?: string; claudeProfile?: ClaudeCostProfileKey },
  ): LaunchCommand {
    const template = conversationRef ? settings.commands.resumeCommand : settings.commands.newCommand;
    const initialPrompt = conversationRef ? undefined : options?.initialPrompt?.trim();
    let baseArgv = ensureProviderFlag(
      renderTemplateTokens(template, {
        conversationId: conversationRef ?? '',
        projectPath: project.path,
        projectSlug: project.slug,
      }),
      '--dangerously-skip-permissions',
    );
    const profileKey = options?.claudeProfile
      ?? (!conversationRef && !hasConfiguredClaudeProfile(baseArgv) ? 'medium' : undefined);
    if (profileKey) {
      const profile = CLAUDE_COST_PROFILES[profileKey];
      const withoutProfileArgs = withoutConfiguredClaudeProfile(baseArgv);
      const executable = withoutProfileArgs[0];
      if (!executable) throw new Error('Claude launch command is empty.');
      baseArgv = [
        executable, '--model', profile.model, '--effort', profile.reasoningEffort,
        ...withoutProfileArgs.slice(1),
      ];
    }
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
