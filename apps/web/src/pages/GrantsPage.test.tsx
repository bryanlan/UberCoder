import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentGrant } from '@agent-console/shared';
import { api } from '../lib/api';
import { GrantsPage } from './GrantsPage';

afterEach(() => vi.restoreAllMocks());
const pending: AgentGrant = { id:'request-one',createdByAssignmentId:'planner-lead',requesterName:'Planner lead',granteeName:'Planner project',
  grantee:{kind:'project',id:'planner'},status:'pending',scope:'Do whatever is needed for the planner overnight.',actions:['launch_session','restart_session'],
  projectSlugs:[],limits:{maxConcurrentSessions:null,models:[]},expiry:{kind:'until_revoked'},createdAt:'2026-10-13T00:00:00Z',reason:'Need helpers to finish.' };
function mount(grants: AgentGrant[]) {
  vi.spyOn(api,'grants').mockResolvedValue({grants,uses:[],nextUseOffset:null});
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/grants']}><GrantsPage csrfToken="current-csrf" backHref="/" /></MemoryRouter></QueryClientProvider>);
}
it('lets Bryan edit a broad request and approve its scope and practical limits',async()=>{
  const decide=vi.spyOn(api,'decideGrant').mockResolvedValue({grant:{...pending,status:'active'}});mount([pending]);
  fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  fireEvent.change(screen.getByLabelText('Scope',{exact:true}),{target:{value:'Complete Phase 1 with any needed helpers.'}});
  fireEvent.change(screen.getByLabelText('Concurrent sessions'),{target:{value:'3'}});
  fireEvent.click(screen.getByRole('button',{name:'Approve edited grant'}));
  await waitFor(()=>expect(decide).toHaveBeenCalledWith('request-one','approve',expect.objectContaining({scope:'Complete Phase 1 with any needed helpers.',limits:{maxConcurrentSessions:3,models:[]}}),'current-csrf'));
});
it('offers denial for requests and one-click revoke for immediately activated grants',async()=>{
  const decide=vi.spyOn(api,'decideGrant').mockResolvedValue({grant:{...pending,status:'denied'}}), revoke=vi.spyOn(api,'revokeGrant').mockResolvedValue({grant:{...pending,status:'revoked'}});
  mount([pending,{...pending,id:'active-one',status:'active',provenance:{kind:'human_message',quote:'I authorize all necessary planner work.',messageId:'live:one:0',sessionId:'one'}}]);
  fireEvent.click(await screen.findByRole('button',{name:'Deny'}));await waitFor(()=>expect(decide).toHaveBeenCalledWith('request-one','deny',undefined,'current-csrf'));
  fireEvent.click(screen.getByRole('button',{name:'Revoke'}));await waitFor(()=>expect(revoke).toHaveBeenCalledWith('active-one','current-csrf'));
  expect(screen.getAllByRole('button',{name:'Approve'})).toHaveLength(1);
});
