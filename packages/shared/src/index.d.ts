export declare const PROVIDERS: readonly ["codex", "claude"];
export type ProviderId = (typeof PROVIDERS)[number];
export declare const MESSAGE_ROLES: readonly ["user", "assistant", "system", "tool", "status"];
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type MessageLifecycle = 'durable' | 'pending' | 'status';
export declare const SESSION_STATUSES: readonly ["starting", "bound", "releasing", "ended", "error"];
export type BoundSessionStatus = (typeof SESSION_STATUSES)[number];
export type ConversationKind = 'history' | 'pending';
export declare const CONVERSATION_SEARCH_RECENCY_BUCKETS: readonly ["0-5-days", "5-15-days", "15-30-days", "30-60-days", "60-plus-days"];
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
    allMessages?: NormalizedMessage[];
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
    tmuxSessionName: string;
    status: BoundSessionStatus;
    title?: string;
    startedAt: string;
    updatedAt: string;
    lastActivityAt?: string;
    pid?: number | null;
    rawLogPath?: string;
    eventLogPath?: string;
}
export interface SessionInputRequest {
    text: string;
}
export interface LoginRequest {
    password: string;
}
export interface AuthState {
    authenticated: boolean;
    user?: {
        login?: string;
        displayName?: string;
        via: 'password' | 'tailscale';
    };
    csrfToken?: string;
}
export interface TreeResponse {
    projects: ProjectSummary[];
    boundSessions: BoundSession[];
    lastIndexedAt?: string;
}
export interface SettingsSummary {
    configPath: string;
    projectsRoot: string;
    serverHost: string;
    serverPort: number;
    security: {
        trustTailscaleHeaders: boolean;
        cookieSecure: boolean;
        sessionTtlHours: number;
    };
}
export type SessionEvent = {
    type: 'session.updated';
    session: BoundSession;
} | {
    type: 'session.raw-output';
    sessionId: string;
    projectSlug: string;
    provider: ProviderId;
    conversationRef: string;
    chunk: string;
    timestamp: string;
} | {
    type: 'session.user-input';
    sessionId: string;
    projectSlug: string;
    provider: ProviderId;
    conversationRef: string;
    text: string;
    timestamp: string;
} | {
    type: 'conversation.index-updated';
    projectSlug?: string;
    provider?: ProviderId;
    conversationRef?: string;
    timestamp: string;
} | {
    type: 'session.released';
    sessionId: string;
    conversationRef: string;
    projectSlug: string;
    provider: ProviderId;
    timestamp: string;
} | {
    type: 'heartbeat';
    timestamp: string;
};
export interface ApiErrorShape {
    error: string;
    details?: unknown;
}
