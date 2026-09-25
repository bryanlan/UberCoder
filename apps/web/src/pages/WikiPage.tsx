import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { WikiPage as WikiPageData } from '@agent-console/shared';
import { api, ApiError } from '../lib/api';
import { renderMessageMarkdown } from '../features/conversation/markdown';

type Draft = { title: string; body: string; summary: string; baseRevision: number | null };

export function WikiPage({ projectSlug, projectName, csrfToken }: { projectSlug: string; projectName: string; csrfToken?: string }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const title = searchParams.get('page') || 'Home';
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState<number>();
  const [showHistory, setShowHistory] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [draft, setDraft] = useState<Draft>();
  const [newTitle, setNewTitle] = useState('');

  const list = useQuery({ queryKey: ['wiki-list', projectSlug, offset], queryFn: () => api.wikiList(projectSlug, offset) });
  const search = useQuery({ queryKey: ['wiki-search', projectSlug, searchTerm], queryFn: () => api.wikiSearch(projectSlug, searchTerm), enabled: Boolean(searchTerm) });
  const latest = useQuery({ queryKey: ['wiki-page', projectSlug, title], queryFn: () => api.wikiRead(projectSlug, title) });
  const old = useQuery({ queryKey: ['wiki-revision', projectSlug, title, revision], queryFn: () => api.wikiRead(projectSlug, title, revision), enabled: revision !== undefined });
  const history = useQuery({ queryKey: ['wiki-history', projectSlug, title, historyOffset], queryFn: () => api.wikiHistory(projectSlug, title, historyOffset), enabled: showHistory });
  const page = revision === undefined ? latest.data?.page : old.data?.page;

  const write = useMutation({
    mutationFn: (value: Draft) => api.wikiWrite(projectSlug, value, csrfToken),
    onSuccess: async (result) => {
      setDraft(undefined);
      setRevision(undefined);
      setSearchParams({ page: result.page.title });
      await queryClient.invalidateQueries({ queryKey: ['wiki-list', projectSlug] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-page', projectSlug, result.page.title] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-history', projectSlug, result.page.title] });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) await latest.refetch();
    },
  });

  function openPage(next: string) {
    setSearchParams({ page: next });
    setRevision(undefined);
    setDraft(undefined);
    setShowHistory(false);
    setHistoryOffset(0);
    write.reset();
  }

  function edit(value: WikiPageData | null, nextTitle = title) {
    setDraft({ title: nextTitle, body: value?.body ?? '', summary: '', baseRevision: latest.data?.page?.revision ?? null });
    write.reset();
  }

  return <section className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-100">
    <div className="border-b border-slate-800 px-5 py-4">
      <h1 className="text-xl font-semibold">{projectName} wiki</h1>
      <p className="text-sm text-slate-400">Shared pages for this Git repository. Edits keep their history and source revision.</p>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="overflow-auto border-b border-slate-800 p-4 lg:border-b-0 lg:border-r">
        <form onSubmit={(event) => { event.preventDefault(); setSearchTerm(searchInput.trim()); }} className="flex gap-2">
          <input aria-label="Search wiki" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search pages" className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm" />
          <button type="submit" className="rounded bg-slate-700 px-2 text-sm">Search</button>
        </form>
        {searchTerm && <div className="mt-4">
          <div className="mb-2 text-xs uppercase text-slate-400">Results for “{searchTerm}”</div>
          {search.isLoading && <p className="text-sm">Searching…</p>}
          {search.data?.results.length === 0 && <p className="text-sm text-slate-400">No pages found.</p>}
          <ul className="space-y-2">{search.data?.results.map((item) => <li key={item.title}><button onClick={() => openPage(item.title)} className="text-left text-sm text-sky-300 hover:underline">{item.title}</button><div className="line-clamp-2 text-xs text-slate-500">{item.snippet}</div></li>)}</ul>
        </div>}
        <div className="mt-5 mb-2 text-xs uppercase text-slate-400">Recent pages · {list.data?.total ?? 0}</div>
        {list.isError && <p role="alert" className="text-sm text-rose-300">Could not load pages.</p>}
        <ul className="space-y-1">{list.data?.pages.map((item) => <li key={item.title}><button onClick={() => openPage(item.title)} className="text-left text-sm text-sky-300 hover:underline">{item.title}</button><div className="text-xs text-slate-500">{new Date(item.updatedAt).toLocaleDateString()}</div></li>)}</ul>
        <div className="mt-3 flex gap-3 text-xs">
          {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 8))} className="text-sky-300">Previous</button>}
          {list.data?.nextOffset !== null && list.data?.nextOffset !== undefined && <button onClick={() => setOffset(list.data!.nextOffset!)} className="text-sky-300">More</button>}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (newTitle.trim()) { openPage(newTitle.trim()); setNewTitle(''); } }} className="mt-6 space-y-2 border-t border-slate-800 pt-4">
          <label htmlFor="wiki-new-title" className="text-xs text-slate-400">Open or create a page</label>
          <input id="wiki-new-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm" />
          <button type="submit" className="rounded bg-slate-700 px-3 py-1 text-sm">Open</button>
        </form>
      </aside>
      <div className="min-h-0 overflow-auto p-5 lg:p-8">
        {(latest.isLoading || (revision !== undefined && old.isLoading)) && <p>Loading page…</p>}
        {(latest.isError || old.isError) && <p role="alert" className="text-rose-300">Could not load this page.</p>}
        {!draft && !latest.isLoading && !latest.isError && <>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
            <div><h2 className="text-2xl font-semibold">{page?.title ?? title}</h2>
              {page && <p className="mt-1 text-xs text-slate-400">Revision {page.revision} · {page.author} · {new Date(page.createdAt).toLocaleString()} · {page.branch ?? 'detached'} @ {page.headCommit?.slice(0, 12) ?? 'unknown commit'}</p>}
            </div>
            <div className="flex gap-3 text-sm text-sky-300">
              <button onClick={() => edit(page ?? null)}>{page ? 'Edit' : 'Create page'}</button>
              {latest.data?.page && <button onClick={() => setShowHistory((value) => !value)}>History</button>}
            </div>
          </div>
          {revision !== undefined && <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/30 p-3 text-sm">Viewing an older revision. <button onClick={() => setRevision(undefined)} className="text-sky-300">Show latest</button> · <button onClick={() => edit(page ?? null)} className="text-sky-300">Restore by editing</button></div>}
          {page ? <>
            <article className="max-w-4xl break-words leading-7 text-slate-200">{renderMessageMarkdown(page.body, (target, label, key) => <button key={key} onClick={() => openPage(target)} className="text-sky-300 underline underline-offset-2">{label}</button>)}</article>
            {page.backlinks.length > 0 && <div className="mt-8 border-t border-slate-800 pt-3 text-sm text-slate-400">Linked from: {page.backlinks.map((link, index) => <span key={link}>{index > 0 && ', '}<button onClick={() => openPage(link)} className="text-sky-300">{link}</button></span>)}</div>}
          </> : <p className="text-slate-400">This page does not exist yet. Create it or follow a link to another page.</p>}
          {showHistory && <div className="mt-8 border-t border-slate-800 pt-4"><h3 className="mb-2 font-semibold">Revision history</h3><ul className="space-y-2 text-sm">{history.data?.revisions.map((item) => <li key={item.revision}><button onClick={() => setRevision(item.revision)} className="text-sky-300">Revision {item.revision}</button> · {item.author} · {new Date(item.createdAt).toLocaleString()} {item.summary && `· ${item.summary}`}</li>)}</ul>
            <div className="mt-3 flex gap-3 text-xs">{historyOffset > 0 && <button onClick={() => setHistoryOffset(Math.max(0, historyOffset - 10))} className="text-sky-300">Newer</button>}{history.data?.nextOffset !== null && history.data?.nextOffset !== undefined && <button onClick={() => setHistoryOffset(history.data!.nextOffset!)} className="text-sky-300">Older</button>}</div>
          </div>}
        </>}
        {draft && <form onSubmit={(event) => { event.preventDefault(); write.mutate(draft); }} className="max-w-4xl space-y-4">
          <h2 className="text-xl font-semibold">Edit {draft.title}</h2>
          <label className="block text-sm">Page text <span className="text-slate-400">(Markdown and [[wiki links]])</span>
            <textarea aria-label="Page text" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={18} className="mt-2 w-full rounded border border-slate-700 bg-slate-900 p-3 font-mono text-sm" />
          </label>
          <label className="block text-sm">Edit summary
            <input aria-label="Edit summary" value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} className="mt-2 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm" />
          </label>
          {write.error && <div role="alert" className="rounded border border-rose-700/50 p-3 text-sm text-rose-200">{write.error.message}{write.error instanceof ApiError && write.error.status === 409 && latest.data?.page && <div className="mt-2">
            <p>The latest page is revision {latest.data.page.revision}. Your draft is still here.</p>
            <details className="my-2"><summary className="cursor-pointer text-sky-300">Read the latest text</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-3">{latest.data.page.body}</pre></details>
            <button type="button" onClick={() => { setDraft({ ...draft, baseRevision: latest.data!.page!.revision }); write.reset(); }} className="text-sky-300">I merged the changes; use this revision as the base</button>
          </div>}</div>}
          <div className="flex gap-4"><button disabled={write.isPending} type="submit" className="rounded bg-sky-700 px-4 py-2 text-sm disabled:opacity-50">Save revision</button><button type="button" onClick={() => setDraft(undefined)} className="text-sm text-slate-300">Cancel</button></div>
        </form>}
      </div>
    </div>
  </section>;
}
