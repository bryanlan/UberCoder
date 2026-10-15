import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { AgentGrant, AgentGrantDefinition } from '@agent-console/shared';
import { api } from '../lib/api';

const button = 'rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = `${button} border-sky-500 bg-sky-600 text-white hover:bg-sky-500`;
const actionLabels = { launch_session: 'Launch sessions', restart_session: 'Restart sessions', close_session: 'Close owned sessions' };
const definitionOf = (g: AgentGrant): AgentGrantDefinition => ({ grantee: g.grantee, actions: g.actions, scope: g.scope, projectSlugs: g.projectSlugs, limits: g.limits, expiry: g.expiry });

export function GrantsPage({ csrfToken, backHref }: { csrfToken?: string; backHref: string }) {
  const cache = useQueryClient(); const [params] = useSearchParams();
  const [useOffset, setUseOffset] = useState(0), [edit, setEdit] = useState<{ id: string; definition: AgentGrantDefinition }>();
  const [pushState, setPushState] = useState<string>();
  const list = useQuery({ queryKey: ['grants', useOffset], queryFn: () => api.grants(useOffset), refetchInterval: 5000 });
  const [queueNotice, setQueueNotice] = useState<string>();
  const queue = useQuery({ queryKey: ['session-requests'], queryFn: api.sessionRequests, refetchInterval: 5000 });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelSessionRequest(id, csrfToken),
    onSuccess: result => { setQueueNotice(result.cancelled ? 'Request cancelled.' : result.reason); void cache.invalidateQueries({ queryKey: ['session-requests'] }); } });
  const change = useMutation({ mutationFn: async ({ id, action, definition }: { id: string; action: 'approve' | 'deny' | 'revoke'; definition?: AgentGrantDefinition }) =>
    action === 'revoke' ? api.revokeGrant(id, csrfToken) : api.decideGrant(id, action, definition, csrfToken),
    onSuccess: () => { setEdit(undefined); void cache.invalidateQueries({ queryKey: ['grants'] }); } });
  async function enablePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push notifications.');
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are not enabled.');
      const existing = await navigator.serviceWorker.getRegistration();
      if (!existing) throw new Error('Open the Console’s HTTPS address to enable notifications.');
      const registration = await navigator.serviceWorker.ready, { publicKey } = await api.grantPushKey();
      const decoded = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const key = new Uint8Array(decoded.length); for (let i = 0; i < decoded.length; i++) key[i] = decoded.charCodeAt(i);
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api.subscribeGrantPush(subscription.toJSON(), csrfToken); setPushState('Permission requests will notify this browser.');
    } catch (error) { setPushState(error instanceof Error ? error.message : 'Could not enable notifications.'); }
  }
  const grants = list.data?.grants ?? [];
  return <div className="h-full overflow-y-auto p-4 lg:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-slate-100">Agent grants</h1><p className="mt-1 text-sm text-slate-400">Give agents enough permission to keep working. Broad grants remain active until their chosen expiry or revocation.</p></div>
      <div className="flex gap-2"><button className={button} onClick={() => void enablePush()}>Enable notifications</button><Link className={button} to={backHref}>Back to Console</Link></div>
    </div>
    {queueNotice && <p role="status" className="mb-4 text-sm text-slate-300">{queueNotice}</p>}
    {(queue.error || cancel.error) && <p role="alert" className="mb-4 text-rose-300">{(queue.error ?? cancel.error)?.message}</p>}
    {!!queue.data?.requests.length && <section className="mb-6 space-y-2" aria-label="Session requests">
      <h2 className="font-semibold text-slate-100">Session requests</h2>
      <p className="text-sm text-slate-400">Available memory: {queue.data.availableBytes === undefined ? 'unknown' : `${Math.floor(queue.data.availableBytes / 1024 ** 2)} MiB`} · Launch requirement: {Math.ceil(queue.data.requiredBytes / 1024 ** 2)} MiB</p>
      {queue.data.requests.map(request => <article key={request.id} className="rounded-lg border border-slate-700 p-3">
        <p className="text-slate-100">{request.title ?? request.action.replace('_session', '')} · {request.status}</p>
        {request.reason && <p className="text-sm text-slate-400">{request.reason}</p>}
        {request.status === 'queued' && <button className={button} disabled={cancel.isPending} onClick={() => cancel.mutate(request.id)}>Cancel request</button>}
      </article>)}
    </section>}
    {pushState && <p role="status" className="mb-4 text-sm text-slate-300">{pushState}</p>}
    {(change.error || list.error) && <p role="alert" className="mb-4 text-rose-300">{(change.error ?? list.error)?.message}</p>}
    {list.isLoading && <p className="text-slate-400">Loading grants…</p>}
    {!list.isLoading && !grants.length && <p className="text-slate-400">No grants yet. Authorize work in a conversation, or approve an agent request here.</p>}
    <div className="space-y-3">{grants.map(grant => <article key={grant.id} id={`grant-${grant.id}`} data-testid="grant-card"
      className={`rounded-xl border p-4 ${params.get('request') === grant.id ? 'border-sky-500' : 'border-slate-700'} bg-slate-900/60`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-slate-800 px-2 py-0.5 text-xs capitalize text-slate-300">{grant.status}</span><span className="text-sm text-slate-300">{grant.requesterName}</span></div>
        <p className="mt-2 whitespace-pre-wrap text-slate-100">{grant.scope}</p>
        {grant.reason && <p className="mt-2 text-sm text-slate-400">{grant.reason}</p>}
        <p className="mt-2 text-xs text-slate-400">{grant.actions.map(action => actionLabels[action]).join(' · ')} · {grant.granteeName} · {grant.limits.maxConcurrentSessions ? `${grant.limits.maxConcurrentSessions} concurrent sessions` : 'Concurrency follows available memory'} · {grant.limits.models.length ? grant.limits.models.join(', ') : 'Any model'} · {grant.expiry.kind === 'until_revoked' ? 'Until revoked' : 'Until parent assignment finishes'}</p>
        {grant.provenance && <details className="mt-2 text-xs text-slate-400"><summary>{grant.provenance.kind === 'human_message' ? 'Bryan’s recorded words' : 'Bryan’s approval'}</summary><p className="mt-1 whitespace-pre-wrap">{grant.provenance.quote}</p></details>}
      </div><div className="flex flex-wrap gap-2">
        {grant.status === 'pending' && <><button className={primary} disabled={change.isPending} onClick={() => change.mutate({ id: grant.id, action: 'approve' })}>Approve</button><button className={button} onClick={() => setEdit({ id: grant.id, definition: definitionOf(grant) })}>Edit</button><button className={button} disabled={change.isPending} onClick={() => change.mutate({ id: grant.id, action: 'deny' })}>Deny</button></>}
        {grant.status === 'active' && <button className={button} disabled={change.isPending} onClick={() => change.mutate({ id: grant.id, action: 'revoke' })}>Revoke</button>}
      </div></div>
      {edit?.id === grant.id && <form className="mt-4 space-y-3 border-t border-slate-700 pt-4" onSubmit={event => { event.preventDefault(); change.mutate({ id: grant.id, action: 'approve', definition: edit.definition }); }}>
        <label className="block text-sm text-slate-300">Scope<textarea aria-label="Scope" className="mt-1 min-h-28 w-full rounded border border-slate-600 bg-slate-950 p-2" value={edit.definition.scope} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, scope: event.target.value } })} /></label>
        <div className="flex flex-wrap gap-3">{(['launch_session', 'restart_session', 'close_session'] as const).map(action => <label key={action} className="text-sm text-slate-300"><input type="checkbox" className="mr-2" checked={edit.definition.actions.includes(action)} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, actions: event.target.checked ? [...edit.definition.actions, action] : edit.definition.actions.filter(value => value !== action) } })} />{actionLabels[action]}</label>)}</div>
        <label className="block text-sm text-slate-300">Projects (blank means all configured projects)<input className="ml-2 rounded border border-slate-600 bg-slate-950 p-1" value={edit.definition.projectSlugs.join(', ')} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, projectSlugs: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } })} /></label>
        <div className="flex flex-wrap gap-4"><label className="text-sm text-slate-300">Concurrent sessions<input aria-label="Concurrent sessions" type="number" min="1" placeholder="Memory allows" className="ml-2 w-28 rounded border border-slate-600 bg-slate-950 p-1" value={edit.definition.limits.maxConcurrentSessions ?? ''} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, limits: { ...edit.definition.limits, maxConcurrentSessions: event.target.value ? Number(event.target.value) : null } } })} /></label>
          <label className="text-sm text-slate-300">Models<input aria-label="Models" placeholder="Any model" className="ml-2 rounded border border-slate-600 bg-slate-950 p-1" value={edit.definition.limits.models.join(', ')} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, limits: { ...edit.definition.limits, models: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } } })} /></label>
          <label className="text-sm text-slate-300">Expiry<select className="ml-2 rounded border border-slate-600 bg-slate-950 p-1" value={edit.definition.expiry.kind} onChange={event => setEdit({ ...edit, definition: { ...edit.definition, expiry: { kind: event.target.value as AgentGrantDefinition['expiry']['kind'], assignmentId: grant.createdByAssignmentId } } })}><option value="until_revoked">Until revoked</option><option value="assignment_finished">Until parent finishes</option></select></label>
        </div><div className="flex gap-2"><button className={primary} disabled={change.isPending} type="submit">Approve edited grant</button><button className={button} type="button" onClick={() => setEdit(undefined)}>Cancel</button></div>
      </form>}
    </article>)}</div>
    <h2 className="mb-3 mt-7 text-lg font-medium text-slate-100">Uses</h2>
    <div className="space-y-2">{list.data?.uses.map(use => <div key={use.id} className="rounded-lg border border-slate-700 p-3 text-sm text-slate-300"><span>{actionLabels[use.action]} · {use.assignmentId.slice(0, 8)} · {new Date(use.timestamp).toLocaleString()}</span><p className="mt-1 text-xs text-slate-400">{String(use.detail.description ?? use.detail.status ?? 'Recorded use')}{use.detail.reason ? ` · ${String(use.detail.reason)}` : ''}</p></div>)}</div>
    {!list.data?.uses.length && <p className="text-sm text-slate-500">No uses recorded.</p>}
    <div className="mt-3 flex gap-2">{useOffset > 0 && <button className={button} onClick={() => setUseOffset(Math.max(0, useOffset - 100))}>Newer uses</button>}{list.data?.nextUseOffset !== null && list.data?.nextUseOffset !== undefined && <button className={button} onClick={() => setUseOffset(list.data!.nextUseOffset!)}>Older uses</button>}</div>
  </div>;
}
