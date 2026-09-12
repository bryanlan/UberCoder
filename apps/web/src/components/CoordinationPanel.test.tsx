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
  expect(await screen.findByText('Peer messages')).toBeInTheDocument();
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
