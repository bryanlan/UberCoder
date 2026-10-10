import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVALID_CSRF_TOKEN_CODE, type AuthState, type SessionKeystrokeRequest } from '@agent-console/shared';
import { api } from './api';
import { queryClient } from './query-client';

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const csrfRejection = () => response(403, { error: 'Invalid CSRF token.', code: INVALID_CSRF_TOKEN_CODE });
const authenticated = (csrfToken: string): AuthState => ({ authenticated: true, csrfToken });
const chat: SessionKeystrokeRequest = { text: 'Keep this draft', keys: ['Enter'], submittedText: 'Keep this draft' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function installSuccessfulFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ session: { id: 'session-1' } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  return fetchMock.mock.calls[index]?.[1] as RequestInit;
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('CSRF recovery', () => {
  it('refreshes auth, retries the same chat once and uses the recovered token for later actions', async () => {
    queryClient.setQueryData(['auth'], authenticated('old-token'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfRejection())
      .mockResolvedValueOnce(response(200, authenticated('new-token')))
      .mockResolvedValue(response(200, { session: { id: 'session-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.sendKeystrokes('session-1', chat, 'old-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/auth/me', expect.objectContaining({ cache: 'no-store', credentials: 'include' })]);
    expect(queryClient.getQueryData(['auth'])).toEqual(authenticated('new-token'));
    const first = requestInit(fetchMock, 0);
    const retry = requestInit(fetchMock, 2);
    expect(new Headers(first.headers).get('x-csrf-token')).toBe('old-token');
    expect(new Headers(retry.headers).get('x-csrf-token')).toBe('new-token');
    expect(retry.body).toBe(first.body);
    expect(JSON.parse(String(retry.body))).toEqual(chat);

    await api.setSessionModelProfile('session-1', 'high', 'old-token');
    expect(new Headers(requestInit(fetchMock, 3).headers).get('x-csrf-token')).toBe('new-token');
  });

  it('shares one auth refresh and lets delayed stale rejections use the recovered token', async () => {
    queryClient.setQueryData(['auth'], authenticated('old-token'));
    const refreshed = deferred<ReturnType<typeof response>>();
    const delayedRejection = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/auth/me') return refreshed.promise;
      if (new Headers(init.headers).get('x-csrf-token') === 'new-token') return response(200, { session: { id: url } });
      if (url.includes('session-3')) return delayedRejection.promise;
      return csrfRejection();
    });
    vi.stubGlobal('fetch', fetchMock);

    const sends = [1, 2, 3].map(id => api.sendKeystrokes(`session-${id}`, chat, 'old-token'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1));
    refreshed.resolve(response(200, authenticated('new-token')));
    await Promise.all(sends.slice(0, 2));
    delayedRejection.resolve(csrfRejection());
    await Promise.all(sends);

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1);
    for (const id of [1, 2, 3]) expect(fetchMock.mock.calls.filter(([url]) => url.includes(`session-${id}`))).toHaveLength(2);
  });

  it('stops after one retry when CSRF is rejected again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfRejection())
      .mockResolvedValueOnce(response(200, authenticated('new-token')))
      .mockResolvedValueOnce(csrfRejection());
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendKeystrokes('session-1', chat, 'old-token')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('updates unauthenticated state and does not resend a draft when sign-in is required', async () => {
    queryClient.setQueryData(['auth'], authenticated('old-token'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfRejection())
      .mockResolvedValueOnce(response(200, { authenticated: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendKeystrokes('session-1', chat, 'old-token')).rejects.toMatchObject({ status: 401 });
    expect(queryClient.getQueryData(['auth'])).toEqual({ authenticated: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows another recovery after an auth refresh fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfRejection())
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(csrfRejection())
      .mockResolvedValueOnce(response(200, authenticated('new-token')))
      .mockResolvedValueOnce(response(200, { session: { id: 'session-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendKeystrokes('session-1', chat, 'old-token')).rejects.toThrow('Connection lost');
    await api.sendKeystrokes('session-1', chat, 'old-token');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403, 409, 500])('never replays an ordinary HTTP %s error', async status => {
    const fetchMock = vi.fn().mockResolvedValue(response(status, { error: 'Invalid CSRF token.' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendKeystrokes('session-1', chat, 'old-token')).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never replays a network error with uncertain delivery', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Connection lost'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendKeystrokes('session-1', chat, 'old-token')).rejects.toThrow('Connection lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries binary uploads with the same bytes and content type', async () => {
    const file = new Blob(['fixture image bytes'], { type: 'image/png' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfRejection())
      .mockResolvedValueOnce(response(200, authenticated('new-token')))
      .mockResolvedValueOnce(response(200, { image: { id: 'image-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await api.uploadImage('session-1', file, 'old-token')).toEqual({ id: 'image-1' });
    for (const index of [0, 2]) {
      expect(requestInit(fetchMock, index).body).toBe(file);
      expect(new Headers(requestInit(fetchMock, index).headers).get('content-type')).toBe('image/png');
    }
  });

  it('aborts the older auth HTTP request before refreshing authentication', async () => {
    queryClient.setQueryData(['auth'], authenticated('old-token'));
    const oldResponse = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(csrfRejection())
      .mockImplementationOnce(() => {
        expect(requestInit(fetchMock, 0).signal?.aborted).toBe(true);
        return Promise.resolve(response(200, authenticated('new-token')));
      })
      .mockResolvedValueOnce(response(200, { session: { id: 'session-1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = queryClient.fetchQuery({ queryKey: ['auth'], queryFn: api.authState }).catch(() => undefined);
    expect(requestInit(fetchMock, 0).signal?.aborted).toBe(false);

    await api.sendKeystrokes('session-1', chat, 'old-token');
    oldResponse.resolve(response(200, authenticated('old-token')));
    await pending;
    expect(queryClient.getQueryData(['auth'])).toEqual(authenticated('new-token'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('api.bindConversation', () => {
  it('omits external handoff confirmation from ordinary Codex recovery binds', async () => {
    const fetchMock = installSuccessfulFetch();

    await api.bindConversation('plaidbasic', 'codex', 'conversation-1', 'csrf-token', {
      force: true,
      initialPrompt: 'Continue working',
    });

    expect(requestBody(fetchMock)).toEqual({
      force: true,
      initialPrompt: 'Continue working',
    });
  });

  it('sends external handoff confirmation when the user explicitly confirms it', async () => {
    const fetchMock = installSuccessfulFetch();

    await api.bindConversation('demo', 'claude', 'conversation-2', 'csrf-token', {
      confirmExternalHandoff: true,
    });

    expect(requestBody(fetchMock)).toEqual({
      force: false,
      confirmExternalHandoff: true,
    });
  });
});

describe('model-profile requests', () => {
  it('submits selections immediately to the server-owned queue', async () => {
    const fetchMock = installSuccessfulFetch();

    await api.setSessionModelProfile('session-1', 'high', 'csrf-token');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/model-profile', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ profile: 'high' }),
    }));
  });

  it('cancels a specific queued request with DELETE', async () => {
    const fetchMock = installSuccessfulFetch();

    await api.cancelSessionModelProfileRequest('session-1', 'request-1', 'csrf-token');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/model-profile/requests/request-1', expect.objectContaining({
      method: 'DELETE',
    }));
  });
});
