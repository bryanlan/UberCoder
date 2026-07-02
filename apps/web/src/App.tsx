import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, LogOut, Menu, PanelLeftClose, Settings, X } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes, matchPath, useLocation, useNavigate } from 'react-router-dom';
import type {
  BoundSession,
  ConversationTimeline,
  NormalizedMessage,
  ProjectSummary,
  ProviderId,
  RecordedUserInput,
  SessionEvent,
  SessionKeystrokeRequest,
  TreeResponse,
  UiPreferences,
  UpdateUiPreferencesRequest,
} from '@agent-console/shared';
import { api, ApiError } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { useConversationDataController, resetTimelineHistoryQuery } from './features/conversation/useConversationDataController';
import { applySessionEvent } from './features/realtime/apply-session-event';
import { useRealtimeConnection } from './features/realtime/connection';
import {
  applySessionUpdateToTimeline,
  applySessionUpdateToTree,
  appendTimelineHistoryMessage,
  appendTimelineMessage,
  buildLiveUserMessage,
  removeTimelineHistoryMessage,
  removeTimelineMessage,
  type TimelineHistoryData,
} from './features/realtime/reducers';
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
    yellowMinutes: 60,
    redMinutes: 24 * 60,
  },
};
const LIVE_MESSAGE_REFRESH_THROTTLE_MS = 3000;
function AppShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useLocalStorageBoolean('agent-console:nav-open:v2', true);
  const [debugOpen, setDebugOpen] = useLocalStorageBoolean('agent-console:debug-open', false);
  const [workMode, setWorkMode] = useLocalStorageBoolean('agent-console:work-mode', true);
  const [mobileChromeHidden, setMobileChromeHidden] = useLocalStorageBoolean('agent-console:mobile-chrome-hidden:v2', true);
  const [mobileControlsHidden, setMobileControlsHidden] = useState(false);
  const [lastConsolePath, setLastConsolePath] = useLocalStorageString('agent-console:last-console-path', '/');
  const [eventError, setEventError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [creatingConversationKey, setCreatingConversationKey] = useState<string>();
  const [renamingProjectKey, setRenamingProjectKey] = useState<string>();
  const [rebindingConversationKey, setRebindingConversationKey] = useState<string>();
  const [renamingConversationKey, setRenamingConversationKey] = useState<string>();
  const liveMessageRefreshTimersRef = useRef(new Map<string, number>());
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

  const {
    timeline,
    liveMode,
    loading: timelineLoading,
    rawOutput,
    rawLoading,
    hasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
    conversationKey,
    historyPrependVersion,
    tailKey,
  } = useConversationDataController({
    authenticated: authQuery.data?.authenticated,
    selectedProjectSlug,
    selectedProvider,
    selectedConversationRef,
    debugOpen,
    realtimeDegraded,
  });

  useEffect(() => {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef || !timeline?.conversation.ref) return;
    if (timeline.conversation.ref === selectedConversationRef) return;
    navigate(
      `/projects/${encodeURIComponent(selectedProjectSlug)}/${selectedProvider}/${encodeURIComponent(timeline.conversation.ref)}`,
      { replace: true },
    );
  }, [navigate, selectedConversationRef, selectedProjectSlug, selectedProvider, timeline?.conversation.ref]);

  useEffect(() => {
    if (location.pathname !== '/settings' && location.pathname !== '/login') {
      setLastConsolePath(location.pathname);
    }
  }, [location.pathname, setLastConsolePath]);

  useEffect(() => {
    if (location.pathname === '/settings' || !timeline?.boundSession) {
      setMobileControlsHidden(false);
    }
  }, [location.pathname, timeline?.boundSession]);

  useEffect(() => {
    setMobileControlsHidden(false);
  }, [selectedConversationRef, selectedProjectSlug, selectedProvider]);

  function closeSidebarIfMobile(): void {
    if (globalThis.matchMedia?.('(max-width: 1023px)').matches) {
      setNavOpen(false);
    }
  }

  const scheduleTimelineMessageRefresh = useCallback((projectSlug: string, provider: ProviderId, conversationRef: string): void => {
    const key = `${projectSlug}:${provider}:${conversationRef}`;
    if (liveMessageRefreshTimersRef.current.has(key)) {
      return;
    }

    const timer = window.setTimeout(() => {
      liveMessageRefreshTimersRef.current.delete(key);
      void queryClient.resetQueries({
        queryKey: ['timeline-history', projectSlug, provider, conversationRef],
        exact: true,
      });
    }, LIVE_MESSAGE_REFRESH_THROTTLE_MS);
    liveMessageRefreshTimersRef.current.set(key, timer);
  }, [queryClient]);

  function scheduleSelectedTimelineMessageRefresh(): void {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
      return;
    }
    scheduleTimelineMessageRefresh(selectedProjectSlug, selectedProvider, selectedConversationRef);
  }

  function appendMessageToConversationCache(input: { projectSlug: string; provider: ProviderId; conversationRef: string; message: NormalizedMessage }): void {
    queryClient.setQueryData<ConversationTimeline | undefined>(
      ['timeline', input.projectSlug, input.provider, input.conversationRef],
      (current) => appendTimelineMessage(current, input.message),
    );

    queryClient.setQueryData<TimelineHistoryData | undefined>(
      ['timeline-history', input.projectSlug, input.provider, input.conversationRef],
      (current) => {
        const appended = appendTimelineHistoryMessage(current, input.message);
        if (appended) {
          return appended;
        }
        if (
          timeline
          && timeline.conversation.projectSlug === input.projectSlug
          && timeline.conversation.provider === input.provider
          && timeline.conversation.ref === input.conversationRef
        ) {
          return {
            pages: [{
              ...timeline,
              messages: [input.message],
              messagePage: timeline.messagePage ?? { hasOlder: false, total: 1 },
            }],
            pageParams: [undefined],
          };
        }
        return current;
      },
    );
  }

  function removeMessageFromConversationCache(input: { projectSlug: string; provider: ProviderId; conversationRef: string; messageId: string }): void {
    queryClient.setQueryData<ConversationTimeline | undefined>(
      ['timeline', input.projectSlug, input.provider, input.conversationRef],
      (current) => removeTimelineMessage(current, input.messageId),
    );

    queryClient.setQueryData<TimelineHistoryData | undefined>(
      ['timeline-history', input.projectSlug, input.provider, input.conversationRef],
      (current) => removeTimelineHistoryMessage(current, input.messageId),
    );
  }

  function appendSelectedSubmittedText(input: { sessionId: string; text: string; timestamp?: string; optimistic?: boolean }): NormalizedMessage | undefined {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
      return undefined;
    }
    const text = input.text.trim();
    if (!text) {
      return undefined;
    }
    const message = buildLiveUserMessage({
      sessionId: input.sessionId,
      projectSlug: selectedProjectSlug,
      provider: selectedProvider,
      conversationRef: selectedConversationRef,
      text,
      timestamp: input.timestamp ?? new Date().toISOString(),
      optimistic: input.optimistic,
    });
    appendMessageToConversationCache({
      projectSlug: selectedProjectSlug,
      provider: selectedProvider,
      conversationRef: selectedConversationRef,
      message,
    });
    return message;
  }

  function appendRecordedSubmittedText(input: {
    session: BoundSession;
    recordedUserInput: RecordedUserInput;
    optimisticMessage?: NormalizedMessage;
  }): void {
    const conversationRef = input.session.conversationRef;
    if (input.optimisticMessage) {
      removeMessageFromConversationCache({
        projectSlug: input.session.projectSlug,
        provider: input.session.provider,
        conversationRef,
        messageId: input.optimisticMessage.id,
      });
    }
    appendMessageToConversationCache({
      projectSlug: input.session.projectSlug,
      provider: input.session.provider,
      conversationRef,
      message: buildLiveUserMessage({
        sessionId: input.session.id,
        projectSlug: input.session.projectSlug,
        provider: input.session.provider,
        conversationRef,
        messageId: input.recordedUserInput.id,
        text: input.recordedUserInput.text,
        timestamp: input.recordedUserInput.timestamp,
      }),
    });
  }

  function shouldRefreshTimelineAfterKeystrokes(body: SessionKeystrokeRequest): boolean {
    return Boolean(body.keys?.includes('Enter'));
  }

  function optimisticSubmittedTextForKeystrokes(body: SessionKeystrokeRequest): string | undefined {
    if (!body.keys?.includes('Enter')) {
      return undefined;
    }
    const text = (body.submittedText ?? body.text)?.trim();
    if (!text || text.startsWith('/')) {
      return undefined;
    }
    if (/^\d{1,8}$/.test(text)) {
      return undefined;
    }
    return text;
  }

  useEffect(() => () => {
    for (const timer of liveMessageRefreshTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    liveMessageRefreshTimersRef.current.clear();
  }, []);

  const handleRealtimeEvent = useCallback((parsed: SessionEvent) => {
    setEventError(undefined);
    applySessionEvent(parsed, {
      queryClient,
      selectedProjectSlug,
      selectedProvider,
      selectedConversationRef,
      selectedConversationRouteActive: Boolean(conversationSelection?.params.conversationRef),
      timelineBoundSessionId: timeline?.boundSession?.id,
      debugOpen,
      appendMessageToConversationCache,
      scheduleTimelineMessageRefresh,
    });
  }, [
    appendMessageToConversationCache,
    conversationSelection?.params.conversationRef,
    debugOpen,
    queryClient,
    scheduleTimelineMessageRefresh,
    selectedConversationRef,
    selectedProjectSlug,
    selectedProvider,
    timeline?.boundSession?.id,
  ]);

  useRealtimeConnection({
    authenticated: authQuery.data?.authenticated,
    onEvent: handleRealtimeEvent,
    onParseError: setEventError,
    onConnectionError: setEventError,
  });

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
      resetTimelineHistoryQuery(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
    },
  });

  const rebindConversationMutation = useMutation({
    mutationFn: ({ projectSlug, provider, conversationRef }: { projectSlug: string; provider: ProviderId; conversationRef: string }) =>
      api.bindConversation(projectSlug, provider, conversationRef, authQuery.data?.csrfToken, { force: true }),
    onSuccess: (_result, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', variables.projectSlug, variables.provider, variables.conversationRef] });
      resetTimelineHistoryQuery(queryClient, variables.projectSlug, variables.provider, variables.conversationRef);
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
      resetTimelineHistoryQuery(queryClient, variables.projectSlug, variables.provider, variables.conversationRef);
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
      resetTimelineHistoryQuery(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
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

  function applyUpdatedSessionToSelection(
    sessionId: string,
    updatedSession: BoundSession,
    options: { refreshTimeline?: boolean } = {},
  ): void {
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
      if (options.refreshTimeline) {
        void queryClient.invalidateQueries({ queryKey: ['timeline', selectedProjectSlug, selectedProvider, selectedConversationRef] });
        resetTimelineHistoryQuery(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
      }
    }
    if (debugOpen && sessionId === timeline?.boundSession?.id) {
      void queryClient.invalidateQueries({ queryKey: ['raw-output', sessionId] });
    }
  }

  async function forceRebindSelectedConversation(initialPrompt?: string): Promise<BoundSession | undefined> {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
      return undefined;
    }
    if (timeline?.conversation.kind !== 'history') {
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
    resetTimelineHistoryQuery(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
    return session;
  }

  async function handleSendKeystrokes(sessionId: string, body: SessionKeystrokeRequest): Promise<boolean> {
    setActionError(undefined);
    const refreshTimelineMessages = shouldRefreshTimelineAfterKeystrokes(body);
    const optimisticSubmittedText = optimisticSubmittedTextForKeystrokes(body);
    const optimisticMessage = optimisticSubmittedText
      ? appendSelectedSubmittedText({
          sessionId,
          text: optimisticSubmittedText,
          optimistic: true,
        })
      : undefined;
    const discardOptimisticMessage = () => {
      if (!optimisticMessage || !selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
        return;
      }
      removeMessageFromConversationCache({
        projectSlug: selectedProjectSlug,
        provider: selectedProvider,
        conversationRef: selectedConversationRef,
        messageId: optimisticMessage.id,
      });
    };
    try {
      const response = await api.sendKeystrokes(sessionId, body, authQuery.data?.csrfToken);
      const updatedSession = response.session;
      applyUpdatedSessionToSelection(sessionId, updatedSession);
      if (response.recordedUserInput) {
        appendRecordedSubmittedText({
          session: updatedSession,
          recordedUserInput: response.recordedUserInput,
          optimisticMessage,
        });
      }
      if (refreshTimelineMessages) {
        scheduleSelectedTimelineMessageRefresh();
      }
      return true;
    } catch (error) {
      if (
        error instanceof ApiError
        && error.status === 409
        && error.message.includes('did not accept the typed text into its input buffer')
        && timeline?.boundSession?.id === sessionId
      ) {
        try {
          const recoveryPrompt = selectedProvider === 'codex' ? optimisticSubmittedText : undefined;
          const reboundSession = await forceRebindSelectedConversation(
            recoveryPrompt,
          );
          if (reboundSession) {
            if (recoveryPrompt) {
              applyUpdatedSessionToSelection(reboundSession.id, reboundSession);
              setActionError(undefined);
              return true;
            }
            const retryResponse = await api.sendKeystrokes(reboundSession.id, body, authQuery.data?.csrfToken);
            const retriedSession = retryResponse.session;
            applyUpdatedSessionToSelection(reboundSession.id, retriedSession);
            if (retryResponse.recordedUserInput) {
              appendRecordedSubmittedText({
                session: retriedSession,
                recordedUserInput: retryResponse.recordedUserInput,
                optimisticMessage,
              });
            }
            if (refreshTimelineMessages) {
              scheduleSelectedTimelineMessageRefresh();
            }
            setActionError(undefined);
            return true;
          }
        } catch (recoveryError) {
          discardOptimisticMessage();
          setActionError(describeError(recoveryError, 'Live session input recovery failed.'));
          return false;
        }
      }
      discardOptimisticMessage();
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
              timeline={timeline}
              liveMode={liveMode}
              loading={timelineLoading}
              workMode={workMode}
              mobileChromeHidden={mobileChromeHidden}
              onToggleMobileChrome={() => setMobileChromeHidden((current) => !current)}
              mobileControlsHidden={mobileControlsHidden}
              onToggleMobileControls={() => setMobileControlsHidden((current) => !current)}
              onBind={handleBindExisting}
              onRelease={handleRelease}
              onSendKeystrokes={handleSendKeystrokes}
              binding={bindExistingMutation.isPending}
              releasing={releaseMutation.isPending}
              debugOpen={debugOpen}
              onToggleDebug={() => setDebugOpen((current) => !current)}
              rawOutput={rawOutput}
              rawLoading={rawLoading}
              hasOlderMessages={hasOlderMessages}
              loadingOlderMessages={loadingOlderMessages}
              onLoadOlderMessages={loadOlderMessages}
              conversationKey={conversationKey}
              historyPrependVersion={historyPrependVersion}
              tailKey={tailKey}
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
