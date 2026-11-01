export * from './coordination.js';
export * from './workers.js';
export const PROVIDERS = ['codex', 'claude', 'grok'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/**
 * Model profiles. The High, Medium and Low models live in one place outside this repository (the workflow_optimizer model
 * catalog, read through `wo profiles --json`), so nothing here names a model. `auto` is not a model: it asks the router
 * for one when the next message is sent.
 */
export const FIXED_MODEL_PROFILE_KEYS = ['high', 'medium', 'low'] as const;
export type FixedModelProfileKey = (typeof FIXED_MODEL_PROFILE_KEYS)[number];
export const MODEL_PROFILE_KEYS = ['auto', ...FIXED_MODEL_PROFILE_KEYS] as const;
export type ModelProfileKey = (typeof MODEL_PROFILE_KEYS)[number];
/** The keyboard shortcut letter (Alt plus the letter) and button label of each profile. */
export const MODEL_PROFILE_SHORTCUTS: Record<ModelProfileKey, string> = { auto: 'A', high: 'H', medium: 'M', low: 'L' };

/** The model and reasoning effort a provider is started with or switched to. `model` is the provider's launch name. */
export interface ModelTarget {
  model: string;
  effort: string;
}

/** One fixed profile level as the catalog defines it. */
export interface ModelProfileEntry {
  /** The catalog's model id. */
  model: string;
  /** Plain-English model name, for example `Claude Opus 5.5`. */
  label: string;
  effort: string;
  /** The name the Console launches the model with (`--model` for Claude, the turn model for Codex). */
  launchName: string;
}

export interface ProviderModelProfiles {
  /** The vendor behind the provider, as the router names it. */
  routerProvider: 'openai' | 'anthropic' | 'xai';
  levels: Record<FixedModelProfileKey, ModelProfileEntry>;
}

/** What `GET /api/model-profiles` returns. */
export interface ModelProfilesResponse {
  providers: Record<ProviderId, ProviderModelProfiles>;
  loadedAt: string;
}

/** One routing decision for an Auto session, built only from the router's typed answer (or from the Medium fallback). */
export interface AutoDecision {
  /** `router`: the router chose. `fallback`: routing failed and Medium was applied. */
  source: 'router' | 'fallback';
  decidedAt: string;
  /** Catalog id of the chosen model; absent only when even the Medium profile could not be loaded. */
  model?: string;
  label?: string;
  effort?: string;
  /** The name the Console launches the model with. */
  launchName?: string;
  /** The role the router routed for (`implementer`), from the classifier or its default. */
  role?: string;
  /** Classifier confidence in that role, 0 to 100, when the classifier answered. */
  rolePercent?: number;
  /** `lighter`, `standard` or `heavier`, when the classifier answered. */
  difficulty?: string;
  /** `ok`, or `fallback` when the classifier could not answer and the router used its default role. */
  classifierStatus?: string;
  /** Weekly-quota pacing of the chosen subscription: surplus, on_pace, tight, stale or unknown. */
  quotaState?: string;
  /**
   * True when the classifier could not tell what kind of task this is, so the choice is a first guess. The next prompts re-route
   * it (at most three provisional prompts in all). Absent or false: the choice is final.
   */
  provisional?: boolean;
  /** The router's full plain-English reason. */
  reason?: string;
  /** Shown to the person when Auto fell back, for example `Auto unavailable: timed out. Using Medium.` */
  warning?: string;
}

/** Auto state kept on a session whose profile is `auto`. */
export interface AutoRoute {
  /** True from the moment A is selected until the next message has been routed. */
  routePending: boolean;
  /** The latest decision. Its model is what the session runs on until the next routing. */
  decision?: AutoDecision;
  /**
   * How many prompts have been routed since A was selected (the first counts). Absent after A is pressed again, so the next prompt
   * counts as the first. The second prompt is always routed again; later ones only while the choice is provisional, up to
   * {@link MAX_ROUTED_PROMPTS}, when the last choice is kept as final.
   */
  routedPrompts?: number;
  /** The text the last routing saw (at most 2,000 characters); the next routing starts from it. */
  previousPrompt?: string;
}

/** Auto routes at most this many prompts per selection of A, counting the first. */
export const MAX_ROUTED_PROMPTS = 3;

const AUTO_QUOTA_WORDS: Record<string, string> = {
  surplus: 'surplus',
  on_pace: 'on pace',
  tight: 'tight',
  stale: 'quota stale',
  unknown: 'quota unknown',
};

/** The plain name of each provider, as the profile line and status text say it. */
export const PROVIDER_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude', grok: 'Grok' };

/** A short model name for the one-line display: `Claude Sonnet 5.5` becomes `Sonnet 5.5`. */
export function shortModelLabel(label: string): string {
  return label.replace(/^Claude\s+/, '');
}

/**
 * The compact line and the hover text shown next to the profile control, built only from typed router fields.
 * Example line: `A → Sonnet 5.5·low · implementer 91% · lighter · Claude on pace`.
 */
export function describeAutoRoute(provider: ProviderId, route: AutoRoute | undefined): { line: string; title?: string } {
  const providerName = PROVIDER_NAMES[provider];
  const decision = route?.decision;
  if (!decision) return { line: route?.routePending ? 'A → routes with your next message' : 'A' };
  const provisional = decision.source === 'router' && decision.provisional === true;
  const parts: string[] = [];
  parts.push(decision.label && decision.effort ? `${shortModelLabel(decision.label)}·${decision.effort}` : 'no model chosen');
  if (decision.source === 'router') {
    // A provisional choice is a first guess because the router could not tell the kind of task, so the role is not shown as fact.
    if (provisional) parts.push('role unclear');
    else if (decision.role) parts.push(decision.rolePercent !== undefined ? `${decision.role} ${decision.rolePercent}%` : decision.role);
    if (decision.difficulty) parts.push(decision.difficulty);
    if (decision.quotaState) parts.push(`${providerName} ${AUTO_QUOTA_WORDS[decision.quotaState] ?? decision.quotaState}`);
  }
  const base = `${provisional ? 'A (provisional)' : 'A'} → ${parts.join(' · ')}`;
  // A provisional choice re-routes by itself and its marker already says so. After the first prompt the second is always checked
  // once more; A pressed again routes the next message afresh.
  const pendingNote = provisional ? undefined : route?.routedPrompts === 1 ? 're-checks at your next prompt' : 're-routes with your next message';
  const line = route?.routePending && pendingNote ? `${base} · ${pendingNote}` : base;
  const title = decision.source === 'fallback' ? decision.warning : decision.reason;
  return { line, ...(title ? { title } : {}) };
}

/**
 * Whether the model a session shows on screen is the model of `target`. `undefined`: it cannot be told (no screen text, or text
 * in a form this does not read).
 */
export function visibleModelMatchesTarget(provider: ProviderId, target: ModelTarget, visibleModel: string | undefined): boolean | undefined {
  if (!visibleModel) return undefined;
  if (provider === 'codex' || provider === 'grok') {
    const observed = visibleModel.trim().match(provider === 'codex'
      ? /^(gpt-[\w.-]+)(?:\s+(default|low|medium|high|xhigh|max|ultra))?$/i
      : /^(grok-[\w.-]+)(?:\s+(default|low|medium|high|xhigh|max))?$/i);
    if (!observed) return undefined;
    return observed[1]!.toLowerCase() === target.model
      && (!observed[2] || observed[2].toLowerCase() === target.effort);
  }
  const expected = target.model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  const observed = visibleModel.trim().match(/^([a-z]+)\s+(\d+)(?:\.(\d+))?$/i);
  if (!expected || !observed) return undefined;
  return observed[1]!.toLowerCase() === expected[1]
    && observed[2] === expected[2]
    && observed[3] === expected[3];
}

export type ModelProfileDeferredReason =
  | 'turn_running'
  | 'unsent_input'
  | 'interactive_input'
  | 'provider_message_queued'
  | 'starting'
  | 'awaiting_native_conversation'
  | 'cannot_verify_idle';

interface ModelProfileRequestBase {
  requestId: string;
  profile: ModelProfileKey;
  requestedAt: string;
  /**
   * For a switch to `auto`: the Auto state the switch commits (a decision from the router, or just routePending). Absent for
   * High, Medium and Low, which clear any Auto state when they complete.
   */
  autoRoute?: AutoRoute;
  /** For an Auto decision: the model and effort to apply, so a restart between the steps still applies the same choice. */
  target?: ModelTarget;
}

export type ModelProfileRequest =
  | (ModelProfileRequestBase & {
      state: 'queued';
      deferredReason?: ModelProfileDeferredReason;
    })
  | (ModelProfileRequestBase & {
      state: 'applying';
      startedAt: string;
      previousProfile?: ModelProfileKey;
      resumeConversationRef: string;
    })
  | (ModelProfileRequestBase & {
      state: 'failed';
      failedAt: string;
      message: string;
    });

/**
 * The provider-neutral Start: the person gives a project and a first prompt and the server picks the provider. `prompt` is the
 * whole first message; the router sees its first 2,000 characters.
 */
export interface StartConversationRequest {
  prompt: string;
}

/** What Start returns: the new session on whichever provider took it. */
export interface StartConversationResponse {
  session: BoundSession;
  conversationRef: string;
  provider: ProviderId;
  /** Set when routing failed and the configured default provider and profile took the chat. Shown to the person. */
  warning?: string;
}

export interface SessionModelProfileResponse {
  session: BoundSession;
}

export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'status'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type MessageLifecycle = 'durable' | 'pending' | 'status';

export const SESSION_STATUSES = ['starting', 'bound', 'releasing', 'ended', 'error'] as const;
export type BoundSessionStatus = (typeof SESSION_STATUSES)[number];

/** Which runtime owns a bound session: a hidden tmux terminal or a structured provider protocol. */
export const SESSION_TRANSPORTS = ['tmux', 'structured'] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];

export type ConversationKind = 'history' | 'pending';

export const CONVERSATION_SEARCH_RECENCY_BUCKETS = [
  '0-5-days',
  '5-15-days',
  '15-30-days',
  '30-60-days',
  '60-plus-days',
] as const;
export type ConversationSearchRecencyBucket = (typeof CONVERSATION_SEARCH_RECENCY_BUCKETS)[number];

export interface ProviderNode {
  id: ProviderId;
  label: string;
  conversations: ConversationSummary[];
}

export interface ProjectSummary {
  slug: string;
  directoryName: string;
  displayName: string;
  path: string;
  tags: string[];
  notes?: string;
  allowedLocalhostPorts: number[];
  providers: Record<ProviderId, ProviderNode>;
}

export interface ConversationSummary {
  ref: string;
  kind: ConversationKind;
  projectSlug: string;
  provider: ProviderId;
  title: string;
  excerpt?: string;
  createdAt?: string;
  updatedAt: string;
  transcriptPath?: string;
  providerConversationId?: string;
  branch?: string;
  isBound: boolean;
  boundSessionId?: string;
  /** Most recent ended Console binding, derived from retained session records. */
  lastClosedAt?: string;
  degraded: boolean;
  model?: string;
  statusKind?: 'run-failure';
  rawMetadata?: Record<string, unknown>;
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 4;

export interface ImageAttachment {
  id: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  name: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface NormalizedMessage {
  id: string;
  provider: ProviderId;
  role: MessageRole;
  lifecycle: MessageLifecycle;
  text: string;
  images?: ImageAttachment[];
  timestamp: string;
  conversationRef: string;
  source: 'history-file' | 'live-output' | 'synthetic-status' | 'user-input';
  statusKind?: 'run-failure' | 'compaction' | 'coordination';
  rawMetadata?: Record<string, unknown>;
}

export interface SessionScreen {
  content: string;
  contentAnsi?: string;
  inputText: string;
  inputActive: boolean;
  status: string;
  statusAnsi?: string;
  capturedAt: string;
  model?: string;
  contextPercent?: number;
}

export interface ConversationMessagePage {
  hasOlder: boolean;
  olderCursor?: number;
  total: number;
}

/**
 * Transcripts at or above this size serve a stale parse while a bound session is
 * working (re-parsing per poll would be too slow), so mid-turn updates lag until
 * the turn completes. The UI warns at this size so the user can start a new chat.
 */
export const LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface ConversationTimeline {
  conversation: ConversationSummary;
  messages: NormalizedMessage[];
  boundSession?: BoundSession;
  liveScreen?: SessionScreen;
  messagePage?: ConversationMessagePage;
  transcriptSizeBytes?: number;
}

export interface ConversationSearchResult {
  projectSlug: string;
  projectDisplayName: string;
  projectPath?: string;
  provider: ProviderId;
  conversationRef: string;
  conversationKind: ConversationKind;
  conversationTitle: string;
  conversationUpdatedAt: string;
  isBound: boolean;
  role: 'user' | 'assistant';
  timestamp: string;
  snippet: string;
  score: number;
  recencyBucket: ConversationSearchRecencyBucket;
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchResult[];
}

export interface RunFailure {
  turnId: string;
  failedAt: string;
  code: string;
  message: string;
  attempts: number;
  maxAttempts: number;
  status: 'scheduled' | 'retrying' | 'stopped';
  nextRetryAt?: string;
  retrySubmittedAt?: string;
  stoppedReason?: string;
}

export interface BoundSession {
  launchContext?: AgentLaunchContext;
  runFailure?: RunFailure;
  id: string;
  provider: ProviderId;
  codexProfile?: ModelProfileKey;
  claudeProfile?: ModelProfileKey;
  grokProfile?: ModelProfileKey;
  /** Present while the profile is `auto`. */
  autoRoute?: AutoRoute;
  modelProfileRequest?: ModelProfileRequest;
  projectSlug: string;
  conversationRef: string;
  resumeConversationRef?: string;
  tmuxSessionName: string;
  /** Chosen at bind time and persisted; existing rows keep their transport when a config flag changes. */
  transport: SessionTransport;
  status: BoundSessionStatus;
  title?: string;
  shouldRestore?: boolean;
  startedAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastOutputAt?: string;
  lastCompletedAt?: string;
  /** Provider-confirmed response time, independent of the recency idle window. */
  lastResponseAt?: string;
  autoTrackedAt?: string;
  /** Explicitly suspended by the user; selecting the conversation resumes it. */
  manualSuspendedAt?: string;
  /** Automatically suspended during low available memory; selecting the conversation resumes it. */
  pressureSuspendedAt?: string;
  /** Automatically asleep after the loaded idle window. */
  idleSuspendedAt?: string;
  isWorking?: boolean;
  queuedInputs?: SessionQueuedInput[];
  /** Structured sessions: requests the provider is waiting on (a question for the person). Projected from backend state. */
  pendingRequests?: PendingRequestSummary[];
  pid?: number | null;
  rawLogPath?: string;
  eventLogPath?: string;
}

export function isBoundSessionSuspended(session: BoundSession | undefined): boolean {
  return Boolean(session?.manualSuspendedAt || session?.pressureSuspendedAt || session?.idleSuspendedAt);
}

export interface SessionInputRequest {
  text: string;
}

export interface RefreshTreeRequest {
  autoTrackRecent?: boolean;
}

/** Body of `POST /api/conversations/:projectSlug/:provider/new/bind` and `.../:conversationRef/bind`. */
export interface BindConversationRequest {
  transport?: SessionTransport;
  force?: boolean;
  initialPrompt?: string;
  confirmExternalHandoff?: true;
}

export interface RecordedUserInput {
  id: string;
  text: string;
  images?: ImageAttachment[];
  timestamp: string;
}

export interface SessionInputResponse {
  session: BoundSession;
  recordedUserInput?: RecordedUserInput;
  queuedInput?: SessionQueuedInput;
}

export interface SessionQueuedInput {
  requestId: string;
  text: string;
  requestedAt: string;
  state: 'queued' | 'waiting_for_input' | 'submitting' | 'needs_review';
  reason: string;
}

/** One question the agent asks the person. `allowCustom` means a typed answer is accepted next to the options. */
export interface PendingRequestQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowCustom?: boolean;
}

/** A request a structured provider has raised and is still waiting on. Only questions stay open; approvals are declined. */
export interface PendingRequestSummary {
  requestId: string;
  kind: 'command' | 'file_change' | 'permission' | 'mcp' | 'question';
  summary: string;
  questions: PendingRequestQuestion[];
  turnId?: string;
  /**
   * `live` (or omitted): the provider is waiting and the answer goes straight to it. `message`: the provider asked in a message and
   * moved on, so the answer is sent as a normal message that quotes the question.
   */
  responseMode?: 'live' | 'message';
  openedAt: string;
}

/** Body of `POST /api/sessions/:id/requests/:requestId`. `answers` maps a question id to the chosen or typed answers. */
export type SessionRequestResponse =
  | { decision: 'answer'; answers: Record<string, string[]>; text?: string }
  | { decision: 'decline' };

export interface SessionKeystrokeRequest {
  /** Idempotent, server-owned delivery of a complete chat draft. */
  submissionId?: string;
  text?: string;
  keys?: string[];
  deferScreenUpdate?: boolean;
  submittedText?: string;
  clientOptimisticMessageId?: string;
  imageIds?: string[];
}

export interface LoginRequest {
  password: string;
}

export interface AuthState {
  authenticated: boolean;
  tailscaleEnabled?: boolean;
  user?: {
    login?: string;
    displayName?: string;
    via: 'password' | 'tailscale';
  };
  csrfToken?: string;
}

// Only the authentication guard may emit this code, before executing an action.
export const INVALID_CSRF_TOKEN_CODE = 'invalid_csrf_token';

export interface EditableProjectSettings {
  directoryName: string;
  path: string;
  exists: boolean;
  active: boolean;
  displayName?: string;
  allowedLocalhostPorts: number[];
  tags: string[];
  notes?: string;
}

export interface TreeResponse {
  projects: ProjectSummary[];
  boundSessions: BoundSession[];
  /** Providers whose structured (non-tmux) lane is enabled in config. */
  structuredProviders?: ProviderId[];
  lastIndexedAt?: string;
}

export interface UiPreferences {
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
}

export interface SettingsSummary {
  configPath: string;
  agentConsolePath: string;
  projectsRoot: string;
  serverHost: string;
  serverPort: number;
  security: {
    trustTailscaleHeaders: boolean;
    cookieSecure: boolean;
    sessionTtlHours: number;
  };
  projects: EditableProjectSettings[];
}

export interface DirectoryBrowserEntry {
  name: string;
  path: string;
  isSymlink: boolean;
}

export interface DirectoryBrowserResponse {
  currentPath: string;
  parentPath?: string;
  homePath: string;
  rootPath: string;
  directories: DirectoryBrowserEntry[];
}

export interface UpdateGlobalSettingsRequest {
  projectsRoot: string;
  serverHost: string;
  serverPort: number;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustTailscaleHeaders: boolean;
}

export interface UpdateProjectSettingsRequest {
  active: boolean;
  displayName?: string;
  allowedLocalhostPorts: number[];
  tags: string[];
  notes?: string;
}

export interface CreateProjectSettingsRequest {
  path: string;
}

export interface CreateDirectoryRequest {
  parentPath: string;
  name: string;
}

export interface UpdateUiPreferencesRequest {
  recentActivitySortEnabled?: boolean;
  manualProjectOrder?: string[];
}

export interface RenameConversationRequest {
  title: string;
}

export type SessionEvent =
  | { type: 'grants.updated'; grantId: string; change: 'grant' | 'use'; timestamp: string }
  | {
      type: 'session.updated';
      session: BoundSession;
    }
  | {
      type: 'session.screen-updated';
      sessionId: string;
      projectSlug: string;
      provider: ProviderId;
      conversationRef: string;
      screen: SessionScreen;
      timestamp: string;
    }
  | {
      type: 'session.raw-output';
      sessionId: string;
      projectSlug: string;
      provider: ProviderId;
      conversationRef: string;
      chunk: string;
      timestamp: string;
    }
  | {
      type: 'session.transcript-updated';
      sessionId: string;
      projectSlug: string;
      provider: ProviderId;
      conversationRef: string;
      timestamp: string;
    }
  | {
      type: 'session.user-input';
      sessionId: string;
      projectSlug: string;
      provider: ProviderId;
      conversationRef: string;
      messageId: string;
      text: string;
      images?: ImageAttachment[];
      timestamp: string;
    }
  | {
      type: 'conversation.index-updated';
      projectSlug?: string;
      provider?: ProviderId;
      conversationRef?: string;
      timestamp: string;
    }
  | {
      type: 'session.released';
      sessionId: string;
      conversationRef: string;
      projectSlug: string;
      provider: ProviderId;
      timestamp: string;
    }
  | {
      type: 'heartbeat';
      timestamp: string;
    };

export interface ApiErrorShape {
  error: string;
  details?: unknown;
}

export interface WikiPage {
  supersededBy?: string | null;
  revision: number;
  title: string;
  body: string;
  summary: string;
  author: string;
  checkout: string;
  branch: string | null;
  headCommit: string | null;
  createdAt: string;
  links: string[];
  backlinks: string[];
}

export interface WikiPageSummary {
  supersededBy?: string | null;
  title: string;
  revision: number;
  updatedAt: string;
  author: string;
  summary: string;
}

export interface WikiHistoryEntry {
  supersededBy?: string | null;
  revision: number;
  summary: string;
  author: string;
  checkout: string;
  branch: string | null;
  headCommit: string | null;
  createdAt: string;
}

export interface WikiListResponse {
  pages: WikiPageSummary[];
  total: number;
  nextOffset: number | null;
}

export interface WikiHistoryResponse {
  revisions: WikiHistoryEntry[];
  total: number;
  nextOffset: number | null;
}

export interface WikiSearchResponse {
  pageCount: number;
  results: Array<{ title: string; revision: number; updatedAt: string; supersededBy?: string | null; snippet: string; matchedTerms: string[] }>;
}

export type AgentGrantAction = 'launch_session' | 'restart_session' | 'close_session';
export interface AgentGrantDefinition {
  grantee: { kind: 'session' | 'assignment' | 'project'; id: string };
  actions: AgentGrantAction[];
  scope: string;
  /** Empty means all configured projects. Free-text scope remains the work boundary. */
  projectSlugs: string[];
  limits: { maxConcurrentSessions: number | null; models: string[] };
  expiry: { kind: 'until_revoked' | 'assignment_finished'; assignmentId?: string };
}
export interface AgentGrant extends AgentGrantDefinition {
  id: string;
  status: 'pending' | 'active' | 'denied' | 'revoked' | 'expired';
  createdByAssignmentId: string;
  requesterName: string;
  granteeName: string;
  reason?: string;
  provenance?: { kind: 'human_message' | 'approval'; quote: string; sessionId?: string; messageId?: string };
  createdAt: string;
  decidedAt?: string;
}
export interface AgentGrantUse {
  id: string; grantId: string; assignmentId: string; action: AgentGrantAction;
  sessionId?: string; timestamp: string; detail: Record<string, unknown>;
}
export interface AgentLaunchContext {
  launchedBy: string;
  launcherName: string;
  grantIds: string[];
  requestId: string;
  model?: string;
  effort?: string;
  flags: string[];
  supervisorId: string;
}
export interface AgentGrantsSnapshot { grants: AgentGrant[]; uses: AgentGrantUse[]; nextUseOffset: number | null }

export interface AgentSessionRequest {
  id: string; assignmentId: string; grantId: string; action: AgentGrantAction;
  status: 'queued' | 'starting' | 'completed' | 'failed' | 'cancelled';
  sessionId: string; title?: string; reason: string | null; updatedAt: string;
}
export interface AgentSessionRequests {
  requests: AgentSessionRequest[]; availableBytes?: number; requiredBytes: number;
}
export interface AgentSessionCancellation extends AgentSessionRequests { cancelled: boolean; reason?: string }
