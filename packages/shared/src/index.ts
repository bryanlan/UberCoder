export * from './coordination.js';
export const PROVIDERS = ['codex', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const CODEX_COST_PROFILES = {
  high: { model: 'gpt-6-astra', reasoningEffort: 'xhigh', shortcut: 'H' },
  medium: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', shortcut: 'M' },
  low: { model: 'gpt-6-luna', reasoningEffort: 'xhigh', shortcut: 'L' },
} as const;
export type CodexCostProfileKey = keyof typeof CODEX_COST_PROFILES;

export const CLAUDE_COST_PROFILES = {
  high: { model: 'claude-fable-5-1', reasoningEffort: 'xhigh', shortcut: 'H' },
  medium: { model: 'claude-opus-5-5', reasoningEffort: 'xhigh', shortcut: 'M' },
  low: { model: 'claude-sonnet-5', reasoningEffort: 'high', shortcut: 'L' },
} as const;
export type ClaudeCostProfileKey = keyof typeof CLAUDE_COST_PROFILES;
export type ModelProfileKey = CodexCostProfileKey | ClaudeCostProfileKey;

export function visibleModelMatchesProfile(provider: ProviderId, profile: ModelProfileKey, visibleModel: string | undefined): boolean | undefined {
  if (!visibleModel) return undefined;
  const selected = provider === 'codex' ? CODEX_COST_PROFILES[profile] : CLAUDE_COST_PROFILES[profile];
  if (provider === 'codex') {
    const observed = visibleModel.trim().match(/^(gpt-[\w.-]+)(?:\s+(default|low|medium|high|xhigh|max|ultra))?$/i);
    if (!observed) return undefined;
    return observed[1]!.toLowerCase() === selected.model
      && (!observed[2] || observed[2].toLowerCase() === selected.reasoningEffort);
  }
  const expected = selected.model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
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

export interface SessionModelProfileResponse {
  session: BoundSession;
}

export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'status'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type MessageLifecycle = 'durable' | 'pending' | 'status';

export const SESSION_STATUSES = ['starting', 'bound', 'releasing', 'ended', 'error'] as const;
export type BoundSessionStatus = (typeof SESSION_STATUSES)[number];

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
  statusKind?: 'run-failure';
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
  runFailure?: RunFailure;
  id: string;
  provider: ProviderId;
  codexProfile?: CodexCostProfileKey;
  claudeProfile?: ClaudeCostProfileKey;
  modelProfileRequest?: ModelProfileRequest;
  projectSlug: string;
  conversationRef: string;
  resumeConversationRef?: string;
  tmuxSessionName: string;
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
  isWorking?: boolean;
  pid?: number | null;
  rawLogPath?: string;
  eventLogPath?: string;
}

export function isBoundSessionSuspended(session: BoundSession | undefined): boolean {
  return Boolean(session?.manualSuspendedAt || session?.pressureSuspendedAt);
}

export interface SessionInputRequest {
  text: string;
}

export interface RefreshTreeRequest {
  autoTrackRecent?: boolean;
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
}

export interface SessionKeystrokeRequest {
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
  title: string;
  revision: number;
  updatedAt: string;
  author: string;
  summary: string;
}

export interface WikiHistoryEntry {
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
  results: Array<{ title: string; revision: number; updatedAt: string; snippet: string }>;
}
