import { afterEach, expect, it, vi } from 'vitest';
import { readServerInstance, waitForServerRestart } from './settings-restart';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const health = (instanceId: string) => ({ ok: true, json: async () => ({ ok: true, instanceId }) });

it('waits through the old process and failed health checks until the replacement responds', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(health('old'))
    .mockRejectedValueOnce(new Error('connection refused'))
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce(health('new'));
  vi.stubGlobal('fetch', fetch);
  const ready = vi.fn();
  const waiting = waitForServerRestart('http://127.0.0.1:4317/settings', 'old').then(ready);
  await vi.advanceTimersByTimeAsync(1200);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  await waiting;
  expect(ready).toHaveBeenCalledOnce();
});

it('probes a changed server address without sending credentials', async () => {
  const fetch = vi.fn().mockResolvedValue(health('replacement'));
  vi.stubGlobal('fetch', fetch);
  await expect(readServerInstance('http://127.0.0.1:5000/settings')).resolves.toBe('replacement');
  expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:5000/api/health');
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
});

it('reports a bounded failure when only the original process remains reachable', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(health('old')));
  const waiting = expect(waitForServerRestart('http://127.0.0.1:4317', 'old', 1000)).rejects.toThrow('did not become available');
  await vi.advanceTimersByTimeAsync(1000);
  await waiting;
});
