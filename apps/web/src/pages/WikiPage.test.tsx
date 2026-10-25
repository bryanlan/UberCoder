import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
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
  expect(write).toHaveBeenCalledWith('demo', { title: 'Home', body: '# Home\nSee [[Design]].\nNew context.', baseRevision: 7, summary: 'Expand', supersededBy: null }, 'csrf-test');
});

it('shows the replacement link and allows it to be edited without losing page text', async () => {
  const page = { title: 'Old procedure', body: 'Historical instructions.', revision: 9, summary: '', author: 'codex:one', checkout: '/repo', branch: 'main', headCommit: 'abc', createdAt: '2026-10-25T00:00:00Z', links: [], backlinks: [], supersededBy: 'Current procedure' };
  vi.spyOn(api, 'wikiList').mockResolvedValue({ pages: [], total: 0, nextOffset: null });
  vi.spyOn(api, 'wikiRead').mockImplementation(async (_slug, title) => ({ page: title === 'Old procedure' ? page : { ...page, title, supersededBy: null } }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/projects/demo/wiki?page=Old+procedure']}><WikiPage projectSlug="demo" projectName="Demo" /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('status')).toHaveTextContent('This page is superseded.');
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'Superseded by' })).toHaveValue('Current procedure');
  fireEvent.change(screen.getByRole('textbox', { name: 'Superseded by' }), { target: { value: 'Newest procedure' } });
  expect(screen.getByRole('textbox', { name: /Page text/ })).toHaveValue(page.body);
});

it.each([
  { initial: null, local: undefined, remote: 'Current procedure', expected: 'Current procedure' },
  { initial: 'Former replacement', local: undefined, remote: null, expected: null },
  { initial: null, local: 'My replacement', remote: 'Peer replacement', expected: 'My replacement' },
  { initial: 'Former replacement', local: '', remote: 'Peer replacement', expected: null },
])('merges replacement metadata after a conflict: %j', async ({ initial, local, remote, expected }) => {
  let stored = { title: 'Home', body: 'Original text.', revision: 7, summary: '', author: 'codex:one', checkout: '/repo', branch: 'main', headCommit: 'abc', createdAt: '2026-10-25T00:00:00Z', links: [], backlinks: [], supersededBy: initial };
  vi.spyOn(api, 'wikiList').mockResolvedValue({ pages: [], total: 0, nextOffset: null });
  vi.spyOn(api, 'wikiRead').mockImplementation(async () => ({ page: { ...stored } }));
  const write = vi.spyOn(api, 'wikiWrite').mockImplementation(async (_slug, input) => {
    if (input.baseRevision !== stored.revision) throw new ApiError('Wiki page changed.', { status: 409 });
    stored = { ...stored, body: input.body, supersededBy: input.supersededBy ?? null, revision: stored.revision + 1 };
    return { page: { ...stored } };
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/projects/demo/wiki']}><WikiPage projectSlug="demo" projectName="Demo" /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Page text/ }), { target: { value: 'Edited text.' } });
  if (local !== undefined) fireEvent.change(screen.getByRole('textbox', { name: 'Superseded by' }), { target: { value: local } });
  stored = { ...stored, revision: 8, supersededBy: remote };
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
  await screen.findByText('The latest page is revision 8. Your draft is still here.');
  expect(screen.getByRole('alert')).toHaveTextContent(`Latest replacement: ${remote ?? 'None (current guidance)'}`);
  expect(screen.getByRole('alert')).toHaveTextContent(`Your draft replacement: ${local === undefined ? initial ?? 'None (current guidance)' : local || 'None (current guidance)'}`);
  fireEvent.click(screen.getByRole('button', { name: 'I merged the changes; use this revision as the base' }));
  expect(screen.getByRole('textbox', { name: 'Superseded by' })).toHaveValue(expected ?? '');
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
  await waitFor(() => expect(stored.revision).toBe(9));
  expect(stored).toMatchObject({ body: 'Edited text.', supersededBy: expected });
  expect(write).toHaveBeenLastCalledWith('demo', { title: 'Home', body: 'Edited text.', summary: '', baseRevision: 8, supersededBy: expected }, undefined);
});
