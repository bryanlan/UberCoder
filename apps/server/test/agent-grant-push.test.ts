import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(authenticated = true, decisionOk = true) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => {}), openWindow = vi.fn(async () => {});
  const fetch = vi.fn(async (url: string) => url === '/api/auth/me'
    ? { json: async () => ({ authenticated, csrfToken: authenticated ? 'current-csrf' : undefined }) }
    : { ok: decisionOk });
  vm.runInNewContext(fs.readFileSync(new URL('../../web/public/grant-push-sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
      registration: { showNotification }, clients: { openWindow } }, fetch, encodeURIComponent,
  });
  const run = async (name: string, event: Record<string, unknown>) => {
    let completion: Promise<unknown> | undefined;
    handlers.get(name)!({ ...event, waitUntil: (promise: Promise<unknown>) => { completion = promise; } }); await completion;
  };
  const click = (action: string) => run('notificationclick', { action, notification: { close: vi.fn(), data: { grantId: 'grant-id', url: '/grants?request=grant-id' } } });
  return { run, click, showNotification, openWindow, fetch };
}

describe('Grant notification actions', () => {
  it('shows plain scope and the Approve, Edit and Deny actions from a push event', async () => {
    const w = worker(); await w.run('push', { data: { json: () => ({ title: 'Agent permission request', body: 'Complete the planner overnight', grantId: 'grant-id', url: '/grants?request=grant-id' }) } });
    expect(w.showNotification).toHaveBeenCalledWith('Agent permission request', expect.objectContaining({ body: 'Complete the planner overnight',
      actions: [{ action: 'approve', title: 'Approve' }, { action: 'edit', title: 'Edit' }, { action: 'deny', title: 'Deny' }] }));
  });
  it.each(['approve', 'deny'])('uses current authenticated CSRF state for %s', async action => {
    const w = worker(); await w.click(action);
    expect(w.fetch).toHaveBeenLastCalledWith('/api/grants/grant-id/decision', expect.objectContaining({ credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'current-csrf' }, body: JSON.stringify({ decision: action }) }));
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it('opens the retained request for Edit, an expired login, or an unavailable decision', async () => {
    for (const [authenticated, decisionOk, action] of [[true,true,'edit'],[false,true,'approve'],[true,false,'deny']] as const) {
      const w = worker(authenticated, decisionOk); await w.click(action); expect(w.openWindow).toHaveBeenCalledWith('/grants?request=grant-id');
    }
  });
});
