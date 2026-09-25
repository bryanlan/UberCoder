import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { WikiPage } from './WikiPage';

afterEach(() => vi.restoreAllMocks());

it('shows linked pages and sends an edit with the revision it read', async () => {
  vi.spyOn(api, 'wikiList').mockResolvedValue({ pages: [{ title: 'Home', revision: 7, updatedAt: '2026-09-24T00:00:00Z', author: 'codex:one', summary: '' }], total: 1, nextOffset: null });
  let stored = {
    title: 'Home', body: '# Home\nSee [[Design]].', revision: 7, summary: '', author: 'codex:one',
    checkout: '/repo', branch: 'main', headCommit: 'abc1234567890', createdAt: '2026-09-24T00:00:00Z', links: ['Design'], backlinks: [],
  };
  vi.spyOn(api, 'wikiRead').mockImplementation(async () => ({ page: stored }));
  const write = vi.spyOn(api, 'wikiWrite').mockImplementation(async () => {
    stored = { ...stored, body: '# Home\nSee [[Design]].\nNew context.', revision: 8, summary: 'Expand', author: 'user:test' };
    return { page: stored };
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/projects/demo/wiki']}><WikiPage projectSlug="demo" projectName="Demo" csrfToken="csrf-test" /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('button', { name: 'Design' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Page text/ }), { target: { value: '# Home\nSee [[Design]].\nNew context.' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit summary' }), { target: { value: 'Expand' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
  await screen.findByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes('New context.')));
  expect(write).toHaveBeenCalledWith('demo', { title: 'Home', body: '# Home\nSee [[Design]].\nNew context.', baseRevision: 7, summary: 'Expand' }, 'csrf-test');
});
