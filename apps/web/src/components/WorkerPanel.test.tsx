import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkerPanelSnapshot } from '@agent-console/shared';
import { api } from '../lib/api';
import { WorkerPanel } from './WorkerPanel';

vi.mock('../lib/api', () => ({ api: { workers: vi.fn(), workerOpeningMessage: vi.fn(), refreshWorkers: vi.fn(), setWorkerTracking: vi.fn() } }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const snapshot = (): WorkerPanelSnapshot => ({ workingCount: 1, generating: false, enabled: true, trackingEnabled: true, pauseReason: null, snapshotAt: '2026-10-12T12:00:00Z', error: null,
  workers: [{ id: 'one', projectSlug: 'alpha', projectName: 'Alpha', provider: 'codex', conversationRef: 'native/one',
    title: 'A very long conversation name that appears in the left sidebar', working: true, task: 'Task', summaryAt: '2026-10-12T12:00:00Z',
    summary: { task: 'Fix schema', latest: 'Checking source readbacks', coordination: 'Asked the Web agent for requirements' }, stale: false }],
  usage: { date: '2026-10-12', calls: 2, failedCalls: 1, unknownUsageCalls: 1, runningCalls: 0,
    inputTokens: 10, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 3, totalTokens: 18 } });
function setup(data = snapshot(), openingTexts: Record<string, string> = {}) {
  vi.mocked(api.workers).mockResolvedValue(data); vi.mocked(api.refreshWorkers).mockResolvedValue(data);
  vi.mocked(api.workerOpeningMessage).mockImplementation(async id => ({ text: openingTexts[id] ?? data.workers.find(worker => worker.id === id)!.title, error: null }));
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
  expect(within(panel).getByText('CODEX: A very long conversation name that appears in the left sidebar', { exact: true })).toBeInTheDocument();
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
  const off = { ...snapshot(), enabled: false, trackingEnabled: false, pauseReason: 'manual' as const, workingCount: 0 };
  vi.mocked(api.setWorkerTracking).mockImplementation(async () => { vi.mocked(api.workers).mockResolvedValue(off); return off; });
  await userEvent.click(screen.getByRole('switch', { name: 'Worker tracking' }));
  await screen.findByText(/Worker tracking is off across all tabs/);
  expect(api.setWorkerTracking).toHaveBeenCalledWith(false);
  expect(screen.getByLabelText('Summaries every')).toBeDisabled();
  expect(screen.getByText(/Showing saved information from/)).toBeInTheDocument();
  expect(screen.getByText('Was working')).toBeInTheDocument();
  expect(screen.getByText('Checking source readbacks')).toBeInTheDocument();
  cleanup(); vi.mocked(api.refreshWorkers).mockClear();
  setup(off); await screen.findByText(/Worker tracking is off across all tabs/);
  expect(screen.getByRole('switch', { name: 'Worker tracking' })).toHaveAttribute('aria-checked', 'false');
  expect(api.refreshWorkers).not.toHaveBeenCalled();
  expect(screen.getByText('Checking source readbacks')).toBeInTheDocument();
});
it('explains automatic inactivity pause while keeping saved information visible', async () => {
  setup({ ...snapshot(), enabled: false, trackingEnabled: false, pauseReason: 'inactivity', workingCount: 0 });
  await screen.findByText(/automatically paused after 10 minutes/);
  expect(screen.getByText('Checking source readbacks')).toBeInTheDocument();
  expect(api.refreshWorkers).not.toHaveBeenCalled();
});

it('shows the full opening message rather than the shortened conversation label', async () => {
  const data = snapshot(); data.workers[0]!.title = 'An abbreviated opening…';
  const text = 'The complete opening message '.repeat(20) + 'including its final words.';
  setup(data, { one: text });
  expect(await screen.findByText(`CODEX: ${text}`, { exact: true })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Open conversation: CODEX: An abbreviated opening/ })).toBeInTheDocument();
});

it('expands one saved worker across the panel and collapses without a model request', async () => {
  const data = snapshot(); data.trackingEnabled = false; data.enabled = false; data.pauseReason = 'manual'; data.workingCount = 0;
  data.workers.push({ ...data.workers[0]!, id: 'two', projectName: 'Beta', title: 'Another worker' });
  setup(data);
  const expand = await screen.findByRole('button', { name: /Expand worker details: Alpha/ });
  await userEvent.click(expand);
  const collapse = screen.getByRole('button', { name: /Collapse worker details: Alpha/ });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  expect(screen.queryByRole('button', { name: /Expand worker details: Beta/ })).not.toBeInTheDocument();
  expect(screen.getByText('CODEX: A very long conversation name that appears in the left sidebar')).toBeInTheDocument();
  expect(screen.getByText('Assigned work:')).toBeInTheDocument();
  await userEvent.click(collapse);
  await waitFor(() => expect(screen.getByRole('button', { name: /Expand worker details: Alpha/ })).toHaveFocus());
  expect(screen.getByRole('button', { name: /Expand worker details: Beta/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Expand worker details: Alpha/ }));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: /Expand worker details: Alpha/ })).toHaveFocus());
  expect(api.refreshWorkers).not.toHaveBeenCalled();
});
