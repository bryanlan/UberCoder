import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, LogOut, Menu, PanelLeftClose, Settings, X } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes, matchPath, useLocation, useNavigate } from 'react-router-dom';
import type {
  BoundSession,
  ConversationTimeline,
  ProjectSummary,
  ProviderId,
  SessionEvent,
  SessionKeystrokeRequest,
  TreeResponse,
  UiPreferences,
  UpdateUiPreferencesRequest,
} from '@agent-console/shared';
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

function useLocalStorageString(key: string, fallback: string) {
  const [value, setValue] = useState<string>(() => globalThis.localStorage?.getItem(key) ?? fallback);
  useEffect(() => {
    globalThis.localStorage?.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

const defaultUiPreferences: UiPreferences = {
  recentActivitySortEnabled: true,
  manualProjectOrder: [],
  sessionFreshnessThresholds: {
    yellowMinutes: 3,
    orangeMinutes: 7,
    redMinutes: 20,
  },
};

function isActiveSessionStatus(status: BoundSession['status']): boolean {
  return status === 'starting' || status === 'bound' || status === 'releasing';
}

function getConversationUpdatedAtFromSession(session: BoundSession): string {
  return session.lastCompletedAt ?? session.updatedAt;
}

function buildSyntheticConversationFromSession(session: BoundSession): ProjectSummary['providers'][ProviderId]['conversations'][number] {
  return {
    ref: session.conversationRef,
    kind: session.conversationRef.startsWith('pending:') ? 'pending' : 'history',
    projectSlug: session.projectSlug,
    provider: session.provider,
    title: session.title ?? 'Live session',
    createdAt: session.startedAt,
    updatedAt: getConversationUpdatedAtFromSession(session),
    isBound: true,
    boundSessionId: session.id,
    degraded: false,
    rawMetadata: {
      syntheticSessionPlaceholder: true,
    },
  };
}

function isSyntheticSessionPlaceholder(
  conversation: ProjectSummary['providers'][ProviderId]['conversations'][number],
): boolean {
  return conversation.rawMetadata?.syntheticSessionPlaceholder === true;
}

function applySessionUpdateToTree(current: TreeResponse | undefined, session: BoundSession): TreeResponse | undefined {
  if (!current) {
    return current;
  }

  const active = isActiveSessionStatus(session.status);
  const nextBoundSessions = current.boundSessions.filter((item) => item.id !== session.id);
  if (active) {
    nextBoundSessions.unshift(session);
    nextBoundSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  return {
    ...current,
    boundSessions: nextBoundSessions,
    projects: current.projects.map((project) => {
      if (project.slug !== session.projectSlug) {
        return project;
      }

      return {
        ...project,
        providers: {
          ...project.providers,
          [session.provider]: {
            ...project.providers[session.provider],
            conversations: (() => {
              let foundTarget = false;
              const nextConversations = project.providers[session.provider].conversations.flatMap((conversation) => {
                if (conversation.ref === session.conversationRef) {
                  foundTarget = true;
                  if (!active && isSyntheticSessionPlaceholder(conversation)) {
                    return [];
                  }
                  return [{
                    ...conversation,
                    title: session.title ?? conversation.title,
                    updatedAt: getConversationUpdatedAtFromSession(session),
                    isBound: active,
                    boundSessionId: active ? session.id : undefined,
                  }];
                }
                if (conversation.boundSessionId === session.id) {
                  if (isSyntheticSessionPlaceholder(conversation)) {
                    return [];
                  }
                  return [{
                    ...conversation,
                    isBound: false,
                    boundSessionId: undefined,
                  }];
                }
                return [conversation];
              });

              if (active && !foundTarget) {
                nextConversations.unshift(buildSyntheticConversationFromSession(session));
              }
              return nextConversations;
            })(),
          },
        },
      };
    }),
  };
}

function applySessionActivityToTree(
  current: TreeResponse | undefined,
  input: { sessionId: string; timestamp: string },
): TreeResponse | undefined {
  if (!current) {
    return current;
  }

  return {
    ...current,
    boundSessions: current.boundSessions.map((session) => (
      session.id !== input.sessionId
        ? session
        : {
            ...session,
            updatedAt: input.timestamp,
            lastActivityAt: input.timestamp,
            lastOutputAt: input.timestamp,
          }
    )),
  };
}

function applySessionUpdateToTimeline(
  current: ConversationTimeline | undefined,
  session: BoundSession,
): ConversationTimeline | undefined {
  if (!current) {
    return current;
  }

  const matchesCurrent =
    current.boundSession?.id === session.id
    || (
      current.conversation.projectSlug === session.projectSlug
      && current.conversation.provider === session.provider
      && current.conversation.ref === session.conversationRef
    );
  if (!matchesCurrent) {
    return current;
  }

  const active = isActiveSessionStatus(session.status);
  const nextRef = current.boundSession?.id === session.id
    ? session.conversationRef
    : current.conversation.ref;
  const refChanged = nextRef !== current.conversation.ref;
  return {
    ...current,
      conversation: {
        ...current.conversation,
        ref: nextRef,
        kind: refChanged ? (session.conversationRef.startsWith('pending:') ? 'pending' : 'history') : current.conversation.kind,
        title: session.title ?? current.conversation.title,
        updatedAt: getConversationUpdatedAtFromSession(session),
        isBound: active,
        boundSessionId: active ? session.id : undefined,
      },
    boundSession: active
      ? {
          ...(current.boundSession ?? session),
          ...session,
        }
      : undefined,
  };
}

function applySessionActivityToTimeline(
  current: ConversationTimeline | undefined,
  input: { sessionId: string; timestamp: string },
): ConversationTimeline | undefined {
  if (!current || current.boundSession?.id !== input.sessionId) {
    return current;
  }

  return {
    ...current,
    boundSession: {
      ...current.boundSession,
      updatedAt: input.timestamp,
      lastActivityAt: input.timestamp,
      lastOutputAt: input.timestamp,
    },
  };
}

function AppShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useLocalStorageBoolean('agent-console:nav-open:v2', true);
  const [debugOpen, setDebugOpen] = useLocalStorageBoolean('agent-console:debug-open', false);
  const [workMode, setWorkMode] = useLocalStorageBoolean('agent-console:work-mode', true);
  const [mobileChromeHidden, setMobileChromeHidden] = useLocalStorageBoolean('agent-console:mobile-chrome-hidden', false);
  const [mobileControlsHidden, setMobileControlsHidden] = useState(false);
  const [lastConsolePath, setLastConsolePath] = useLocalStorageString('agent-console:last-console-path', '/');
  const [eventError, setEventError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [creatingConversationKey, setCreatingConversationKey] = useState<string>();
  const [renamingProjectKey, setRenamingProjectKey] = useState<string>();
  const [rebindingConversationKey, setRebindingConversationKey] = useState<string>();
  const [renamingConversationKey, setRenamingConversationKey] = useState<string>();
  const realtimeDegraded = Boolean(eventError);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: api.authState, retry: false });
  const treeQuery = useQuery({
    queryKey: ['tree'],
    queryFn: api.tree,
    enabled: authQuery.data?.authenticated,
    refetchInterval: authQuery.data?.authenticated && realtimeDegraded ? 5000 : false,
  });
  const uiPreferencesQuery = useQuery({
    queryKey: ['ui-preferences'],
    queryFn: api.uiPreferences,
    enabled: authQuery.data?.authenticated,
  });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings, enabled: authQuery.data?.authenticated && location.pathname === '/settings' });
  const inSettings = location.pathname === '/settings';

  const conversationSelection = matchPath({ path: '/projects/:projectSlug/:provider/:conversationRef', end: true }, location.pathname);
  const providerSelection = matchPath({ path: '/projects/:projectSlug/:provider', end: true }, location.pathname);
  const projectSelection = matchPath({ path: '/projects/:projectSlug', end: true }, location.pathname);

  const selectedProjectSlug = conversationSelection?.params.projectSlug
    ?? providerSelection?.params.projectSlug
    ?? projectSelection?.params.projectSlug;
  const selectedProvider = (conversationSelection?.params.provider ?? providerSelection?.params.provider) as ProviderId | undefined;
  const selectedConversationRef = conversationSelection?.params.conversationRef ? decodeURIComponent(conversationSelection.params.conversationRef) : undefined;

  const timelineQuery = useQuery({
    queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
    queryFn: () => api.timeline(selectedProjectSlug!, selectedProvider!, selectedConversationRef!),
    enabled: Boolean(authQuery.data?.authenticated && selectedProjectSlug && selectedProvider && selectedConversationRef),
    refetchInterval: (query) => {
      if (!realtimeDegraded) return false;
      return query.state.data?.boundSession ? 1000 : 5000;
    },
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
    refetchInterval: realtimeDegraded && timelineQuery.data?.boundSession ? 1000 : false,
  });

  useEffect(() => {
    if (location.pathname !== '/settings' && location.pathname !== '/login') {
      setLastConsolePath(location.pathname);
    }
  }, [location.pathname, setLastConsolePath]);

  useEffect(() => {
    if (location.pathname === '/settings' || !timelineQuery.data?.boundSession) {
      setMobileChromeHidden(false);
      setMobileControlsHidden(false);
    }
  }, [location.pathname, setMobileChromeHidden, timelineQuery.data?.boundSession]);

  useEffect(() => {
    setMobileControlsHidden(false);
  }, [selectedConversationRef, selectedProjectSlug, selectedProvider]);

  function closeSidebarIfMobile(): void {
    if (globalThis.matchMedia?.('(max-width: 1023px)').matches) {
      setNavOpen(false);
    }
  }

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
        if (parsed.type === 'session.screen-updated') {
          const matchesSelectedSession = parsed.sessionId === timelineQuery.data?.boundSession?.id
            || (
              parsed.projectSlug === selectedProjectSlug
              && parsed.provider === selectedProvider
              && parsed.conversationRef === selectedConversationRef
            );
          if (matchesSelectedSession && selectedProjectSlug && selectedProvider && selectedConversationRef) {
            queryClient.setQueryData<ConversationTimeline | undefined>(
              ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
              (current) => current ? { ...current, liveScreen: parsed.screen } : current,
            );
          }
          return;
        }
        if (parsed.type === 'session.raw-output') {
          queryClient.setQueryData<TreeResponse | undefined>(
            ['tree'],
            (current) => applySessionActivityToTree(current, { sessionId: parsed.sessionId, timestamp: parsed.timestamp }),
          );
          queryClient.setQueryData<ConversationTimeline | undefined>(
            ['timeline', parsed.projectSlug, parsed.provider, parsed.conversationRef],
            (current) => applySessionActivityToTimeline(current, { sessionId: parsed.sessionId, timestamp: parsed.timestamp }),
          );
          if (parsed.sessionId === timelineQuery.data?.boundSession?.id && debugOpen) {
            queryClient.invalidateQueries({ queryKey: ['raw-output', parsed.sessionId] });
          }
          return;
        }
        if (parsed.type === 'session.updated') {
          queryClient.setQueryData<TreeResponse | undefined>(
            ['tree'],
            (current) => applySessionUpdateToTree(current, parsed.session),
          );
          queryClient.setQueryData<ConversationTimeline | undefined>(
            ['timeline', parsed.session.projectSlug, parsed.session.provider, parsed.session.conversationRef],
            (current) => applySessionUpdateToTimeline(current, parsed.session),
          );
          if (selectedProjectSlug && selectedProvider && selectedConversationRef) {
            queryClient.setQueryData<ConversationTimeline | undefined>(
              ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
              (current) => applySessionUpdateToTimeline(current, parsed.session),
            );
          }
          return;
        }
        if (parsed.type === 'session.released') {
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          if (
            selectedProjectSlug
            && selectedProvider
            && selectedConversationRef
            && (
              parsed.sessionId === timelineQuery.data?.boundSession?.id
              || (
                parsed.projectSlug === selectedProjectSlug
                && parsed.provider === selectedProvider
                && parsed.conversationRef === selectedConversationRef
              )
            )
          ) {
            queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
          }
          return;
        }
        if (parsed.type === 'conversation.index-updated') {
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          const eventTargetsSelection = Boolean(
            parsed.projectSlug
            && parsed.provider
            && parsed.conversationRef
            && (
              parsed.projectSlug === selectedProjectSlug
              && parsed.provider === selectedProvider
              && parsed.conversationRef === selectedConversationRef
            ),
          );
          if (conversationSelection?.params.conversationRef && eventTargetsSelection) {
            queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
          }
          return;
        }
        if (conversationSelection?.params.conversationRef) {
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
  }, [authQuery.data?.authenticated, conversationSelection?.params.conversationRef, queryClient, selectedConversationRef, selectedProjectSlug, selectedProvider, timelineQuery.data?.boundSession?.id]);

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

  const rebindConversationMutation = useMutation({
    mutationFn: ({ projectSlug, provider, conversationRef }: { projectSlug: string; provider: ProviderId; conversationRef: string }) =>
      api.bindConversation(projectSlug, provider, conversationRef, authQuery.data?.csrfToken, { force: true }),
    onSuccess: (_result, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', variables.projectSlug, variables.provider, variables.conversationRef] });
      navigate(`/projects/${encodeURIComponent(variables.projectSlug)}/${variables.provider}/${encodeURIComponent(variables.conversationRef)}`);
      closeSidebarIfMobile();
    },
    onSettled: () => {
      setRebindingConversationKey(undefined);
    },
  });

  const bindNewMutation = useMutation({
    mutationFn: ({ projectSlug, provider }: { projectSlug: string; provider: ProviderId }) => api.bindNewConversation(projectSlug, provider, authQuery.data?.csrfToken),
    onSuccess: ({ conversationRef }, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      navigate(`/projects/${encodeURIComponent(variables.projectSlug)}/${variables.provider}/${encodeURIComponent(conversationRef)}`);
      closeSidebarIfMobile();
    },
    onSettled: () => {
      setCreatingConversationKey(undefined);
    },
  });

  const renameConversationMutation = useMutation({
    mutationFn: ({ projectSlug, provider, conversationRef, title }: { projectSlug: string; provider: ProviderId; conversationRef: string; title: string }) =>
      api.renameConversation(projectSlug, provider, conversationRef, { title }, authQuery.data?.csrfToken),
    onSuccess: ({ conversation }, variables) => {
      setActionError(undefined);
      queryClient.setQueryData(['tree'], (current: typeof treeQuery.data | undefined) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects.map((project) => (
            project.slug !== variables.projectSlug
              ? project
              : {
                  ...project,
                  providers: {
                    ...project.providers,
                    [variables.provider]: {
                      ...project.providers[variables.provider],
                      conversations: project.providers[variables.provider].conversations.map((item) => (
                        item.ref === conversation.ref ? { ...item, title: conversation.title } : item
                      )),
                    },
                  },
                }
          )),
        };
      });
      queryClient.setQueryData<ConversationTimeline | undefined>(
        ['timeline', variables.projectSlug, variables.provider, variables.conversationRef],
        (current) => current ? { ...current, conversation: { ...current.conversation, title: conversation.title } } : current,
      );
      if (conversation.ref !== variables.conversationRef) {
        queryClient.setQueryData<ConversationTimeline | undefined>(
          ['timeline', variables.projectSlug, variables.provider, conversation.ref],
          (current) => current ? { ...current, conversation: { ...current.conversation, title: conversation.title } } : current,
        );
      }
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', variables.projectSlug, variables.provider, variables.conversationRef] });
    },
    onSettled: () => {
      setRenamingConversationKey(undefined);
    },
  });

  const renameProjectMutation = useMutation({
    mutationFn: ({ project, displayName }: { project: ProjectSummary; displayName?: string }) =>
      api.updateProjectSettings(
        project.directoryName,
        {
          active: true,
          displayName,
          allowedLocalhostPorts: project.allowedLocalhostPorts,
          tags: project.tags,
          notes: project.notes,
        },
        authQuery.data?.csrfToken,
      ),
    onSuccess: ({ project: updated }, variables) => {
      setActionError(undefined);
      queryClient.setQueryData(['tree'], (current: typeof treeQuery.data | undefined) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects.map((item) => (
            item.slug !== variables.project.slug
              ? item
              : {
                  ...item,
                  displayName: updated.displayName ?? item.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? item.directoryName,
                }
          )),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onSettled: () => {
      setRenamingProjectKey(undefined);
    },
  });

  const updateUiPreferencesMutation = useMutation({
    mutationFn: (body: UpdateUiPreferencesRequest) =>
      api.updateUiPreferences(body, authQuery.data?.csrfToken),
    onSuccess: ({ preferences }) => {
      setActionError(undefined);
      queryClient.setQueryData(['ui-preferences'], preferences);
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
  const uiPreferences = uiPreferencesQuery.data ?? defaultUiPreferences;

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

  async function handleSendText(sessionId: string, text: string): Promise<boolean> {
    setActionError(undefined);
    try {
      await sendMutation.mutateAsync({ sessionId, text });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to send input to the session.'));
      return false;
    }
  }

  function applyUpdatedSessionToSelection(sessionId: string, updatedSession: BoundSession): void {
    if (selectedProjectSlug && selectedProvider && selectedConversationRef) {
      queryClient.setQueryData<ConversationTimeline | undefined>(
        ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
        (current) => current?.boundSession?.id === sessionId
          ? {
              ...current,
              boundSession: {
                ...current.boundSession,
                ...updatedSession,
              },
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
    }
    if (sessionId === timelineQuery.data?.boundSession?.id) {
      void queryClient.invalidateQueries({ queryKey: ['raw-output', sessionId] });
    }
  }

  async function forceRebindSelectedConversation(initialPrompt?: string): Promise<BoundSession | undefined> {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
      return undefined;
    }
    if (timelineQuery.data?.conversation.kind !== 'history') {
      return undefined;
    }

    const { session } = await api.bindConversation(
      selectedProjectSlug,
      selectedProvider,
      selectedConversationRef,
      authQuery.data?.csrfToken,
      { force: true, initialPrompt },
    );

    queryClient.setQueryData(['tree'], (current: TreeResponse | undefined) => applySessionUpdateToTree(current, session));
    queryClient.setQueryData<ConversationTimeline | undefined>(
      ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef],
      (current) => current
        ? {
            ...current,
            conversation: {
              ...current.conversation,
              isBound: true,
              boundSessionId: session.id,
            },
            boundSession: session,
          }
        : current,
    );
    void queryClient.invalidateQueries({ queryKey: ['tree'] });
    void queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
    return session;
  }

  async function handleSendKeystrokes(sessionId: string, body: SessionKeystrokeRequest): Promise<boolean> {
    setActionError(undefined);
    try {
      const updatedSession = await api.sendKeystrokes(sessionId, body, authQuery.data?.csrfToken);
      applyUpdatedSessionToSelection(sessionId, updatedSession);
      return true;
    } catch (error) {
      if (
        error instanceof ApiError
        && error.status === 409
        && error.message.includes('did not accept the typed text into its input buffer')
        && timelineQuery.data?.boundSession?.id === sessionId
      ) {
        try {
          const usePromptedCodexRebind = selectedProvider === 'codex'
            && typeof body.text === 'string'
            && body.text.trim().length > 0
            && Array.isArray(body.keys)
            && body.keys.includes('Enter');
          const reboundSession = await forceRebindSelectedConversation(
            usePromptedCodexRebind ? body.text : undefined,
          );
          if (reboundSession) {
            if (usePromptedCodexRebind) {
              applyUpdatedSessionToSelection(reboundSession.id, reboundSession);
              setActionError(undefined);
              return true;
            }
            const retriedSession = await api.sendKeystrokes(reboundSession.id, body, authQuery.data?.csrfToken);
            applyUpdatedSessionToSelection(reboundSession.id, retriedSession);
            setActionError(undefined);
            return true;
          }
        } catch (recoveryError) {
          setActionError(describeError(recoveryError, 'Live session input recovery failed.'));
          return false;
        }
      }
      setActionError(describeError(error, 'Unable to send keystrokes to the session.'));
      return false;
    }
  }

  async function handleRenameConversation(projectSlug: string, provider: ProviderId, conversationRef: string, title: string): Promise<boolean> {
    setActionError(undefined);
    setRenamingConversationKey(`${projectSlug}:${provider}:${conversationRef}`);
    try {
      await renameConversationMutation.mutateAsync({ projectSlug, provider, conversationRef, title });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to rename this conversation.'));
      return false;
    }
  }

  async function handleRebindConversation(projectSlug: string, provider: ProviderId, conversationRef: string): Promise<boolean> {
    setActionError(undefined);
    setRebindingConversationKey(`${projectSlug}:${provider}:${conversationRef}`);
    try {
      await rebindConversationMutation.mutateAsync({ projectSlug, provider, conversationRef });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to rebind this conversation.'));
      return false;
    }
  }

  async function handleRenameProject(project: ProjectSummary, displayName?: string): Promise<boolean> {
    setActionError(undefined);
    setRenamingProjectKey(project.slug);
    try {
      await renameProjectMutation.mutateAsync({ project, displayName });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to rename this project.'));
      return false;
    }
  }

  async function handleToggleRecentActivity(): Promise<void> {
    await handleUpdateUiPreferences(
      { recentActivitySortEnabled: !uiPreferences.recentActivitySortEnabled },
      'Unable to update sidebar sorting.',
    );
  }

  async function handleReorderProjects(sourceSlug: string, targetSlug: string): Promise<void> {
    if (sourceSlug === targetSlug) {
      return;
    }
    const currentOrder = [...uiPreferences.manualProjectOrder];
    const orderSet = new Set(currentOrder);
    if (!orderSet.has(sourceSlug)) {
      currentOrder.push(sourceSlug);
    }
    if (!orderSet.has(targetSlug)) {
      currentOrder.push(targetSlug);
    }
    const nextOrder = currentOrder.filter((slug) => slug !== sourceSlug);
    const targetIndex = nextOrder.indexOf(targetSlug);
    if (targetIndex === -1) {
      nextOrder.push(sourceSlug);
    } else {
      nextOrder.splice(targetIndex, 0, sourceSlug);
    }

    setActionError(undefined);
    try {
      await updateUiPreferencesMutation.mutateAsync({
        recentActivitySortEnabled: false,
        manualProjectOrder: nextOrder,
      });
    } catch (error) {
      setActionError(describeError(error, 'Unable to reorder projects.'));
    }
  }

  async function handleUpdateUiPreferences(body: UpdateUiPreferencesRequest, fallback = 'Unable to save UI preferences.'): Promise<boolean> {
    setActionError(undefined);
    try {
      await updateUiPreferencesMutation.mutateAsync(body);
      return true;
    } catch (error) {
      setActionError(describeError(error, fallback));
      return false;
    }
  }

  if (authQuery.isLoading) {
    return <div className="flex h-screen items-center justify-center text-slate-400">Loading Agent Console…</div>;
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
    <div className="fixed inset-0 flex h-[100dvh] overflow-hidden bg-slate-950">
      <Sidebar
        tree={treeQuery.data}
        open={navOpen}
        onClose={closeSidebarIfMobile}
        workMode={workMode}
        onToggleWorkMode={() => setWorkMode((current) => !current)}
        recentActivitySortEnabled={uiPreferences.recentActivitySortEnabled}
        manualProjectOrder={uiPreferences.manualProjectOrder}
        sessionFreshnessThresholds={uiPreferences.sessionFreshnessThresholds}
        onToggleRecentActivity={handleToggleRecentActivity}
        onReorderProjects={handleReorderProjects}
        onNewConversation={handleNewConversation}
        onRenameProject={handleRenameProject}
        onRebindConversation={handleRebindConversation}
        onRenameConversation={handleRenameConversation}
        creatingConversationKey={creatingConversationKey}
        renamingProjectKey={renamingProjectKey}
        rebindingConversationKey={rebindingConversationKey}
        renamingConversationKey={renamingConversationKey}
        updatingUiPreferences={updateUiPreferencesMutation.isPending}
        onRefresh={handleRefresh}
        refreshing={refreshMutation.isPending}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {mobileChromeHidden && (
          <div className="pointer-events-none absolute right-4 top-4 z-30">
            <button
              type="button"
              onClick={() => setMobileChromeHidden(false)}
              className="pointer-events-auto inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/90 px-3 py-2 text-sm text-slate-200 shadow-panel backdrop-blur transition hover:border-slate-500 hover:bg-slate-900"
            >
              <ChevronDown className="h-4 w-4 rotate-180" />
              Show banners
            </button>
          </div>
        )}
        <header className={`sticky top-0 z-20 shrink-0 border-b border-slate-800 bg-slate-950/90 backdrop-blur ${mobileChromeHidden ? 'hidden' : ''}`}>
          <div className="flex items-center justify-between px-4 py-3 lg:hidden">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setNavOpen((current) => !current)}
                className="rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                aria-label="Toggle navigation"
              >
                {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-100">Agent Console</div>
                <div className="truncate text-xs text-slate-500">Server-first remote session control</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to={inSettings ? lastConsolePath : '/settings'}
                className="inline-flex rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                aria-label={inSettings ? 'Back to console' : 'Settings'}
              >
                <Settings className="h-4 w-4" />
              </Link>
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                className="rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="hidden items-center justify-between px-4 py-3 lg:flex lg:px-6">
            <div className="flex items-center gap-3">
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
                <div className="text-xs text-slate-500">Thin browser client · hidden tmux sessions · abstracted live session UI</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to={inSettings ? lastConsolePath : '/settings'}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                <Settings className="h-4 w-4" />
                {inSettings ? 'Back to Console' : 'Settings'}
              </Link>
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                Sign out
              </button>
            </div>
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

        <main className="min-h-0 flex-1 overflow-hidden">
          {location.pathname === '/settings' ? (
            <SettingsPage
              settings={settingsQuery.data}
              uiPreferences={uiPreferences}
              onUpdateUiPreferences={handleUpdateUiPreferences}
              updatingUiPreferences={updateUiPreferencesMutation.isPending}
              csrfToken={authQuery.data?.csrfToken}
              backHref={lastConsolePath}
            />
          ) : (
            <ConversationPane
              projects={treeQuery.data?.projects}
              project={project}
              selectedProvider={selectedProvider}
              timeline={timelineQuery.data}
              loading={timelineQuery.isLoading}
              workMode={workMode}
              mobileChromeHidden={mobileChromeHidden}
              onToggleMobileChrome={() => setMobileChromeHidden((current) => !current)}
              mobileControlsHidden={mobileControlsHidden}
              onToggleMobileControls={() => setMobileControlsHidden((current) => !current)}
              onBind={handleBindExisting}
              onRelease={handleRelease}
              onSendText={handleSendText}
              onSendKeystrokes={handleSendKeystrokes}
              sendingText={sendMutation.isPending}
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
