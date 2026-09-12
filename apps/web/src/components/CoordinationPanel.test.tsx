import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CoordinationPanel } from './CoordinationPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('labels peer messages separately and distinguishes runtime supply from acknowledgement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: true,
    assignments: [{ id: 'a', provider: 'codex', description: 'Validation work', status: 'active' }, { id: 'b', provider: 'claude', description: 'Engine fix', status: 'disconnected' }],
    scopes: [], events: [], claims: [{ assignmentId: 'b', checkout: '/repo', path: 'engine.ts' }],
    messages: [{ id: 'm', senderId: 'a', recipientId: 'b', text: 'Please review the interface.', createdAt: '2026-09-09T12:00:00Z', suppliedAt: '2026-09-09T12:00:01Z', acknowledgedAt: null }],
  }) }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByText('Peer messages')).toBeInTheDocument();
  expect(screen.getByText(/Offered to runtime; awaiting acknowledgement/)).toBeInTheDocument();
  expect(screen.getByText(/unfinished changes need reconciliation/)).toBeInTheDocument();
  expect(screen.getByText(/codex: Validation work → claude: Engine fix/)).toBeInTheDocument();
});

it('shows failure instead of claiming no other work exists', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoordinationPanel checkout="/repo" /></QueryClientProvider>);
  expect(await screen.findByRole('status')).toHaveTextContent('Coordination is unavailable');
});
