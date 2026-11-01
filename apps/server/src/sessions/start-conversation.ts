import { randomUUID } from 'node:crypto';
import {
  PROVIDER_NAMES,
  type AutoDecision,
  type BoundSession,
  type ConversationSummary,
  type FixedModelProfileKey,
  type ModelProfileKey,
  type ProviderId,
  type StartConversationResponse,
} from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { nowIso } from '../lib/time.js';
import { ModelProfilesUnavailableError, fallbackDecision, type ModelProfileService } from '../model-profiles/service.js';
import type { ProjectService, ActiveProject } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { TITLE_GENERATION_AWAITING_MESSAGE } from '../titles/service.js';
import { profilePatch, type SessionManager } from './session-manager.js';

/** The provider and profile a provider-neutral Start falls back to when the router cannot answer (`modelRouting.startDefault`). */
export interface StartDefault {
  provider: ProviderId;
  profile: FixedModelProfileKey;
}

export interface StartConversationDeps {
  db: AppDatabase;
  projectService: ProjectService;
  providerRegistry: ProviderRegistry;
  sessions: SessionManager;
  modelProfiles: ModelProfileService;
  startDefault: StartDefault;
}

/** Start could not create a chat on any provider (none is enabled for the project). */
export class StartUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartUnavailableError';
  }
}

const PROFILE_WORDS: Record<FixedModelProfileKey, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function shortReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/**
 * The provider-neutral Start: the person gives a project and a first prompt and the server picks the provider. It asks the
 * router (no vendor named, so any vendor can win) for a provider, model and effort, creates the structured chat on that provider
 * with the choice recorded as an Auto decision, and sends the prompt as the first turn. The router answers within its timeout; when
 * it cannot, the chat is created on the configured default and the person is told, so the prompt is never lost.
 */
export async function startConversation(deps: StartConversationDeps, input: { project: ActiveProject; prompt: string }): Promise<StartConversationResponse> {
  const { project, prompt } = input;
  // A chat can start on a provider whose structured lane is on and which the project has not switched off.
  const startable = deps.sessions.enabledStructuredProviders()
    .filter(provider => deps.projectService.getMergedProviderSettings(project, provider).enabled);
  if (startable.length === 0) throw new StartUnavailableError('No provider can start a chat in this project: no structured session lane is enabled for it.');

  const outcome = await deps.modelProfiles.route(undefined, prompt, { acceptProvider: provider => startable.includes(provider) });

  let provider: ProviderId;
  let profile: ModelProfileKey;
  let decision: AutoDecision | undefined;
  let notice: string | undefined;
  if (outcome.ok) {
    provider = outcome.provider;
    profile = 'auto';
    decision = outcome.decision;
  } else {
    provider = startable.includes(deps.startDefault.provider) ? deps.startDefault.provider : startable[0]!;
    const named = `${PROVIDER_NAMES[provider]} ${PROFILE_WORDS[deps.startDefault.profile]}`;
    const why = shortReason(outcome.reason);
    try {
      await deps.modelProfiles.entry(provider, deps.startDefault.profile);
      profile = deps.startDefault.profile;
      notice = `Auto could not pick a provider (${why}). Started on ${named}.`;
    } catch (error) {
      if (!(error instanceof ModelProfilesUnavailableError)) throw error;
      // Even the default's model cannot be looked up: start on Auto with no model chosen, so the provider runs its own default.
      profile = 'auto';
      decision = fallbackDecision(`${why}. ${error.message}`, undefined);
      notice = `Auto could not pick a provider (${why}). Started on ${PROVIDER_NAMES[provider]} with its own default model.`;
    }
  }

  const providerSettings = deps.projectService.getMergedProviderSettings(project, provider);
  const pendingRef = `pending:${randomUUID()}`;
  const title = `New ${PROVIDER_NAMES[provider]} conversation`;
  const pendingConversation: ConversationSummary = {
    ref: pendingRef,
    kind: 'pending',
    projectSlug: project.slug,
    provider,
    title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    isBound: false,
    degraded: false,
    // A generated title replaces the placeholder after the first human message.
    rawMetadata: { pending: true, titleGeneration: TITLE_GENERATION_AWAITING_MESSAGE },
  };
  // The thread id is known at bind time, so the session manager adopts this alias immediately.
  deps.db.pendingConversations.put(pendingConversation);
  try {
    const session: BoundSession = await deps.sessions.bindConversation({
      project,
      provider: deps.providerRegistry.get(provider),
      providerSettings,
      conversationRef: pendingRef,
      title,
      kind: 'pending',
      transport: 'structured',
      initialPrompt: prompt,
      ...profilePatch(provider, profile),
      ...(decision ? { autoDecision: decision } : {}),
      ...(notice ? { startNotice: notice } : {}),
    });
    // An adopted alias already points at the native conversation; do not overwrite that record.
    if (typeof deps.db.pendingConversations.get(pendingRef)?.rawMetadata?.adoptedConversationRef !== 'string') {
      deps.db.pendingConversations.put({ ...pendingConversation, boundSessionId: session.id, isBound: true });
    }
    return { session, conversationRef: pendingRef, provider, ...(notice ? { warning: notice } : {}) };
  } catch (error) {
    deps.db.pendingConversations.delete(pendingRef);
    throw error;
  }
}
