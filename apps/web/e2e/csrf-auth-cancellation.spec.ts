import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { api } from '../src/lib/api';
import type { queryClient } from '../src/lib/query-client';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

declare global {
  interface Window {
    csrfProbe: {
      api: typeof api;
      queryClient: typeof queryClient;
      oldToken?: string;
      oldRead?: Promise<unknown>;
      send?: Promise<{ ok: boolean; status?: number }>;
    };
  }
}

test('cancels a delayed auth response before it can overwrite the recovered browser cookie', async ({ page, baseURL }) => {
  const oldStarted = gate();
  const oldRelease = gate();
  const oldFinished = gate();
  const recoveryStarted = gate();
  const recoveryRelease = gate();
  const sessions = new Map<string, string>();
  let sequence = 0;
  let authReads = 0;
  let oldDisconnected = false;
  let deliveries = 0;
  const actionStatuses: number[] = [];
  const cookieName = 'agent_console_session';

  function json(reply: ServerResponse, status: number, body: unknown) {
    reply.writeHead(status, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(body));
  }

  // A private HTTP fixture deliberately delays Set-Cookie responses. Chromium
  // manages the real HttpOnly cookie; API requests use the actual web modules.
  const server = createServer(async (request, reply) => {
    if (request.url === '/') {
      reply.writeHead(200, { 'content-type': 'text/html' });
      reply.end('<!doctype html><title>Auth cancellation fixture</title>');
      return;
    }
    if (request.url !== '/api/auth/me' && request.url !== '/api/sessions/fixture/keys') {
      reply.writeHead(404);
      reply.end();
      return;
    }
    let sessionId = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!sessionId || !sessions.has(sessionId)) {
      sessionId = `session-${++sequence}`;
      sessions.set(sessionId, `token-${sequence}`);
      reply.setHeader('set-cookie', `${cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
    }
    const token = sessions.get(sessionId)!;
    if (request.url === '/api/auth/me') {
      const read = ++authReads;
      if (read === 2) {
        reply.on('close', () => { oldDisconnected = !reply.writableFinished; });
        oldStarted.resolve();
        await oldRelease.promise;
      } else if (read === 3) {
        recoveryStarted.resolve();
        await recoveryRelease.promise;
      }
      json(reply, 200, { authenticated: true, csrfToken: token });
      if (read === 2) oldFinished.resolve();
      return;
    }
    if (request.url === '/api/sessions/fixture/keys' && request.method === 'POST') {
      request.resume();
      if (request.headers['x-csrf-token'] !== token) {
        actionStatuses.push(403);
        json(reply, 403, { error: 'Invalid CSRF token.', code: 'invalid_csrf_token' });
      } else {
        deliveries += 1;
        actionStatuses.push(200);
        json(reply, 200, { session: { id: 'fixture' } });
      }
      return;
    }
    reply.writeHead(404);
    reply.end();
  });

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP address');
    const fixtureOrigin = `http://127.0.0.1:${address.port}`;
    await page.goto(fixtureOrigin);
    await page.evaluate(async ({ apiUrl, queryClientUrl }) => {
      const { api } = await import(apiUrl);
      const { queryClient } = await import(queryClientUrl);
      const probe: Window['csrfProbe'] = window.csrfProbe = { api, queryClient };
      const state = await queryClient.fetchQuery({ queryKey: ['auth'], queryFn: api.authState });
      probe.oldToken = state.csrfToken;
    }, {
      apiUrl: new URL('/src/lib/api.ts', baseURL).href,
      queryClientUrl: new URL('/src/lib/query-client.ts', baseURL).href,
    });

    sessions.clear(); // Expire only this test's in-memory login sessions.
    await page.evaluate(() => {
      const probe = window.csrfProbe;
      probe.oldRead = probe.queryClient.fetchQuery({ queryKey: ['auth'], queryFn: probe.api.authState }).catch(() => undefined);
    });
    await oldStarted.promise;
    await page.evaluate(() => {
      const probe = window.csrfProbe;
      probe.send = probe.api.sendKeystrokes('fixture', { text: 'Keep this draft', keys: ['Enter'] }, probe.oldToken)
        .then(() => ({ ok: true }), (error: { status?: number }) => ({ ok: false, status: error.status }));
    });
    await recoveryStarted.promise;
    const cookieBefore = (await page.context().cookies(fixtureOrigin)).find(cookie => cookie.name === cookieName)?.value;
    expect(cookieBefore).toBe('session-3');
    await expect.poll(() => oldDisconnected, { timeout: 5000 }).toBe(true);

    // Send the old response while recovery is still pending. The aborted HTTP
    // request must prevent its session-2 cookie from replacing session-3.
    oldRelease.resolve();
    await oldFinished.promise;
    const cookieAfter = (await page.context().cookies(fixtureOrigin)).find(cookie => cookie.name === cookieName)?.value;
    expect(cookieAfter).toBe(cookieBefore);
    recoveryRelease.resolve();
    expect(await page.evaluate(() => window.csrfProbe.send)).toEqual({ ok: true });
    expect(actionStatuses).toEqual([403, 200]);
    expect(deliveries).toBe(1);
    expect(authReads).toBe(3);
  } finally {
    oldRelease.resolve();
    recoveryRelease.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
