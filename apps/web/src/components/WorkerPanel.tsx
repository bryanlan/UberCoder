import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { useWorkerPanelWidth } from './useWorkerPanelWidth';

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
  const { panelRef, width, resizing, separatorProps } = useWorkerPanelWidth();
  const visible = useVisible();
  const client = useQueryClient();
  const [minutes, setMinutes] = useState(() => {
    const value = Number(localStorage.getItem('agent-console:worker-refresh-minutes') ?? 2);
    return [1, 2, 3, 4, 5].includes(value) ? value : 2;
  });
  const query = useQuery({ queryKey, queryFn: api.workers, enabled: visible, refetchInterval: visible ? 5000 : false, retry: false });
  const refresh = useMutation({ mutationFn: () => api.refreshWorkers(minutes),
    onSuccess: () => client.invalidateQueries({ queryKey }) });
  const tracking = useMutation({ mutationFn: (enabled: boolean) => api.setWorkerTracking(enabled),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (snapshot) => client.setQueryData(queryKey, snapshot),
    onSettled: () => client.invalidateQueries({ queryKey }) });
  const hasWorking = Boolean(query.data?.workingCount);
  const enabled = Boolean(query.data?.enabled) && !tracking.isPending;
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
      <aside ref={panelRef} style={{ '--worker-panel-width': `${width}px` } as CSSProperties}
        aria-label="Active workers" className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-[90vw] flex-col border-l border-slate-700 bg-slate-950 shadow-panel xl:relative xl:z-auto xl:w-[var(--worker-panel-width)] xl:max-w-none xl:shrink-0 xl:shadow-none">
        <div {...separatorProps} title="Drag to resize; double-click to reset"
          className={`absolute inset-y-0 left-0 z-40 hidden w-2 cursor-col-resize touch-none select-none border-l-2 transition-colors hover:border-sky-400 focus-visible:border-sky-400 focus-visible:outline-none xl:block ${resizing ? 'border-sky-400' : 'border-slate-700'}`} />
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-2xl font-medium text-slate-100">Workers <span className="text-lg text-slate-400">· {data && !data.trackingEnabled ? 'paused' : `${data?.workingCount ?? 0} working`}</span></h2>
          <button type="button" aria-label="Close worker panel" onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-100"><X size={27} /></button>
        </div>
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-lg text-slate-300">
          <span>Worker tracking</span>
          <button type="button" role="switch" aria-label="Worker tracking" aria-checked={Boolean(data?.trackingEnabled)}
            disabled={!data || tracking.isPending} onClick={() => tracking.mutate(!data?.trackingEnabled)}
            className="rounded border border-slate-700 bg-slate-900 px-3 py-1 disabled:opacity-50">
            {data?.trackingEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3 text-lg text-slate-300">
          <label htmlFor="worker-refresh">Summaries every</label>
          <select id="worker-refresh" value={minutes} disabled={!data?.trackingEnabled || tracking.isPending} onChange={(event) => setMinutes(Number(event.target.value))}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} minute{n === 1 ? '' : 's'}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto xl:flex xl:flex-col xl:overflow-hidden">
        <div className="min-h-0 flex-1 space-y-3 p-3 xl:overflow-y-auto">
          {(query.error || refresh.error) && <p role="status" className="text-lg text-amber-300">Worker updates are unavailable. Last known summaries may be out of date.</p>}
          {tracking.error && <p role="alert" className="text-lg text-amber-300">Unable to save worker tracking. Check the switch before leaving.</p>}
          {data?.error && <p role="status" className="text-lg text-amber-300">{data.error}</p>}
          {data?.generating && <p role="status" className="text-lg text-sky-300">{data.trackingEnabled ? 'Updating summaries…' : 'Stopping summary…'}</p>}
          {data && !data.trackingEnabled && <p className="text-lg text-slate-400">{data.pauseReason === 'inactivity'
            ? 'Worker tracking automatically paused after 10 minutes without a user message. It resumes when you submit a message.'
            : 'Worker tracking is off across all tabs. Evidence collection and new summaries are paused.'}</p>}
          {data && !data.trackingEnabled && <p className="text-lg text-slate-400">{data.snapshotAt
            ? `Showing saved information from ${new Date(data.snapshotAt).toLocaleString()}.`
            : 'No worker information has been saved yet.'}</p>}
          {data?.trackingEnabled && !data.workingCount && <p className="text-lg text-slate-400">No workers are running. Summaries are paused.</p>}
          {query.isLoading && <p className="text-lg text-slate-400">Loading workers…</p>}
          {data?.workers.map((worker) => (
            <article key={worker.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-lg">
                <span className="truncate font-medium text-slate-100" title={worker.projectName}>{worker.projectName}</span>
                <span className={`shrink-0 whitespace-nowrap ${data.trackingEnabled && worker.working ? 'text-emerald-400' : 'text-slate-400'}`}>{data.trackingEnabled
                  ? (worker.working ? 'Working' : 'Idle') : (worker.working ? 'Was working' : 'Was idle')}</span>
              </div>
              <Link to={`/projects/${encodeURIComponent(worker.projectSlug)}/${worker.provider}/${encodeURIComponent(worker.conversationRef)}`}
                title={`${worker.provider.toUpperCase()}: ${worker.title}`} onClick={() => { if (window.innerWidth < 1280) onClose(); }}
                className="mb-3 block truncate text-lg text-sky-300 hover:text-sky-100">
                {worker.provider.toUpperCase()}: {worker.title.length > 30 ? `${worker.title.slice(0, 30)}…` : worker.title}
              </Link>
              {[['Task', worker.summary?.task ?? worker.task], ['Latest', worker.summary?.latest ?? 'Latest action has not been summarized.'],
                ['Peers', worker.summary?.coordination ?? 'Coordination has not been summarized.']].map(([label, text]) => (
                <p key={label} title={text} className="break-words text-lg leading-9 text-slate-300 xl:truncate"><span className="text-slate-500">{label}: </span>{text}</p>
              ))}
              <p className={`mt-2 text-[15px] ${worker.stale ? 'text-amber-300' : 'text-slate-500'}`}>
                {worker.summaryAt ? `Summary ${new Date(worker.summaryAt).toLocaleTimeString()}` : 'Awaiting summary'}{worker.stale ? ' · out of date' : ''}
              </p>
            </article>
          ))}
        </div>
        {data && <div className="shrink-0 border-t border-slate-800 p-3 text-[15px] leading-[30px] text-slate-400">
          <p>Today (UTC) · {data.usage.calls} summary requests · {data.usage.failedCalls} failed</p>
          <p>{data.usage.totalTokens.toLocaleString()} known tokens · {data.usage.outputTokens.toLocaleString()} output</p>
          <p>{data.usage.inputTokens.toLocaleString()} uncached input · {(data.usage.cachedInputTokens + data.usage.cacheWriteTokens).toLocaleString()} cache</p>
          {data.usage.unknownUsageCalls > 0 && <p className="text-amber-300">Usage unavailable or pending for {data.usage.unknownUsageCalls} request{data.usage.unknownUsageCalls === 1 ? '' : 's'}.</p>}
        </div>}
        </div>
      </aside>
    </>
  );
}
