import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerPanelSnapshot } from '@agent-console/shared';
import { api } from '../lib/api';
import { WorkerPanel } from './WorkerPanel';

vi.mock('../lib/api', () => ({ api: { workers: vi.fn(), refreshWorkers: vi.fn(), setWorkerTracking: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); });
const snapshot = (): WorkerPanelSnapshot => ({ workingCount: 1, generating: false, enabled: true, trackingEnabled: true, error: null,
  workers: [{ id: 'one', projectSlug: 'alpha', projectName: 'Alpha', provider: 'codex', conversationRef: 'native/one',
    title: 'A very long conversation name that appears in the left sidebar', working: true, task: 'Task', summaryAt: '2026-10-12T12:00:00Z',
    summary: { task: 'Fix schema', latest: 'Checking source readbacks', coordination: 'Asked the Web agent for requirements' }, stale: false }],
  usage: { date: '2026-10-12', calls: 2, failedCalls: 1, unknownUsageCalls: 1, runningCalls: 0,
    inputTokens: 10, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 3, totalTokens: 18 } });
function setup(data = snapshot()) {
  vi.mocked(api.workers).mockResolvedValue(data); vi.mocked(api.refreshWorkers).mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const view = render(<QueryClientProvider client={client}><MemoryRouter><WorkerPanel onClose={onClose} /></MemoryRouter></QueryClientProvider>);
  return { ...view, client, onClose };
}
it('shows the same conversation identity, three summary rows, full-title hover and exact conversation link', async () => {
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Active workers' });
  const link = await within(panel).findByRole('link', { name: /CODEX: A very long conversation name/ });
  expect(link).toHaveAttribute('href', '/projects/alpha/codex/native%2Fone');
  expect(link).toHaveAttribute('title', 'CODEX: A very long conversation name that appears in the left sidebar');
  expect(within(panel).getByText('Checking source readbacks')).toBeInTheDocument();
  expect(within(panel).getByText('Asked the Web agent for requirements')).toBeInTheDocument();
  expect(within(panel).getByText(/18 known tokens/)).toBeInTheDocument();
  expect(within(panel).getByText(/Usage unavailable or pending for 1 request/)).toBeInTheDocument();
  await waitFor(() => expect(api.refreshWorkers).toHaveBeenCalledWith(2));
});
it('persists the selected cadence and uses the new interval', async () => {
  setup(); await screen.findByText('Fix schema');
  await userEvent.selectOptions(screen.getByLabelText('Summaries every'), '5');
  await waitFor(() => expect(api.refreshWorkers).toHaveBeenCalledWith(5));
  expect(localStorage.getItem('agent-console:worker-refresh-minutes')).toBe('5');
});
it('does not call the model for idle workers and shows paused state', async () => {
  const data = snapshot(); data.workingCount = 0; data.workers[0]!.working = false;
  setup(data); await screen.findByText('No workers are running. Summaries are paused.');
  expect(api.refreshWorkers).not.toHaveBeenCalled(); expect(screen.getByText('Idle')).toBeInTheDocument();
});
it('keeps stale summaries visible when generation fails and closes cleanly', async () => {
  const data = snapshot(); data.error = 'Summary unavailable'; data.workers[0]!.stale = true; data.enabled = false;
  const f = setup(data); await screen.findByText('Checking source readbacks');
  expect(screen.getByText(/out of date/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Close worker panel' })); expect(f.onClose).toHaveBeenCalledTimes(1);
});
it('does not fetch or generate while the document is hidden', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  setup(); await Promise.resolve();
  expect(api.workers).not.toHaveBeenCalled(); expect(api.refreshWorkers).not.toHaveBeenCalled();
});
it('switches Off globally and keeps the server setting after remount', async () => {
  setup(); await screen.findByText('Fix schema');
  const off = { ...snapshot(), enabled: false, trackingEnabled: false, workers: [], workingCount: 0 };
  vi.mocked(api.setWorkerTracking).mockImplementation(async () => { vi.mocked(api.workers).mockResolvedValue(off); return off; });
  await userEvent.click(screen.getByRole('switch', { name: 'Worker tracking' }));
  await screen.findByText(/Worker tracking is off across all tabs/);
  expect(api.setWorkerTracking).toHaveBeenCalledWith(false);
  expect(screen.getByLabelText('Summaries every')).toBeDisabled();
  cleanup(); vi.mocked(api.refreshWorkers).mockClear();
  setup(off); await screen.findByText(/Worker tracking is off across all tabs/);
  expect(screen.getByRole('switch', { name: 'Worker tracking' })).toHaveAttribute('aria-checked', 'false');
  expect(api.refreshWorkers).not.toHaveBeenCalled();
});
