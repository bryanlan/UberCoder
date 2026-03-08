import type { ConversationSummary, NormalizedMessage, ProviderId } from '@agent-console/shared';
import type { MergedProviderSettings } from '../config/service.js';
import type { ActiveProject } from '../projects/project-service.js';

export interface LaunchCommand {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
}

export interface ProviderConversation {
  summary: ConversationSummary;
  messages: NormalizedMessage[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  discoverLocalState(project: ActiveProject, settings: MergedProviderSettings): Promise<Record<string, unknown>>;
  listConversations(project: ActiveProject, settings: MergedProviderSettings): Promise<ConversationSummary[]>;
  getConversation(project: ActiveProject, conversationRef: string, settings: MergedProviderSettings): Promise<ProviderConversation | null>;
  getLaunchCommand(
    project: ActiveProject,
    conversationRef: string | null,
    settings: MergedProviderSettings,
    options?: { initialPrompt?: string },
  ): LaunchCommand;
}
