import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BoundSession, TreeResponse } from '@agent-console/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

afterEach(() => vi.restoreAllMocks());

const now = Date.parse('2026-09-27T23:00:00.000Z');
const cases = (['manualSuspendedAt', 'pressureSuspendedAt'] as const).flatMap((marker) => (
  [
    { hours: 0.5, color: 'bg-emerald-400' },
    { hours: 2, color: 'bg-yellow-400' },
    { hours: 24, color: 'bg-amber-500' },
    { hours: 72, color: 'bg-violet-500' },
  ].map((age) => ({ marker, ...age }))
));

it.each(cases)('preserves $color for a $marker session with a $hours-hour-old response', ({ marker, hours, color }) => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const responseAt = new Date(now - hours * 60 * 60 * 1000).toISOString();
  const session: BoundSession = {
    id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'conversation-1',
    tmuxSessionName: 'ac-codex-demo', status: 'bound', shouldRestore: true,
    startedAt: responseAt, updatedAt: new Date(now).toISOString(),
    lastResponseAt: responseAt, lastActivityAt: responseAt, isWorking: false,
    [marker]: new Date(now).toISOString(),
  };
  const tree: TreeResponse = {
    boundSessions: [session],
    projects: [{
      slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
      tags: [], allowedLocalhostPorts: [],
      providers: {
        codex: { id: 'codex', label: 'Codex', conversations: [{
          ref: session.conversationRef, projectSlug: 'demo', provider: 'codex',
          kind: 'history', title: 'Resume this conversation', updatedAt: responseAt,
          isBound: true, degraded: false,
        }] },
        claude: { id: 'claude', label: 'Claude', conversations: [] },
      },
    }],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['network-info'], {});
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar
          tree={tree} open workMode recentActivitySortEnabled={false} manualProjectOrder={[]}
          onClose={() => {}} onToggleWorkMode={() => {}} onNewConversation={() => {}}
          onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
          onRenameProject={async () => true} onRebindConversation={async () => true}
          onRenameConversation={async () => true} updatingUiPreferences={false}
          onRefresh={() => {}} refreshing={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const row = screen.getByRole('link', { name: /Resume this conversation/ });
  const dot = within(row).getByTitle(/Ready for you · response/);
  expect(dot).toHaveClass(color);
  expect(dot).not.toHaveClass('bg-transparent');
  expect(dot).toHaveAttribute('title', expect.stringContaining('select to resume'));
  expect(within(row).getByText('Suspended')).toBeInTheDocument();
});
