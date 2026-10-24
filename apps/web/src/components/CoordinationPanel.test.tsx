import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CoordinationPanel } from './CoordinationPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('labels peer messages separately and distinguishes runtime supply from acknowledgement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: true,
    pendingMessageCount: 1,
    assignments: [{ id: 'a', provider: 'codex', description: 'Validation work', status: 'active' }, { id: 'b', provider: 'claude', description: 'Engine fix', status: 'disconnected' }],
    scopes: [], events: [],
    messages: [{ id: 'm', senderId: 'a', recipientId: 'b', text: 'Please review the interface.', createdAt: '2026-09-09T12:00:00Z', suppliedAt: '2026-09-09T12:00:01Z', acknowledgedAt: null }],
  }) }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByText('Coordination messages')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/assignment-activity?checkout=%2Frepo', { credentials: 'include' });
  expect(screen.getByText(/Offered to runtime; awaiting acknowledgement/)).toBeInTheDocument();
  expect(screen.getByText(/files and Git operations are not locked/)).toBeInTheDocument();
  expect(screen.getByText(/1 assignments/)).toBeInTheDocument();
  expect(screen.getByText(/codex: Validation work → claude: Engine fix/)).toBeInTheDocument();
});

it('uses the complete pending count even when displayed history is shorter', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: true, pendingMessageCount: 61,
    assignments: [], scopes: [], events: [], messages: [],
  }) }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByText(/61 messages awaiting acknowledgement/)).toBeInTheDocument();
});

it('keeps adjacent draft input mounted when an activity request fails during an upgrade', async () => {
  let respond!: (response: { ok: boolean; status: number }) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => { respond = resolve; })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <textarea aria-label="Draft message" />
    <CoordinationPanel checkout="/repo" />
  </QueryClientProvider>);
  const draft = screen.getByRole('textbox', { name: 'Draft message' });
  fireEvent.change(draft, { target: { value: 'Keep this unsent message' } });
  await act(async () => { respond({ ok: false, status: 404 }); });
  expect(await screen.findByRole('status')).toHaveTextContent('Coordination is unavailable');
  expect(screen.getByRole('textbox', { name: 'Draft message' })).toBe(draft);
  expect(draft).toHaveValue('Keep this unsent message');
});


it('defines unattended permission and alerts only after repeated continuation failure', async () => {
  const assignment = { id: 'a', provider: 'codex', description: 'Unfinished authorized work', status: 'disconnected',
    continuation: 'unattended', supervisorId: null,
    recovery: { status: 'stalled', attempts: 3, reason: 'Three automatic continuations ended without progress.', nextAttemptAt: '2026-10-12T20:00:00Z' } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: true, pendingMessageCount: 0, assignments: [assignment], scopes: [], events: [], messages: [],
  }) }));
  render(<QueryClientProvider client={new QueryClient()}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByText(/Unattended continuation enabled/)).toBeInTheDocument();
  expect(screen.getByText(/It grants no new permissions/)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('3/3 continuations');
});

it('shows task acceptance, evidence, owner and required action on the worker board', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: true, pendingMessageCount: 0, scopes: [], events: [], messages: [],
    assignments: [{ id: 'a', provider: 'codex', description: 'Delivery repair', status: 'active', continuation: 'unattended', supervisorId: null,
      task: { ownerId: 'a', deliverable: 'Repair worker dispatch', doneWhen: 'Native proof accepted', evidencePath: 'docs/proof.md', state: 'blocked', actionNeeded: 'Provide the test build', revision: 2, updatedAt: '2026-10-24T20:00:00Z' } }],
  }) }));
  render(<QueryClientProvider client={new QueryClient()}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByLabelText('Worker task')).toHaveTextContent('Repair worker dispatch');
  expect(screen.getByText('Done when: Native proof accepted')).toBeInTheDocument();
  expect(screen.getByText('Evidence: docs/proof.md')).toBeInTheDocument();
  expect(screen.getByText('Action needed: Provide the test build')).toBeInTheDocument();
  expect(screen.getByText(/Owner: codex: Delivery repair/)).toBeInTheDocument();
});
