import { randomUUID } from 'node:crypto';
import {
  MODEL_PROFILE_NAMES,
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

function shortReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/** Where a Start lands: the provider, the profile it starts on, and what the person is told. */
interface StartChoice {
  provider: ProviderId;
  profile: ModelProfileKey;
  decision?: AutoDecision;
  /** A status line in the new chat. */
  status?: string;
  /** Shown above the chat as well as in it: the start did not go the way the person asked. */
  warning?: string;
}

/**
 * The provider-neutral Start: the person gives a project and a first prompt and the server picks the provider. Without a level it
 * asks the router (no vendor named, so any vendor can win) for a provider, model and effort, creates the structured chat on that
 * provider with the choice recorded as an Auto decision, and sends the prompt as the first turn. With a level it asks the router
 * for the model with the most quota room at that level and starts the chat on that level's profile. The router answers within its
 * timeout; when it cannot, the chat is created on a default and the person is told, so the prompt is never lost.
 */
export async function startConversation(
  deps: StartConversationDeps,
  input: { project: ActiveProject; prompt: string; level?: FixedModelProfileKey },
): Promise<StartConversationResponse> {
  const { project, prompt, level } = input;
  // A chat can start on a provider whose structured lane is on and which the project has not switched off.
  const startable = deps.sessions.enabledStructuredProviders()
    .filter(provider => deps.projectService.getMergedProviderSettings(project, provider).enabled);
  if (startable.length === 0) throw new StartUnavailableError('No provider can start a chat in this project: no structured session lane is enabled for it.');

  const { provider, profile, decision, status, warning } = level
    ? await chooseByLevel(deps, startable, level)
    : await chooseByRouter(deps, startable, prompt);

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
      conversationRef: pendingRef,
      title,
      kind: 'pending',
      initialPrompt: prompt,
      ...profilePatch(provider, profile),
      ...(decision ? { autoDecision: decision } : {}),
      ...((warning ?? status) ? { startNotice: warning ?? status } : {}),
    });
    // An adopted alias already points at the native conversation; do not overwrite that record.
    if (typeof deps.db.pendingConversations.get(pendingRef)?.rawMetadata?.adoptedConversationRef !== 'string') {
      deps.db.pendingConversations.put({ ...pendingConversation, boundSessionId: session.id, isBound: true });
    }
    return { session, conversationRef: pendingRef, provider, ...(warning ? { warning } : {}) };
  } catch (error) {
    deps.db.pendingConversations.delete(pendingRef);
    throw error;
  }
}

/** Start on Auto: the router reads the prompt (and any level or thinking level it asks for) and picks the provider. */
async function chooseByRouter(deps: StartConversationDeps, startable: ProviderId[], prompt: string): Promise<StartChoice> {
  const outcome = await deps.modelProfiles.route(undefined, prompt, { acceptProvider: provider => startable.includes(provider), latestMessage: prompt });
  if (outcome.ok) return { provider: outcome.provider, profile: 'auto', decision: outcome.decision };
  const provider = startable.includes(deps.startDefault.provider) ? deps.startDefault.provider : startable[0]!;
  const why = shortReason(outcome.reason);
  try {
    await deps.modelProfiles.entry(provider, deps.startDefault.profile);
    return {
      provider,
      profile: deps.startDefault.profile,
      warning: `Auto could not pick a provider (${why}). Started on ${PROVIDER_NAMES[provider]} ${MODEL_PROFILE_NAMES[deps.startDefault.profile]}.`,
    };
  } catch (error) {
    if (!(error instanceof ModelProfilesUnavailableError)) throw error;
    // Even the default's model cannot be looked up: start on Auto with no model chosen, so the provider runs its own default.
    return {
      provider,
      profile: 'auto',
      decision: fallbackDecision(`${why}. ${error.message}`, undefined),
      warning: `Auto could not pick a provider (${why}). Started on ${PROVIDER_NAMES[provider]} with its own default model.`,
    };
  }
}

/**
 * Start on a level the person picked: the router picks the provider whose model at that level has the most quota room. When it
 * cannot answer, the chat starts at that level on the configured default provider, or the first startable provider that has a
 * model at the level. When no startable provider has one, Start fails with a reason rather than starting on a different level.
 */
async function chooseByLevel(deps: StartConversationDeps, startable: ProviderId[], level: FixedModelProfileKey): Promise<StartChoice> {
  const name = MODEL_PROFILE_NAMES[level];
  const outcome = await deps.modelProfiles.routeLevel(level, undefined, { acceptProvider: provider => startable.includes(provider) });
  if (outcome.ok) {
    return { provider: outcome.provider, profile: level, ...(outcome.decision.reason ? { status: `${name}: ${outcome.decision.reason}` } : {}) };
  }
  const why = shortReason(outcome.reason);
  let profiles;
  try {
    profiles = await deps.modelProfiles.profiles();
  } catch (error) {
    if (!(error instanceof ModelProfilesUnavailableError)) throw error;
    throw new StartUnavailableError(`Could not start on ${name}: the router could not pick a model (${why}) and ${shortReason(error.message)}.`);
  }
  const holders = startable.filter(provider => profiles.providers[provider].levels[level]);
  if (holders.length === 0) {
    throw new StartUnavailableError(`No provider that can start a chat in this project offers the ${name} level (${why}).`);
  }
  const provider = holders.includes(deps.startDefault.provider) ? deps.startDefault.provider : holders[0]!;
  return { provider, profile: level, warning: `The router could not pick a provider for ${name} (${why}). Started on ${PROVIDER_NAMES[provider]} ${name}.` };
}
