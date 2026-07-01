export const PROVIDERS = ['codex', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

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

export interface SessionInteractionSummary {
  sessionId: string;
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  status: 'ready' | 'failed';
  generatedAt?: string;
  windowStartAt?: string;
  windowEndAt?: string;
  lastInteractionAt?: string;
  chatSummary?: string;
  recentChangesSummary?: string;
  failedAt?: string;
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
  rawMetadata?: Record<string, unknown>;
  sessionSummary?: SessionInteractionSummary;
}

export interface NormalizedMessage {
  id: string;
  provider: ProviderId;
  role: MessageRole;
  lifecycle: MessageLifecycle;
  text: string;
  timestamp: string;
  conversationRef: string;
  source: 'history-file' | 'live-output' | 'synthetic-status' | 'user-input';
  rawMetadata?: Record<string, unknown>;
}

export interface SessionScreen {
  content: string;
  contentAnsi?: string;
  inputText: string;
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

export interface ConversationTimeline {
  conversation: ConversationSummary;
  messages: NormalizedMessage[];
  boundSession?: BoundSession;
  liveScreen?: SessionScreen;
  messagePage?: ConversationMessagePage;
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

export interface BoundSession {
  id: string;
  provider: ProviderId;
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
  isWorking?: boolean;
  pid?: number | null;
  rawLogPath?: string;
  eventLogPath?: string;
}

export interface SessionInputRequest {
  text: string;
}

export interface RecordedUserInput {
  id: string;
  text: string;
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

export interface SessionFreshnessThresholds {
  yellowMinutes: number;
  redMinutes: number;
}

export interface UiPreferences {
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
  sessionFreshnessThresholds: SessionFreshnessThresholds;
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
  sessionFreshnessThresholds?: SessionFreshnessThresholds;
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
      type: 'session.user-input';
      sessionId: string;
      projectSlug: string;
      provider: ProviderId;
      conversationRef: string;
      messageId: string;
      text: string;
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
