import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelRightOpen, Settings, SlidersHorizontal, X } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  BoundSession,
  ModelProfileKey,
  ConversationTimeline,
  NormalizedMessage,
  ProjectSummary,
  ProviderId,
  RecordedUserInput,
  SessionEvent,
  SessionInputResponse,
  SessionKeystrokeRequest,
  TreeResponse,
  UiPreferences,
  UpdateUiPreferencesRequest,
} from '@agent-console/shared';
import { api, ApiError } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { CoordinationPanel } from './components/CoordinationPanel';
import { WorkerPanel } from './components/WorkerPanel';
import {
  conversationMetaQueryKey,
  invalidateConversationData,
  invalidateTimelineMessages,
  selectRefreshedBoundSession,
  timelineMessagesQueryKey,
  useConversationData,
} from './features/conversation/useConversationData';
import { applySessionEvent } from './features/realtime/apply-session-event';
import { selectConsoleRoute, type ConsoleRouteKind, type ConsoleRouteSelection } from './features/navigation/route-selection';
import { useRealtimeConnection } from './features/realtime/connection';
import {
  applySessionUpdateToTimeline,
  applySessionUpdateToTree,
  appendTimelineMessagesMessage,
  buildLiveUserMessage,
  removeTimelineMessagesMessage,
  replaceTimelineMessagesMessage,
  type TimelineMessagesData,
} from './features/realtime/reducers';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { WikiPage } from './pages/WikiPage';
import { GrantsPage } from './pages/GrantsPage';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from './lib/useMediaQuery';
import { useMobileViewport } from './features/navigation/useMobileViewport';
import { isBoundSessionSuspended } from '@agent-console/shared';
import type { MobileInputPanel } from './components/ConversationPane';

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
};
const LIVE_MESSAGE_REFRESH_THROTTLE_MS = 3000;

interface OptimisticSubmittedMessageRef {
  id: string;
  conversationRef: string;
}

function NotFoundPane() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
      <div>
        <div className="mb-2 text-lg font-medium text-slate-100">Page not found</div>
        <Link to="/" className="text-sm text-sky-300 transition hover:text-sky-200">Back to console</Link>
      </div>
    </div>
  );
}

function AppShell({ routeSelection }: { routeSelection: ConsoleRouteSelection }) {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const mobileViewport = useMobileViewport(isMobile);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileInputPanel, setMobileInputPanel] = useState<MobileInputPanel>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [workersOpen, setWorkersOpen] = useLocalStorageBoolean(
    isMobile ? 'agent-console:mobile-workers-open' : 'agent-console:workers-open', false,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const currentSelectionRef = useRef(routeSelection);
  currentSelectionRef.current = routeSelection;
  const [navOpen, setNavOpen] = useLocalStorageBoolean('agent-console:nav-open:v2', true);
  const [debugOpen, setDebugOpen] = useLocalStorageBoolean('agent-console:debug-open', false);
  const [workMode, setWorkMode] = useLocalStorageBoolean('agent-console:work-mode', true);
  const [activeOnly, setActiveOnly] = useLocalStorageBoolean('agent-console:active-only', false);
  const [mobileChromeHidden, setMobileChromeHidden] = useLocalStorageBoolean('agent-console:mobile-chrome-hidden:v2', true);
  const [lastConsolePath, setLastConsolePath] = useLocalStorageString('agent-console:last-console-path', '/');
  const [eventError, setEventError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const pendingSubmissionIds = useRef(new Map<string, string>());
  const inputGenerations = useRef(new Map<string, number>());
  const [creatingConversationKey, setCreatingConversationKey] = useState<string>();
  const [renamingProjectKey, setRenamingProjectKey] = useState<string>();
  const [rebindingConversationKey, setRebindingConversationKey] = useState<string>();
  const [renamingConversationKey, setRenamingConversationKey] = useState<string>();
  const [closingConversationKey, setClosingConversationKey] = useState<string>();
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
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings, enabled: authQuery.data?.authenticated && routeSelection.inSettings });

  const selectedProjectSlug = routeSelection.selectedProjectSlug;
  const selectedProvider = routeSelection.selectedProvider;
  const selectedConversationRef = routeSelection.selectedConversationRef;

  const {
    timeline,
    liveMode,
    resumeError,
    resuming,
    retryResume,
    loading: timelineLoading,
    rawOutput,
    rawLoading,
    hasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
    conversationKey,
    historyPrependVersion,
    tailKey,
  } = useConversationData({
    authenticated: authQuery.data?.authenticated,
    csrfToken: authQuery.data?.csrfToken,
    selectedProjectSlug,
    selectedProvider,
    selectedConversationRef,
    debugOpen: debugOpen && (!isMobile || mobileDetailsOpen),
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
    if (routeSelection.isConsoleRoute && routeSelection.kind !== 'wiki' && routeSelection.kind !== 'grants') {
      setLastConsolePath(location.pathname);
    }
  }, [location.pathname, routeSelection.isConsoleRoute, setLastConsolePath]);

  useEffect(() => {
    setMobileInputPanel(null);
    setMobileMoreOpen(false);
    setMobileDetailsOpen(false);
    setMobileNavOpen(isMobile && routeSelection.kind === 'home');
  }, [location.pathname, isMobile]);

  function dismissMobileInput(): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setMobileInputPanel(null);
  }

  function openMobileChats(): void {
    dismissMobileInput();
    setMobileMoreOpen(false);
    setMobileDetailsOpen(false);
    setWorkersOpen(false);
    setMobileNavOpen(true);
  }

  function toggleMobileInput(panel: Exclude<MobileInputPanel, null>): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setMobileMoreOpen(false);
    setMobileDetailsOpen(false);
    setWorkersOpen(false);
    setMobileInputPanel(current => current === panel ? null : panel);
  }

  function closeSidebarIfMobile(): void {
    if (isMobile) setMobileNavOpen(false);
    else if (globalThis.matchMedia?.('(max-width: 1023px)').matches) setNavOpen(false);
  }

  const scheduleTimelineMessageRefresh = useCallback((projectSlug: string, provider: ProviderId, conversationRef: string): void => {
    const key = `${projectSlug}:${provider}:${conversationRef}`;
    if (liveMessageRefreshTimersRef.current.has(key)) {
      return;
    }

    const timer = window.setTimeout(() => {
      liveMessageRefreshTimersRef.current.delete(key);
      invalidateTimelineMessages(queryClient, projectSlug, provider, conversationRef);
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
    queryClient.setQueryData<TimelineMessagesData | undefined>(
      timelineMessagesQueryKey(input.projectSlug, input.provider, input.conversationRef),
      (current) => {
        const appended = appendTimelineMessagesMessage(current, input.message);
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
    queryClient.setQueryData<TimelineMessagesData | undefined>(
      timelineMessagesQueryKey(input.projectSlug, input.provider, input.conversationRef),
      (current) => removeTimelineMessagesMessage(current, input.messageId),
    );
  }

  function replaceOptimisticSubmittedText(input: {
    session: BoundSession;
    recordedUserInput: RecordedUserInput;
    optimisticMessage: OptimisticSubmittedMessageRef;
  }): boolean {
    let updated = false;
    queryClient.setQueryData<TimelineMessagesData | undefined>(
      timelineMessagesQueryKey(input.session.projectSlug, input.session.provider, input.session.conversationRef),
      (current) => {
        const next = replaceTimelineMessagesMessage(current, {
          replaceMessageId: input.optimisticMessage.id,
          message: buildLiveUserMessage({
            sessionId: input.session.id,
            projectSlug: input.session.projectSlug,
            provider: input.session.provider,
            conversationRef: input.session.conversationRef,
            messageId: input.recordedUserInput.id,
            text: input.recordedUserInput.text,
            images: input.recordedUserInput.images,
            timestamp: input.recordedUserInput.timestamp,
          }),
        });
        updated = Boolean(next);
        return next;
      },
    );
    return updated;
  }

  function appendSelectedSubmittedText(input: { sessionId: string; text: string; timestamp?: string; optimisticNonce?: string; optimistic?: boolean }): NormalizedMessage | undefined {
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
      optimisticNonce: input.optimisticNonce,
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

  function appendLocalSubmittedText(sessionId: string, text: string): OptimisticSubmittedMessageRef | undefined {
    const message = appendSelectedSubmittedText({
      sessionId,
      text,
      optimisticNonce: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`,
      optimistic: true,
    });
    return message ? { id: message.id, conversationRef: message.conversationRef } : undefined;
  }

  function discardSelectedSubmittedMessage(messageId: string): void {
    if (!selectedProjectSlug || !selectedProvider || !selectedConversationRef) {
      return;
    }
    removeMessageFromConversationCache({
      projectSlug: selectedProjectSlug,
      provider: selectedProvider,
      conversationRef: selectedConversationRef,
      messageId,
    });
  }

  function appendRecordedSubmittedText(input: {
    session: BoundSession;
    recordedUserInput: RecordedUserInput;
    optimisticMessage?: OptimisticSubmittedMessageRef;
  }): void {
    const conversationRef = input.session.conversationRef;
    if (input.optimisticMessage) {
      if (input.optimisticMessage.conversationRef !== conversationRef) {
        removeMessageFromConversationCache({
          projectSlug: input.session.projectSlug,
          provider: input.session.provider,
          conversationRef: input.optimisticMessage.conversationRef,
          messageId: input.optimisticMessage.id,
        });
      }
      const replaced = replaceOptimisticSubmittedText({
        session: input.session,
        recordedUserInput: input.recordedUserInput,
        optimisticMessage: input.optimisticMessage,
      });
      if (replaced) {
        return;
      }
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
        images: input.recordedUserInput.images,
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
      selectedConversationRouteActive: routeSelection.conversationRouteActive,
      timelineBoundSessionId: timeline?.boundSession?.id,
      debugOpen,
      appendMessageToConversationCache,
      scheduleTimelineMessageRefresh,
    });
  }, [
    appendMessageToConversationCache,
    debugOpen,
    queryClient,
    routeSelection.conversationRouteActive,
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
    mutationFn: () => api.refreshTree(authQuery.data?.csrfToken, { autoTrackRecent: true }),
    onSuccess: (data) => {
      setActionError(undefined);
      queryClient.setQueryData(['tree'], data);
    },
  });

  const bindExistingMutation = useMutation({
    mutationFn: ({ confirmExternalHandoff }: { confirmExternalHandoff?: boolean } = {}) => api.bindConversation(
      selectedProjectSlug!,
      selectedProvider!,
      selectedConversationRef!,
      authQuery.data?.csrfToken,
      { confirmExternalHandoff },
    ),
    onSuccess: () => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      invalidateConversationData(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
    },
  });

  const rebindConversationMutation = useMutation({
    mutationFn: ({ projectSlug, provider, conversationRef }: { projectSlug: string; provider: ProviderId; conversationRef: string }) =>
      api.bindConversation(projectSlug, provider, conversationRef, authQuery.data?.csrfToken, { force: true }),
    onSuccess: (_result, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      invalidateConversationData(queryClient, variables.projectSlug, variables.provider, variables.conversationRef);
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
        conversationMetaQueryKey(variables.projectSlug, variables.provider, variables.conversationRef),
        (current) => current ? { ...current, conversation: { ...current.conversation, title: conversation.title } } : current,
      );
      if (conversation.ref !== variables.conversationRef) {
        queryClient.setQueryData<ConversationTimeline | undefined>(
          conversationMetaQueryKey(variables.projectSlug, variables.provider, conversation.ref),
          (current) => current ? { ...current, conversation: { ...current.conversation, title: conversation.title } } : current,
        );
      }
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      invalidateConversationData(queryClient, variables.projectSlug, variables.provider, variables.conversationRef);
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
    mutationFn: ({ sessionId }: { sessionId: string; projectSlug?: string; provider?: ProviderId; conversationRef?: string }) =>
      api.releaseSession(sessionId, authQuery.data?.csrfToken),
    onSuccess: (_result, variables) => {
      setActionError(undefined);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      invalidateConversationData(queryClient, variables.projectSlug, variables.provider, variables.conversationRef);
    },
  });

  const suspendMutation = useMutation({
    mutationFn: (sessionId: string) => api.suspendSession(sessionId, authQuery.data?.csrfToken),
    onSuccess: () => {
      setActionError(undefined);
      navigate('/');
      queryClient.invalidateQueries({ queryKey: ['tree'] });
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

  async function handleBindExisting(options: { confirmExternalHandoff?: boolean } = {}): Promise<void> {
    setActionError(undefined);
    try {
      await bindExistingMutation.mutateAsync(options);
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
      await releaseMutation.mutateAsync({ sessionId, projectSlug: selectedProjectSlug, provider: selectedProvider, conversationRef: selectedConversationRef });
    } catch (error) {
      setActionError(describeError(error, 'Unable to release this session.'));
    }
  }

  async function handleSuspend(sessionId: string): Promise<void> {
    setActionError(undefined);
    try {
      await suspendMutation.mutateAsync(sessionId);
    } catch (error) {
      setActionError(describeError(error, 'Unable to suspend this session.'));
    }
  }

  function applyUpdatedSessionToSelection(
    sessionId: string,
    updatedSession: BoundSession,
    options: { refreshTimeline?: boolean } = {},
  ): void {
    if (selectedProjectSlug && selectedProvider && selectedConversationRef) {
      queryClient.setQueryData<ConversationTimeline | undefined>(
        conversationMetaQueryKey(selectedProjectSlug, selectedProvider, selectedConversationRef),
        (current) => current?.boundSession?.id === sessionId
          ? {
              ...current,
              boundSession: selectRefreshedBoundSession(current.boundSession, updatedSession),
            }
          : current,
      );
      if (options.refreshTimeline) {
        invalidateConversationData(queryClient, selectedProjectSlug, selectedProvider, selectedConversationRef);
      }
    }
    if (debugOpen && sessionId === timeline?.boundSession?.id) {
      void queryClient.invalidateQueries({ queryKey: ['raw-output', sessionId] });
    }
  }

  async function handleSendKeystrokes(sessionId: string, body: SessionKeystrokeRequest): Promise<SessionInputResponse | undefined> {
    if (body.keys?.some(key => key === 'Escape' || key === 'C-c')) {
      inputGenerations.current.set(sessionId, (inputGenerations.current.get(sessionId) ?? 0) + 1);
      for (const key of pendingSubmissionIds.current.keys()) {
        if (key.startsWith(`${sessionId}:`)) pendingSubmissionIds.current.delete(key);
      }
    }
    const generation = inputGenerations.current.get(sessionId) ?? 0;
    setActionError(undefined);
    const refreshTimelineMessages = shouldRefreshTimelineAfterKeystrokes(body);
    const optimisticSubmittedText = optimisticSubmittedTextForKeystrokes(body);
    const optimisticMessage: OptimisticSubmittedMessageRef | undefined = optimisticSubmittedText && body.clientOptimisticMessageId && selectedConversationRef
      ? { id: body.clientOptimisticMessageId, conversationRef: selectedConversationRef }
      : optimisticSubmittedText
      ? appendSelectedSubmittedText({
          sessionId,
          text: optimisticSubmittedText,
          optimisticNonce: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`,
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
      const completeChatSubmit = body.keys?.length === 1 && body.keys[0] === 'Enter'
        && body.submittedText?.trim() && !body.submittedText.trim().startsWith('/');
      const submissionKey = `${sessionId}:${body.submittedText ?? ''}`;
      const submissionId = completeChatSubmit
        ? body.submissionId ?? pendingSubmissionIds.current.get(submissionKey) ?? crypto.randomUUID() : undefined;
      if (submissionId) pendingSubmissionIds.current.set(submissionKey, submissionId);
      const response = await api.sendKeystrokes(sessionId, completeChatSubmit
        ? { ...body, submissionId } : body, authQuery.data?.csrfToken);
      if (generation !== (inputGenerations.current.get(sessionId) ?? 0)) {
        discardOptimisticMessage();
        return undefined;
      }
      if (pendingSubmissionIds.current.get(submissionKey) === submissionId) pendingSubmissionIds.current.delete(submissionKey);
      const updatedSession = response.session;
      applyUpdatedSessionToSelection(sessionId, updatedSession);
      if (response.queuedInput) discardOptimisticMessage();
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
      return response;
    } catch (error) {
      discardOptimisticMessage();
      if (generation !== (inputGenerations.current.get(sessionId) ?? 0)) return undefined;
      setActionError(describeError(error, 'Unable to send keystrokes to the session.'));
      return undefined;
    }
  }

  async function handleSetModelProfile(sessionId: string, profile: ModelProfileKey): Promise<boolean> {
    setActionError(undefined);
    try {
      const response = await api.setSessionModelProfile(sessionId, profile, authQuery.data?.csrfToken);
      applyUpdatedSessionToSelection(sessionId, response.session);
      void queryClient.invalidateQueries({ queryKey: ['tree'] });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Could not change the session model profile.'));
      return false;
    }
  }

  async function handleCancelModelProfileRequest(sessionId: string, requestId: string): Promise<boolean> {
    setActionError(undefined);
    try {
      const response = await api.cancelSessionModelProfileRequest(sessionId, requestId, authQuery.data?.csrfToken);
      applyUpdatedSessionToSelection(sessionId, response.session);
      void queryClient.invalidateQueries({ queryKey: ['tree'] });
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Could not cancel the queued model profile.'));
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

  async function handleCloseConversation(projectSlug: string, provider: ProviderId, conversationRef: string): Promise<boolean> {
    if (releaseMutation.isPending || closingConversationKey) return false;
    setActionError(undefined);
    const session = treeQuery.data?.boundSessions.find((item) => (
      item.projectSlug === projectSlug && item.provider === provider && item.conversationRef === conversationRef
    ));
    if (!session) {
      setActionError('This conversation has no loaded session to close.');
      return false;
    }
    setClosingConversationKey(`${projectSlug}:${provider}:${conversationRef}`);
    try {
      await releaseMutation.mutateAsync({ sessionId: session.id, projectSlug, provider, conversationRef });
      const currentSelection = currentSelectionRef.current;
      if (currentSelection.selectedProjectSlug === projectSlug
        && currentSelection.selectedProvider === provider
        && currentSelection.selectedConversationRef === conversationRef) {
        navigate(`/projects/${encodeURIComponent(projectSlug)}`);
      }
      return true;
    } catch (error) {
      setActionError(describeError(error, 'Unable to close this conversation.'));
      return false;
    } finally {
      setClosingConversationKey(undefined);
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

  if (routeSelection.isLogin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div onKeyDown={event => { if (event.key === 'Escape' && mobileMoreOpen) { event.stopPropagation(); setMobileMoreOpen(false); } }} data-testid="console-shell" className="fixed inset-0 flex h-[100dvh] overflow-hidden bg-slate-950" style={isMobile ? { height: `${mobileViewport.height}px`, top: `${mobileViewport.top}px`, bottom: 'auto' } : undefined}>
      <Sidebar
        tree={treeQuery.data}
        open={isMobile ? mobileNavOpen : navOpen}
        onClose={closeSidebarIfMobile}
        workMode={workMode}
        onToggleWorkMode={() => setWorkMode((current) => !current)}
        activeOnly={activeOnly}
        onToggleActiveOnly={() => setActiveOnly((current) => !current)}
        recentActivitySortEnabled={uiPreferences.recentActivitySortEnabled}
        manualProjectOrder={uiPreferences.manualProjectOrder}
        onToggleRecentActivity={handleToggleRecentActivity}
        onReorderProjects={handleReorderProjects}
        onNewConversation={handleNewConversation}
        onRenameProject={handleRenameProject}
        onRebindConversation={handleRebindConversation}
        onRenameConversation={handleRenameConversation}
        onCloseConversation={handleCloseConversation}
        creatingConversationKey={creatingConversationKey}
        renamingProjectKey={renamingProjectKey}
        rebindingConversationKey={rebindingConversationKey}
        renamingConversationKey={renamingConversationKey}
        closingConversationKey={closingConversationKey}
        updatingUiPreferences={updateUiPreferencesMutation.isPending}
        onRefresh={handleRefresh}
        refreshing={refreshMutation.isPending}
      />
      <div inert={isMobile && mobileNavOpen} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {isMobile && <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950 px-3" data-testid="mobile-header">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-slate-400">{project?.displayName ?? 'Agent Console'}</div>
            <div className="truncate text-sm font-medium">{timeline?.conversation.title ?? (routeSelection.inSettings ? 'Settings' : 'Conversations')}</div>
          </div>
          {timeline?.boundSession && <span className="shrink-0 text-xs text-slate-400">{isBoundSessionSuspended(timeline.boundSession) ? 'Suspended' : timeline.boundSession.runFailure ? 'Needs attention' : timeline.boundSession.isWorking ? 'Working' : 'Ready'}</span>}
          <button type="button" aria-label="More options" aria-expanded={mobileMoreOpen} onClick={() => { dismissMobileInput(); setMobileMoreOpen(value => !value); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-300"><MoreHorizontal className="h-5 w-5" /></button>
          {mobileMoreOpen && <>
            <button type="button" aria-label="Close more options" onClick={() => setMobileMoreOpen(false)} className="fixed inset-0 z-20 cursor-default" />
            <div className="absolute right-3 top-full z-30 mt-1 max-h-[60dvh] w-60 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-2 shadow-panel" aria-label="More options">
              <button type="button" onClick={() => { setMobileDetailsOpen(value => !value); setMobileMoreOpen(false); }} className="mobile-menu-item">{mobileDetailsOpen ? 'Hide session details' : 'Session details'}</button>
              <button type="button" onClick={() => { setWorkersOpen(true); setMobileMoreOpen(false); }} className="mobile-menu-item">Workers</button>
              {project && <Link to={`/projects/${encodeURIComponent(project.slug)}/wiki`} className="mobile-menu-item">Project wiki</Link>}
              <Link to="/grants" className="mobile-menu-item">Grants</Link>
              <Link to={routeSelection.inSettings ? lastConsolePath : '/settings'} className="mobile-menu-item">{routeSelection.inSettings ? 'Back to console' : 'Settings'}</Link>
              <button type="button" onClick={() => logoutMutation.mutate()} className="mobile-menu-item">Sign out</button>
            </div>
          </>}
        </header>}
        {!isMobile && mobileChromeHidden && (
          <div className="pointer-events-none absolute right-4 top-4 z-30 flex gap-2">
            {!workersOpen && <button type="button" aria-label="Open worker panel" onClick={() => setWorkersOpen(true)}
              className="pointer-events-auto inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/90 px-3 py-2 text-sm text-slate-200 shadow-panel">
              <PanelRightOpen size={16} /> Workers
            </button>}
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
        {!isMobile && <header className={`sticky top-0 z-20 shrink-0 border-b border-slate-800 bg-slate-950/90 backdrop-blur ${mobileChromeHidden ? 'hidden' : ''}`}>
          {!workersOpen && <button type="button" aria-label="Open worker panel" onClick={() => setWorkersOpen(true)}
            className="float-right m-3 inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200">
            <PanelRightOpen size={16} /> Workers
          </button>}
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
              <Link to="/grants" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Grants</Link>
              {project && !routeSelection.inSettings && <Link
                to={routeSelection.kind === 'wiki' ? lastConsolePath : `/projects/${encodeURIComponent(project.slug)}/wiki`}
                className="inline-flex items-center rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >{routeSelection.kind === 'wiki' ? 'Back to Console' : 'Wiki'}</Link>}
              <Link
                to={routeSelection.inSettings ? lastConsolePath : '/settings'}
                className="inline-flex rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                aria-label={routeSelection.inSettings ? 'Back to console' : 'Settings'}
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
              <Link to="/grants" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Grants</Link>
              <Link
                to={routeSelection.inSettings ? lastConsolePath : '/settings'}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                <Settings className="h-4 w-4" />
                {routeSelection.inSettings ? 'Back to Console' : 'Settings'}
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
        </header>}

        {eventError && (
          <div title={eventError} role="status" className={isMobile ? 'flex shrink-0 items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-200' : 'mx-4 mt-4 flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 lg:mx-6'}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {isMobile ? 'Live updates interrupted' : eventError}
          </div>
        )}
        {actionError && (
          <div role="alert" className={isMobile ? 'flex max-h-20 shrink-0 items-center gap-2 overflow-y-auto border-b border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200' : 'mx-4 mt-4 flex items-center gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 lg:mx-6'}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {actionError}
          </div>
        )}

        {(!isMobile || mobileDetailsOpen) && project && !routeSelection.inSettings && routeSelection.kind !== 'wiki' && <CoordinationPanel checkout={project.path} />}
        <main className="min-h-0 flex-1 overflow-hidden">
          {routeSelection.inSettings ? (
            <SettingsPage
              settings={settingsQuery.data}
              csrfToken={authQuery.data?.csrfToken}
              backHref={lastConsolePath}
            />
          ) : routeSelection.kind === 'grants' ? (
            <GrantsPage csrfToken={authQuery.data?.csrfToken} backHref={lastConsolePath} />
          ) : routeSelection.kind === 'not-found' || (routeSelection.kind === 'wiki' && !project) ? (
            <NotFoundPane />
          ) : routeSelection.kind === 'wiki' && project ? (
            <WikiPage projectSlug={project.slug} projectName={project.displayName} csrfToken={authQuery.data?.csrfToken} />
          ) : (
            <ConversationPane
              csrfToken={authQuery.data?.csrfToken}
              projects={treeQuery.data?.projects}
              project={project}
              selectedProvider={selectedProvider}
              timeline={timeline}
              liveMode={liveMode}
              resumeError={resumeError}
              resuming={resuming}
              onRetryResume={retryResume}
              loading={timelineLoading}
              workMode={isMobile ? false : workMode}
              onOpenChats={openMobileChats}
              mobileInputPanel={mobileInputPanel}
              onCloseMobileInput={dismissMobileInput}
              onOpenMobileControls={() => toggleMobileInput('controls')}
              mobileDetailsOpen={mobileDetailsOpen}
              mobileChromeHidden={mobileChromeHidden}
              onToggleMobileChrome={() => setMobileChromeHidden((current) => !current)}
              onBind={handleBindExisting}
              onRelease={handleRelease}
              onSuspend={handleSuspend}
              onSendKeystrokes={handleSendKeystrokes}
              onSetModelProfile={handleSetModelProfile}
              onCancelModelProfileRequest={handleCancelModelProfileRequest}
              onLocalSubmittedText={appendLocalSubmittedText}
              onDiscardLocalSubmittedText={discardSelectedSubmittedMessage}
              binding={bindExistingMutation.isPending}
              releasing={releaseMutation.isPending}
              suspending={suspendMutation.isPending}
              debugOpen={debugOpen && (!isMobile || mobileDetailsOpen)}
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
        {isMobile && <nav aria-label="Conversation actions" className="flex shrink-0 border-t border-slate-800 bg-slate-950 px-2 pb-[env(safe-area-inset-bottom)]" data-testid="mobile-actions">
          <button type="button" onClick={openMobileChats} className="mobile-action"><Menu className="h-5 w-5" />Chats</button>
          <button type="button" disabled={!timeline?.boundSession || isBoundSessionSuspended(timeline.boundSession)} aria-expanded={mobileInputPanel === 'reply'} onClick={() => toggleMobileInput('reply')} className="mobile-action"><MessageSquare className="h-5 w-5" />Reply</button>
          <button type="button" disabled={!timeline?.boundSession || isBoundSessionSuspended(timeline.boundSession)} aria-expanded={mobileInputPanel === 'controls'} onClick={() => toggleMobileInput('controls')} className="mobile-action"><SlidersHorizontal className="h-5 w-5" />Controls</button>
        </nav>}
      </div>
      {workersOpen && <WorkerPanel onClose={() => setWorkersOpen(false)} />}
    </div>
  );
}

type RoutedShellProps = { kind: ConsoleRouteKind };

function RoutedAppShell({ kind }: RoutedShellProps) {
  const params = useParams();
  return <AppShell routeSelection={selectConsoleRoute(kind, params)} />;
}

export function ConsoleRoutes({ Shell = RoutedAppShell }: { Shell?: ComponentType<RoutedShellProps> }) {
  return (
    <Routes>
      <Route path="/" element={<Shell kind="home" />} />
      <Route path="/login" element={<Shell kind="login" />} />
      <Route path="/settings" element={<Shell kind="settings" />} />
      <Route path="/grants" element={<Shell kind="grants" />} />
      <Route path="/projects/:projectSlug" element={<Shell kind="project" />} />
      <Route path="/projects/:projectSlug/wiki" element={<Shell kind="wiki" />} />
      <Route path="/projects/:projectSlug/:provider" element={<Shell kind="provider" />} />
      <Route path="/projects/:projectSlug/:provider/:conversationRef" element={<Shell kind="conversation" />} />
      <Route path="*" element={<Shell kind="not-found" />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ConsoleRoutes />
    </BrowserRouter>
  );
}
