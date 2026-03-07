import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Menu, PanelLeftClose, Settings, X } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes, matchPath, useLocation, useNavigate } from 'react-router-dom';
import type { ProviderId, SessionEvent } from '@agent-console/shared';
import { api, ApiError } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';

function useLocalStorageBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    const stored = globalThis.localStorage?.getItem(key);
    return stored ? stored === 'true' : fallback;
  });
  useEffect(() => {
    globalThis.localStorage?.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue] as const;
}

function AppShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useLocalStorageBoolean('agent-console:nav-open', false);
  const [debugOpen, setDebugOpen] = useLocalStorageBoolean('agent-console:debug-open', false);
  const [eventError, setEventError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [creatingConversationKey, setCreatingConversationKey] = useState<string>();
  const realtimeDegraded = Boolean(eventError);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: api.authState, retry: false });
  const treeQuery = useQuery({
    queryKey: ['tree'],
    queryFn: api.tree,
    enabled: authQuery.data?.authenticated,
    refetchInterval: authQuery.data?.authenticated && realtimeDegraded ? 5000 : false,
  });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings, enabled: authQuery.data?.authenticated && location.pathname === '/settings' });

  const selection = matchPath('/projects/:projectSlug/:provider/:conversationRef', location.pathname);
  const selectedProjectSlug = selection?.params.projectSlug;
  const selectedProvider = selection?.params.provider as ProviderId | undefined;
  const selectedConversationRef = selection?.params.conversationRef ? decodeURIComponent(selection.params.conversationRef) : undefined;

  const timelineQuery = useQuery({
    queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
    queryFn: () => api.timeline(selectedProjectSlug!, selectedProvider!, selectedConversationRef!),
    enabled: Boolean(authQuery.data?.authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef),
    refetchInterval: (query) => query.state.data?.boundSession ? 2000 : realtimeDegraded ? 5000 : false,
  });

  useEffect(() => {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef || !timelineQuery.data?.conversation.ref) return;
    if (timelineQuery.data.conversation.ref === selectedConversationRef) return;
    navigate(
      `/projects/${encodeURIComponent(selectedProjectSlug)}/${selectedProvider}/${encodeURIComponent(timelineQuery.data.conversation.ref)}`,
      { replace: true },
    );
  }, [navigate, selectedConversationRef, selectedProjectSlug, selectedProvider, timelineQuery.data?.conversation.ref]);

  const rawOutputQuery = useQuery({
    queryKey: ['raw-output', timelineQuery.data?.boundSession?.id],
    queryFn: () => api.rawOutput(timelineQuery.data!.boundSession!.id),
    enabled: Boolean(debugOpen && timelineQuery.data?.boundSession?.id),
    refetchInterval: timelineQuery.data?.boundSession ? 2000 : false,
  });

  useEffect(() => {
    if (!authQuery.data?.authenticated) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as SessionEvent;
        setEventError(undefined);
        if (parsed.type === 'heartbeat') {
          return;
        }
        if (parsed.type === 'session.raw-output') {
          if (parsed.sessionId === timelineQuery.data?.boundSession?.id) {
            queryClient.invalidateQueries({ queryKey: ['raw-output', parsed.sessionId] });
          }
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['tree'] });
        if (selection?.params.conversationRef) {
          queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
        }
      } catch {
        setEventError('Lost event stream parsing. Refresh to recover.');
      }
    };
    source.onerror = () => {
      setEventError('Realtime connection dropped. The page is still usable and polling the project tree and selected conversation.');
    };
    return () => source.close();
  }, [authQuery.data?.authenticated, queryClient, selection?.params.conversationRef, selectedConversationRef, selectedProjectSlug, selectedProvider, timelineQuery.data?.boundSession?.id]);

  function describeError(error: unknown, fallback: string): string {
    return error instanceof ApiError ? error.message : fallback;
  }

  const loginMutation = useMutation({
    mutationFn: api.login,
    onSuccess: () => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/');
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshTree(authQuery.data?.csrfToken),
    onSuccess: (data) => {
      setActionError(undefined);
      queryClient.setQueryData(['tree'], data);
    },
  });

  const bindExistingMutation = useMutation({
    mutationFn: () => api.bindConversation(selectedProjectSlug!, selectedProvider!, selectedConversationRef!, authQuery.data?.csrfToken),
    onSuccess: () => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
    },
  });

  const bindNewMutation = useMutation({
    mutationFn: ({ projectSlug, provider }: { projectSlug: string; provider: ProviderId }) => api.bindNewConversation(projectSlug, provider, authQuery.data?.csrfToken),
    onSuccess: ({ conversationRef }, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      navigate(`/projects/${encodeURIComponent(variables.projectSlug)}/${variables.provider}/${encodeURIComponent(conversationRef)}`);
      setNavOpen(false);
    },
    onSettled: () => {
      setCreatingConversationKey(undefined);
    },
  });

  const releaseMutation = useMutation({
    mutationFn: (sessionId: string) => api.releaseSession(sessionId, authQuery.data?.csrfToken),
    onSuccess: () => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
    },
  });

  const sendMutation = useMutation({
    mutationFn: ({ sessionId, text }: { sessionId: string; text: string }) => api.sendInput(sessionId, text, authQuery.data?.csrfToken),
    onSuccess: () => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
      if (timelineQuery.data?.boundSession?.id) {
        queryClient.invalidateQueries({ queryKey: ['raw-output', timelineQuery.data.boundSession.id] });
      }
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(authQuery.data?.csrfToken),
    onSuccess: () => {
      queryClient.removeQueries();
      navigate('/login');
    },
  });

  const project = useMemo(() => treeQuery.data?.projects.find((item) => item.slug === selectedProjectSlug), [selectedProjectSlug, treeQuery.data?.projects]);

  async function handleRefresh(): Promise<void> {
    setActionError(undefined);
    try {
      await refreshMutation.mutateAsync();
    } catch (error) {
      setActionError(describeError(error, 'Unable to refresh the project tree.'));
    }
  }

  async function handleBindExisting(): Promise<void> {
    setActionError(undefined);
    try {
      await bindExistingMutation.mutateAsync();
    } catch (error) {
      setActionError(describeError(error, 'Unable to bind this conversation.'));
    }
  }

  function handleNewConversation(projectSlug: string, provider: ProviderId): void {
    const nextKey = `${projectSlug}:${provider}`;
    if (bindNewMutation.isPending || creatingConversationKey) return;
    setActionError(undefined);
    setCreatingConversationKey(nextKey);
    bindNewMutation.mutate(
      { projectSlug, provider },
      {
        onError: (error) => {
          setActionError(describeError(error, 'Unable to start a new conversation.'));
        },
      },
    );
  }

  async function handleRelease(sessionId: string): Promise<void> {
    setActionError(undefined);
    try {
      await releaseMutation.mutateAsync(sessionId);
    } catch (error) {
      setActionError(describeError(error, 'Unable to release this session.'));
    }
  }

  async function handleSend(sessionId: string, text: string): Promise<boolean> {
    setActionError(undefined);
    try {
      await sendMutation.mutateAsync({ sessionId, text });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to send input to the session.'));
      return false;
    }
  }

  if (authQuery.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-400">Loading Agent Console…</div>;
  }

  if (!authQuery.data?.authenticated) {
    return (
      <LoginPage
        onSubmit={async (password) => { await loginMutation.mutateAsync(password); }}
        loading={loginMutation.isPending}
        error={loginMutation.error instanceof ApiError ? loginMutation.error.message : undefined}
        tailscaleEnabled={Boolean(authQuery.data?.tailscaleEnabled)}
      />
    );
  }

  if (location.pathname === '/login') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen bg-slate-950">
      <Sidebar
        tree={treeQuery.data}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onNewConversation={handleNewConversation}
        creatingConversationKey={creatingConversationKey}
        onRefresh={handleRefresh}
        refreshing={refreshMutation.isPending}
      />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur lg:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen((current) => !current)}
              className="rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 lg:hidden"
              aria-label="Toggle navigation"
            >
              {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={() => setNavOpen((current) => !current)}
              className="hidden rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 lg:inline-flex"
              aria-label="Toggle navigation"
            >
              <PanelLeftClose className="h-5 w-5" />
            </button>
            <div>
              <div className="text-sm font-medium text-slate-100">Server-first remote session control</div>
              <div className="text-xs text-slate-500">Thin browser client · hidden tmux sessions · normalized chat UI</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/settings" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800">
              <Settings className="h-4 w-4" />
              Settings
            </Link>
            <button
              type="button"
              onClick={() => logoutMutation.mutate()}
              className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </header>

        {eventError && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 lg:mx-6">
            <AlertTriangle className="h-4 w-4" />
            {eventError}
          </div>
        )}
        {actionError && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 lg:mx-6">
            <AlertTriangle className="h-4 w-4" />
            {actionError}
          </div>
        )}

        <main className="min-h-0 flex-1">
          {location.pathname === '/settings' ? (
            <SettingsPage settings={settingsQuery.data} />
          ) : (
            <ConversationPane
              project={project}
              timeline={timelineQuery.data}
              loading={timelineQuery.isLoading}
              onBind={handleBindExisting}
              onRelease={handleRelease}
              onSend={handleSend}
              sending={sendMutation.isPending}
              binding={bindExistingMutation.isPending}
              releasing={releaseMutation.isPending}
              debugOpen={debugOpen}
              onToggleDebug={() => setDebugOpen((current) => !current)}
              rawOutput={rawOutputQuery.data?.text}
              rawLoading={rawOutputQuery.isLoading}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<AppShell />} />
      </Routes>
    </BrowserRouter>
  );
}
