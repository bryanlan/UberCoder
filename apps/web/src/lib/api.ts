import type {
  AuthState,
  BoundSession,
  ConversationTimeline,
  DirectoryBrowserResponse,
  EditableProjectSettings,
  SettingsSummary,
  SessionKeystrokeRequest,
  TreeResponse,
  UpdateGlobalSettingsRequest,
  UpdateProjectSettingsRequest,
} from '@agent-console/shared';

export class ApiError extends Error {
  details?: unknown;
  status?: number;

  constructor(message: string, options: { details?: unknown; status?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.details = options.details;
    this.status = options.status;
  }
}

async function request<T>(input: string, init: RequestInit = {}, csrfToken?: string): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(init.headers ?? {}),
    },
    ...init,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(body?.error ?? 'Request failed.', { details: body?.details, status: response.status });
  }
  return body as T;
}

export const api = {
  authState: () => request<AuthState>('/api/auth/me'),
  login: (password: string) => request<AuthState>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: (csrfToken?: string) => request<void>('/api/auth/logout', { method: 'POST', body: '{}' }, csrfToken),
  tree: () => request<TreeResponse>('/api/projects/tree'),
  refreshTree: (csrfToken?: string) => request<TreeResponse>('/api/projects/refresh', { method: 'POST', body: '{}' }, csrfToken),
  timeline: (projectSlug: string, provider: string, conversationRef: string) => request<ConversationTimeline>(`/api/conversations/${encodeURIComponent(projectSlug)}/${provider}/${encodeURIComponent(conversationRef)}/messages`),
  bindConversation: (projectSlug: string, provider: string, conversationRef: string, csrfToken?: string) => request<{ session: BoundSession }>(`/api/conversations/${encodeURIComponent(projectSlug)}/${provider}/${encodeURIComponent(conversationRef)}/bind`, { method: 'POST', body: '{}' }, csrfToken),
  bindNewConversation: (projectSlug: string, provider: string, csrfToken?: string) => request<{ session: BoundSession; conversationRef: string }>(`/api/conversations/${encodeURIComponent(projectSlug)}/${provider}/new/bind`, { method: 'POST', body: '{}' }, csrfToken),
  sendInput: (sessionId: string, text: string, csrfToken?: string) => request<BoundSession>(`/api/sessions/${encodeURIComponent(sessionId)}/input`, { method: 'POST', body: JSON.stringify({ text }) }, csrfToken),
  sendKeystrokes: (sessionId: string, body: SessionKeystrokeRequest, csrfToken?: string) =>
    request<BoundSession>(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, { method: 'POST', body: JSON.stringify(body) }, csrfToken),
  releaseSession: (sessionId: string, csrfToken?: string) => request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/release`, { method: 'POST', body: '{}' }, csrfToken),
  rawOutput: (sessionId: string) => request<{ text: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/raw-output`),
  settings: () => request<SettingsSummary>('/api/settings'),
  browseDirectories: (directoryPath?: string) =>
    request<DirectoryBrowserResponse>(directoryPath ? `/api/settings/directories?path=${encodeURIComponent(directoryPath)}` : '/api/settings/directories'),
  updateGlobalSettings: (body: UpdateGlobalSettingsRequest, csrfToken?: string) =>
    request<{ settings: SettingsSummary; restartRequired: boolean }>('/api/settings/global', { method: 'PUT', body: JSON.stringify(body) }, csrfToken),
  updateProjectSettings: (directoryName: string, body: UpdateProjectSettingsRequest, csrfToken?: string) =>
    request<{ project: EditableProjectSettings }>(`/api/settings/projects/${encodeURIComponent(directoryName)}`, { method: 'PUT', body: JSON.stringify(body) }, csrfToken),
  restartServer: (csrfToken?: string) => request<{ restarting: boolean }>('/api/settings/restart', { method: 'POST', body: '{}' }, csrfToken),
};
