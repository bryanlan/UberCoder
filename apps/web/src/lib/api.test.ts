import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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

afterEach(() => {
  vi.unstubAllGlobals();
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
