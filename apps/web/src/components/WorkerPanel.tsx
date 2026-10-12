import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../lib/api';

const queryKey = ['workers'];
function useVisible() {
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function WorkerPanel({ onClose }: { onClose: () => void }) {
  const visible = useVisible();
  const client = useQueryClient();
  const [minutes, setMinutes] = useState(() => {
    const value = Number(localStorage.getItem('agent-console:worker-refresh-minutes') ?? 2);
    return [1, 2, 3, 4, 5].includes(value) ? value : 2;
  });
  const query = useQuery({ queryKey, queryFn: api.workers, enabled: visible, refetchInterval: visible ? 5000 : false, retry: false });
  const refresh = useMutation({ mutationFn: () => api.refreshWorkers(minutes),
    onSuccess: (snapshot) => client.setQueryData(queryKey, snapshot) });
  const hasWorking = Boolean(query.data?.workingCount);
  const enabled = Boolean(query.data?.enabled);
  const trigger = refresh.mutate;
  useEffect(() => {
    localStorage.setItem('agent-console:worker-refresh-minutes', String(minutes));
    if (!visible || !hasWorking || !enabled) return;
    trigger();
    const timer = setInterval(() => trigger(), minutes * 60_000);
    return () => clearInterval(timer);
  }, [visible, hasWorking, enabled, minutes, trigger]);
  const data = query.data;
  return (
    <>
      <button type="button" aria-label="Dismiss worker overlay" onClick={onClose}
        className="fixed inset-0 z-40 bg-black/50 xl:hidden" />
      <aside aria-label="Active workers" className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-[90vw] flex-col border-l border-slate-700 bg-slate-950 shadow-panel xl:static xl:z-auto xl:shrink-0 xl:shadow-none">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="font-medium text-slate-100">Workers <span className="text-xs text-slate-400">· {data?.workingCount ?? 0} working</span></h2>
          <button type="button" aria-label="Close worker panel" onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-100"><X size={18} /></button>
        </div>
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 text-xs text-slate-300">
          <label htmlFor="worker-refresh">Summaries every</label>
          <select id="worker-refresh" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} minute{n === 1 ? '' : 's'}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {(query.error || refresh.error) && <p role="status" className="text-xs text-amber-300">Worker updates are unavailable. Last known summaries may be out of date.</p>}
          {data?.error && <p role="status" className="text-xs text-amber-300">{data.error}</p>}
          {data?.generating && <p role="status" className="text-xs text-sky-300">Updating summaries…</p>}
          {data && !data.workingCount && <p className="text-xs text-slate-400">No workers are running. Summaries are paused.</p>}
          {data && !data.enabled && !data.error && <p className="text-xs text-slate-400">Summaries are disabled. Worker status still updates.</p>}
          {query.isLoading && <p className="text-xs text-slate-400">Loading workers…</p>}
          {data?.workers.map((worker) => (
            <article key={worker.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium text-slate-100" title={worker.projectName}>{worker.projectName}</span>
                <span className={worker.working ? 'text-emerald-400' : 'text-slate-400'}>{worker.working ? 'Working' : 'Idle'}</span>
              </div>
              <Link to={`/projects/${encodeURIComponent(worker.projectSlug)}/${worker.provider}/${encodeURIComponent(worker.conversationRef)}`}
                title={`${worker.provider.toUpperCase()}: ${worker.title}`} onClick={() => { if (window.innerWidth < 1280) onClose(); }}
                className="mb-3 block truncate text-xs text-sky-300 hover:text-sky-100">
                {worker.provider.toUpperCase()}: {worker.title.length > 30 ? `${worker.title.slice(0, 30)}…` : worker.title}
              </Link>
              {[['Task', worker.summary?.task ?? worker.task], ['Latest', worker.summary?.latest ?? 'Latest action has not been summarized.'],
                ['Peers', worker.summary?.coordination ?? 'Coordination has not been summarized.']].map(([label, text]) => (
                <p key={label} title={text} className="truncate text-xs leading-6 text-slate-300"><span className="text-slate-500">{label}: </span>{text}</p>
              ))}
              <p className={`mt-2 text-[10px] ${worker.stale ? 'text-amber-300' : 'text-slate-500'}`}>
                {worker.summaryAt ? `Summary ${new Date(worker.summaryAt).toLocaleTimeString()}` : 'Awaiting summary'}{worker.stale ? ' · out of date' : ''}
              </p>
            </article>
          ))}
        </div>
        {data && <div className="border-t border-slate-800 p-3 text-[10px] leading-5 text-slate-400">
          <p>Today (UTC) · {data.usage.calls} summary requests · {data.usage.failedCalls} failed</p>
          <p>{data.usage.totalTokens.toLocaleString()} known tokens · {data.usage.outputTokens.toLocaleString()} output</p>
          <p>{data.usage.inputTokens.toLocaleString()} uncached input · {(data.usage.cachedInputTokens + data.usage.cacheWriteTokens).toLocaleString()} cache</p>
          {data.usage.unknownUsageCalls > 0 && <p className="text-amber-300">Usage unavailable or pending for {data.usage.unknownUsageCalls} request{data.usage.unknownUsageCalls === 1 ? '' : 's'}.</p>}
        </div>}
      </aside>
    </>
  );
}
