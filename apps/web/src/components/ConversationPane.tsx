import { RunFailureNotice } from './RunFailureNotice';
import { QueuedInputNotice } from './QueuedInputNotice';
import { PendingQuestionCard } from './PendingQuestionCard';
import { Check, ChevronDown, Copy, Link as LinkIcon, Pause, PlugZap, Send, Unplug, X } from 'lucide-react';
import { LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES, MODEL_PROFILE_KEYS, MODEL_PROFILE_SHORTCUTS, describeAutoRoute, isBoundSessionSuspended, visibleModelMatchesTarget, type AutoRoute, type FixedModelProfileKey, type ModelProfileKey, type ConversationTimeline, type ModelProfileRequest, type ProjectSummary, type ProviderId, type SessionKeystrokeRequest, type SessionInputResponse } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { api } from '../lib/api';
import { activeProfileTarget, type ModelProfilesState } from '../lib/model-profiles';
import { useClipboardImages } from '../features/conversation/useClipboardImages';
import { CONVERSATION_DRAG_TYPE, formatAgentReference, readConversationDrag } from '../features/conversation/agent-reference';
import { copyTextToClipboard } from '../lib/clipboard';
import { ExplorerPane, NavigationCrumbs } from '../features/conversation/ExplorerPane';
import { groupTranscriptTurns, shouldShowInMainTranscript, TranscriptDocumentTurn } from '../features/conversation/transcript-turns';
import { useConversationScrollController } from '../features/conversation/useConversationScrollController';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '../lib/useMediaQuery';

export type MobileInputPanel = 'reply' | 'controls' | null;

function useFrozenValue<T,>(value: T, frozen: boolean, resetKey?: string): T {
  const valueRef = useRef(value);
  const resetKeyRef = useRef(resetKey);
  const frozenRef = useRef(frozen);

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    valueRef.current = value;
  } else if (!frozen || !frozenRef.current) {
    valueRef.current = value;
  }
  frozenRef.current = frozen;

  return valueRef.current;
}

function MobileSummaryStrip({
  title,
  summary,
  className,
}: {
  title: string;
  summary?: string;
  className: string;
}) {
  return (
    <div className={clsx('px-4 py-3', className)}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
      {summary ? <div className="mt-1 truncate text-sm text-slate-200">{summary}</div> : null}
    </div>
  );
}

/** The synthesized session status: provider state, model and remaining context. */
function LiveSessionStatus({
  status,
  model,
  contextPercent,
  mobileCompact,
}: {
  status: string;
  model?: string;
  contextPercent?: number;
  mobileCompact: boolean;
}) {
  const statusText = status.trim() || 'Session active';
  const metaLine = [model, contextPercent !== undefined ? `${contextPercent}% left` : undefined]
    .filter(Boolean)
    .join(' · ') || undefined;

  if (mobileCompact) {
    return (
      <MobileSummaryStrip
        title="Status"
        summary={metaLine ? `${metaLine} · ${statusText}` : statusText}
        className="border-t border-slate-800 bg-slate-900/90"
      />
    );
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900/90 px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">Status</div>
      {metaLine && (
        <div className="mb-1 font-mono text-sm leading-6 text-slate-400">{metaLine}</div>
      )}
      <div className="font-mono text-sm leading-6 text-slate-300">{statusText}</div>
    </div>
  );
}

const MIN_BRIDGE_HEIGHT_PX = 96;
const MAX_BRIDGE_HEIGHT_VIEWPORT_RATIO = 0.6;
const BRIDGE_HEIGHT_STORAGE_KEY = 'agent-console:live-bridge-height';

function readStoredBridgeHeight(): number {
  const stored = globalThis.localStorage?.getItem(BRIDGE_HEIGHT_STORAGE_KEY);
  if (!stored) {
    return MIN_BRIDGE_HEIGHT_PX;
  }
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : MIN_BRIDGE_HEIGHT_PX;
}

function storeBridgeHeight(height: number): void {
  globalThis.localStorage?.setItem(BRIDGE_HEIGHT_STORAGE_KEY, String(height));
}

/** The unsent message of each conversation, so a rejected send or a reopened chat still has its text. */
const composerDraftStore = new Map<string, string>();

function storeComposerDraft(conversationKey: string, text: string): void {
  if (text) composerDraftStore.set(conversationKey, text);
  else composerDraftStore.delete(conversationKey);
}

function modelProfileLabel(profile: ModelProfileKey): string {
  return profile.charAt(0).toUpperCase() + profile.slice(1);
}

function modelProfileRequestStatus(request: ModelProfileRequest): string {
  const label = modelProfileLabel(request.profile);
  if (request.state === 'applying') return `Switching to ${label}…`;
  if (request.state === 'failed') return `Could not switch to ${label}: ${request.message}`;
  if (request.deferredReason === 'unsent_input') return `${label} queued until the pending message is sent or dismissed.`;
  return `${label} queued until this turn finishes.`;
}

/** The message box of a bound session: write a message, attach images, send it, or stop the running turn. */
function SessionComposer({
  csrfToken,
  sessionId,
  projectSlug,
  conversationKey,
  conversationRef,
  provider,
  onSendKeystrokes,
  onSetModelProfile,
  onCancelModelProfileRequest,
  compact,
  mobileCollapsible,
  bridgeOpen,
  onToggleBridge,
  mobileInputPanel,
  onCloseMobileInput,
  mobileChromeHidden,
  onToggleMobileChrome,
  latestAssistantMessage,
  activeModelProfile,
  autoRoute,
  modelProfiles,
  visibleModel,
  modelProfileRequest,
  queuedDraftText,
}: {
  csrfToken?: string;
  sessionId: string;
  projectSlug: string;
  conversationKey: string;
  conversationRef: string;
  provider: ConversationTimeline['conversation']['provider'];
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<SessionInputResponse | undefined>;
  onSetModelProfile: (sessionId: string, profile: ModelProfileKey) => Promise<boolean>;
  onCancelModelProfileRequest: (sessionId: string, requestId: string) => Promise<boolean>;
  compact: boolean;
  mobileCollapsible: boolean;
  bridgeOpen: boolean;
  onToggleBridge: () => void;
  mobileInputPanel?: MobileInputPanel;
  onCloseMobileInput?: () => void;
  mobileChromeHidden: boolean;
  onToggleMobileChrome: () => void;
  latestAssistantMessage: string;
  activeModelProfile?: ModelProfileKey;
  /** Auto state of the session: whether the next message is routed, and the router's latest decision. */
  autoRoute?: AutoRoute;
  modelProfiles: ModelProfilesState;
  visibleModel?: string;
  modelProfileRequest?: ModelProfileRequest;
  queuedDraftText?: string;
}) {
  const [draftText, setDraftText] = useState(() => composerDraftStore.get(conversationKey) ?? '');
  const [copyingLastMessage, setCopyingLastMessage] = useState(false);
  const [copiedLastMessage, setCopiedLastMessage] = useState(false);
  const [bridgeHeight, setBridgeHeight] = useState(readStoredBridgeHeight);
  const [mobileInputHeight, setMobileInputHeight] = useState(44);
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const bridgeHeightRef = useRef(bridgeHeight);
  const resizeSessionRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Stop goes out at once; a message sent after it waits for it, so Stop cannot land on the new turn.
  const pendingStopRef = useRef<Promise<void>>(Promise.resolve());
  const inputGenerationRef = useRef(0);
  const submissionDraftRef = useRef<string | undefined>(undefined);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const bridgeBusyRef = useRef(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const activeSessionIdRef = useRef(sessionId);
  activeSessionIdRef.current = sessionId;
  const [profileError, setProfileError] = useState<string>();
  const clipboardImages = useClipboardImages(conversationKey, sessionId, csrfToken);
  const [imageSubmitError, setImageSubmitError] = useState<string>();
  const [agentReferenceError, setAgentReferenceError] = useState<string>();
  const [agentDragOver, setAgentDragOver] = useState(false);
  const profileLevels = modelProfiles.status === 'ready' ? modelProfiles.profiles.providers[provider].levels : undefined;
  const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';
  const canSend = draftText.trim().length > 0 || clipboardImages.items.length > 0;

  async function applyModelProfile(profile: ModelProfileKey): Promise<void> {
    const targetSessionId = sessionId;
    setProfileBusy(true);
    const changed = await onSetModelProfile(targetSessionId, profile);
    setProfileBusy(false);
    if (activeSessionIdRef.current !== targetSessionId) return;
    setProfileError(changed ? undefined : 'Profile request failed.');
  }

  function requestModelProfile(profile: ModelProfileKey): void {
    void applyModelProfile(profile);
  }

  async function cancelModelProfileRequest(): Promise<void> {
    if (!modelProfileRequest || modelProfileRequest.state === 'applying') return;
    const targetSessionId = sessionId;
    setProfileBusy(true);
    const cancelled = await onCancelModelProfileRequest(targetSessionId, modelProfileRequest.requestId);
    setProfileBusy(false);
    if (activeSessionIdRef.current !== targetSessionId) return;
    setProfileError(cancelled ? undefined : 'Could not cancel the profile request.');
  }

  useEffect(() => {
    setProfileError(undefined);
  }, [sessionId]);

  useEffect(() => {
    const stop = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented
        || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
      event.preventDefault();
      void stopTurn();
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  });

  useEffect(() => {
    const onProfileShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      const profile = ({ a: 'auto', h: 'high', m: 'medium', l: 'low' } as const)[event.key.toLowerCase() as 'a' | 'h' | 'm' | 'l'];
      if (!profile) return;
      // The control stays disabled while the model list is missing; the keys follow it.
      if (modelProfiles.status !== 'ready') return;
      event.preventDefault();
      event.stopPropagation();
      requestModelProfile(profile);
    };
    window.addEventListener('keydown', onProfileShortcut, true);
    return () => window.removeEventListener('keydown', onProfileShortcut, true);
  }, [profileBusy, provider, sessionId, modelProfiles.status]);

  useEffect(() => {
    if (!mobileCollapsible) captureRef.current?.focus({ preventScroll: true });
  }, [sessionId, mobileCollapsible]);

  useEffect(() => {
    bridgeHeightRef.current = bridgeHeight;
  }, [bridgeHeight]);

  useEffect(() => {
    resizeCleanupRef.current?.();
    if (mobileCollapsible) return;
    const updateViewportHeight = () => updateBridgeHeight(bridgeHeightRef.current);
    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
    };
  }, [compact, mobileCollapsible, sessionId]);

  useLayoutEffect(() => {
    if (!bridgeOpen || (mobileCollapsible && mobileInputPanel !== 'reply')) return;
    captureRef.current?.focus({ preventScroll: true });
  }, [bridgeOpen, mobileCollapsible, mobileInputPanel]);

  useEffect(() => {
    storeComposerDraft(conversationKey, draftText);
  }, [conversationKey, draftText]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    resizeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    setCopiedLastMessage(false);
  }, [latestAssistantMessage]);

  useLayoutEffect(() => {
    if (!mobileCollapsible || mobileInputPanel !== 'reply') return;
    const resize = () => {
      const input = captureRef.current;
      if (!input) return;
      const cap = Math.max(44, Math.min(112, (window.visualViewport?.height ?? window.innerHeight) * 0.22));
      input.style.height = '0px';
      const height = Math.min(cap, Math.max(44, input.scrollHeight));
      input.style.height = `${height}px`;
      setMobileInputHeight(height);
    };
    resize();
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [draftText, mobileCollapsible, mobileInputPanel]);

  async function runBridgeAction<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (bridgeBusyRef.current) {
      return undefined;
    }

    const generation = inputGenerationRef.current;
    bridgeBusyRef.current = true;
    setBridgeBusy(true);
    try {
      return await action();
    } finally {
      if (generation === inputGenerationRef.current) {
        submissionDraftRef.current = undefined;
        bridgeBusyRef.current = false;
        setBridgeBusy(false);
      }
    }
  }

  function setBridgeTextareaValue(value: string): void {
    const capture = captureRef.current;
    if (!capture) {
      return;
    }
    capture.value = value;
    const end = value.length;
    capture.setSelectionRange(end, end);
    capture.scrollTop = capture.scrollHeight;
  }

  function clearDraftSubmitPreview(): void {
    flushSync(() => setDraftText(''));
    setBridgeTextareaValue('');
  }

  function restoreDraftSubmitPreview(text: string): void {
    // Authentication recovery may have unmounted the composer to show sign-in.
    storeComposerDraft(conversationKey, text);
    flushSync(() => setDraftText(text));
    setBridgeTextareaValue(text);
  }

  function replaceDraftText(text: string, cursor = text.length): void {
    setDraftText(text);
    window.requestAnimationFrame(() => {
      captureRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function dropAgentReference(event: DragEvent<HTMLTextAreaElement>): void {
    if (!event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    setAgentDragOver(false);
    if (bridgeBusyRef.current) return;
    const reference = readConversationDrag(event.dataTransfer);
    if (!reference) {
      setAgentReferenceError('This chat reference is invalid. Drag the chat again.');
      return;
    }
    const targetSessionId = sessionId;
    const generation = inputGenerationRef.current;
    const input = event.currentTarget;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setAgentReferenceError(undefined);
    void runBridgeAction(async () => {
      try {
        const resolved = await api.agentReference(reference);
        if (generation !== inputGenerationRef.current || activeSessionIdRef.current !== targetSessionId || captureRef.current !== input) return;
        const text = formatAgentReference(resolved);
        const before = draftText.slice(0, start);
        const after = draftText.slice(end);
        const inserted = `${before && !/\s$/.test(before) ? '\n' : ''}${text}\n`;
        replaceDraftText(before + inserted + after, before.length + inserted.length);
        input.focus({ preventScroll: true });
      } catch (error) {
        if (activeSessionIdRef.current === targetSessionId && captureRef.current === input) {
          setAgentReferenceError(error instanceof Error ? error.message : 'Cannot reference this agent.');
        }
      }
    });
  }

  /** Post one complete message. False when the server did not take it, or a Stop overtook it. */
  async function postMessage(text: string, withImages: boolean): Promise<boolean> {
    const generation = inputGenerationRef.current;
    const submittedText = text.trim();
    await pendingStopRef.current;
    if (generation !== inputGenerationRef.current) return false;
    const response = await onSendKeystrokes(sessionId, {
      ...(text ? { text } : {}),
      keys: ['Enter'],
      ...(submittedText ? { submittedText } : {}),
      ...(withImages ? { imageIds: clipboardImages.images.map(image => image.id) } : {}),
    });
    if (generation !== inputGenerationRef.current || !response) return false;
    if (withImages) clipboardImages.clear();
    if (mobileCollapsible && mobileInputPanel === 'reply') onCloseMobileInput?.();
    return true;
  }

  async function sendMessage(): Promise<void> {
    const text = draftText;
    const withImages = clipboardImages.items.length > 0;
    if (!text.trim() && !withImages) return;
    if (withImages && !clipboardImages.ready) {
      setImageSubmitError('Wait for the images to upload, or retry/remove failed images before sending.');
      return;
    }
    setImageSubmitError(undefined);
    await runBridgeAction(async () => {
      const generation = inputGenerationRef.current;
      submissionDraftRef.current = text;
      clearDraftSubmitPreview();
      const sent = await postMessage(text, withImages);
      if (!sent && generation === inputGenerationRef.current) restoreDraftSubmitPreview(text);
    });
  }

  async function stopTurn(): Promise<void> {
    // Stop must reach the server even while a previous send is pending.
    // Never send the held draft before interruption; it comes back into the message box.
    inputGenerationRef.current += 1;
    const heldDraft = submissionDraftRef.current ?? draftText;
    submissionDraftRef.current = undefined;
    restoreDraftSubmitPreview(heldDraft || queuedDraftText || '');
    bridgeBusyRef.current = false;
    setBridgeBusy(false);
    const stop = onSendKeystrokes(sessionId, { keys: ['Escape'] });
    pendingStopRef.current = stop.then(() => undefined, () => undefined);
    await stop;
  }

  async function handleCopyLatestAssistantMessage(): Promise<void> {
    setCopyingLastMessage(true);
    try {
      const freshTimeline = await api.timeline(projectSlug, provider, conversationRef);
      const nextAssistantMessage = [...freshTimeline.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
        ?.text;
      if (!nextAssistantMessage) {
        setCopiedLastMessage(false);
        return;
      }

      await copyTextToClipboard(nextAssistantMessage);
      setCopiedLastMessage(true);
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedLastMessage(false);
      }, 1500);
    } catch {
      setCopiedLastMessage(false);
    } finally {
      setCopyingLastMessage(false);
      captureRef.current?.focus({ preventScroll: true });
    }
  }

  function clampBridgeHeight(nextHeight: number): number {
    const viewportCap = Math.floor(window.innerHeight * MAX_BRIDGE_HEIGHT_VIEWPORT_RATIO);
    return Math.max(MIN_BRIDGE_HEIGHT_PX, Math.min(viewportCap, Math.round(nextHeight)));
  }

  function updateBridgeHeight(nextHeight: number): void {
    const clampedHeight = clampBridgeHeight(nextHeight);
    bridgeHeightRef.current = clampedHeight;
    setBridgeHeight(clampedHeight);
    storeBridgeHeight(clampedHeight);
  }

  function beginBridgeResize(pointerY: number): void {
    resizeCleanupRef.current?.();
    resizeSessionRef.current = {
      startY: pointerY,
      startHeight: bridgeHeightRef.current,
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      const active = resizeSessionRef.current;
      if (!active) {
        return;
      }
      const nextHeight = active.startHeight + (active.startY - event.clientY);
      updateBridgeHeight(nextHeight);
    };

    const endResize = () => {
      resizeSessionRef.current = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      if (resizeCleanupRef.current === endResize) {
        resizeCleanupRef.current = null;
      }
    };

    resizeCleanupRef.current = endResize;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }

  const stopButton = <button type="button" aria-label="Interrupt session" title="Stop the active turn without sending your draft"
    onPointerDown={event => event.preventDefault()} onClick={() => { void stopTurn(); }}
    className="min-h-11 rounded-xl border border-red-400/40 px-3 text-xs font-medium text-red-200 hover:bg-red-950">Stop</button>;

  function renderBridgeHeader(title: string, summary?: string): ReactNode {
    if (mobileCollapsible) {
      return <div className="flex h-12 items-center justify-between px-3">
        <span className="text-xs text-slate-400">{mobileInputPanel === 'controls' ? 'Session controls' : 'Reply'}</span>
        {stopButton}
        <button type="button" aria-label="Close input" onClick={onCloseMobileInput} className="flex h-10 w-11 items-center justify-center text-slate-300"><X className="h-4 w-4" /></button>
      </div>;
    }
    return <div className="mb-2 flex items-center justify-between gap-3 py-1">
      <div className="min-w-0 flex-1"><div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>{summary && <div className="mt-1 truncate text-sm text-slate-200">{summary}</div>}</div>
      {stopButton}
      <button type="button" aria-expanded={bridgeOpen} aria-label={bridgeOpen ? 'Collapse message box' : 'Expand message box'} onClick={onToggleBridge} className="rounded-xl border border-slate-700 p-2 text-slate-300"><ChevronDown className={clsx('h-4 w-4', bridgeOpen && 'rotate-180')} /></button>
      <button type="button" aria-label={mobileChromeHidden ? 'Show banners' : 'Hide banners'} onClick={onToggleMobileChrome} className="rounded-xl border border-slate-700 p-2 text-slate-300"><ChevronDown className={clsx('h-4 w-4', !mobileChromeHidden && 'rotate-180')} /></button>
    </div>;
  }

  const bridgeBodyClassName = mobileCollapsible ? (mobileInputPanel === 'reply' ? 'px-3 py-2' : 'flex flex-col px-3 pb-2') : 'px-4 py-4';
  const activeTarget = activeProfileTarget(modelProfiles, provider, activeModelProfile, autoRoute);
  const currentProfileMatchesVisibleModel = activeModelProfile
    ? (activeTarget ? visibleModelMatchesTarget(provider, activeTarget, visibleModel) : undefined) !== false
    : false;
  const profileLetters = MODEL_PROFILE_KEYS.map((profile) => MODEL_PROFILE_SHORTCUTS[profile]);
  const profileChoice = `${profileLetters.slice(0, -1).join(', ')}, or ${profileLetters.at(-1)}`;
  const autoLine = activeModelProfile === 'auto' ? describeAutoRoute(provider, autoRoute) : undefined;
  const displayedProfileStatus = profileError
    ?? (modelProfileRequest
      ? modelProfileRequestStatus(modelProfileRequest)
      : activeModelProfile && !currentProfileMatchesVisibleModel
        ? `Running: ${visibleModel} · select ${profileChoice}`
        : activeModelProfile
        ? `Current: ${modelProfileLabel(activeModelProfile)}`
        : `Existing session · choose ${profileChoice}`);
  const profileApplying = modelProfileRequest?.state === 'applying';
  const profilesReady = modelProfiles.status === 'ready';
  const autoWarning = autoRoute?.decision?.source === 'fallback' ? autoRoute.decision.warning : undefined;

  return (
    <div className={clsx('shrink-0 bg-slate-950/90', (!mobileCollapsible || mobileInputPanel) && 'border-t border-slate-800')} data-testid="input-panel">
      {(!mobileCollapsible || mobileInputPanel === 'controls') && renderBridgeHeader('Message', 'Expand to write a message.')}
      {bridgeOpen && (!mobileCollapsible || mobileInputPanel) && (
        <div className={bridgeBodyClassName}>
          {!mobileCollapsible && <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              aria-label="Resize message box"
              title="Drag to resize the message box"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                beginBridgeResize(event.clientY);
              }}
              className="flex h-11 flex-1 touch-none cursor-row-resize items-center justify-center rounded-xl text-slate-500 transition hover:text-slate-300"
            >
              <span className="h-1.5 w-16 rounded-full bg-slate-700/90" />
            </button>
            <button
              type="button"
              aria-label="Reset input height"
              disabled={bridgeHeight <= MIN_BRIDGE_HEIGHT_PX}
              onClick={() => updateBridgeHeight(MIN_BRIDGE_HEIGHT_PX)}
              className="h-11 touch-manipulation rounded-xl border border-slate-700 px-3 text-xs text-slate-300 disabled:opacity-50"
            >
              Smaller
            </button>
          </div>}
          {(!mobileCollapsible || mobileInputPanel === 'controls') && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Session model</div>
                <div className="text-xs text-slate-300">{displayedProfileStatus}</div>
                {modelProfiles.status === 'error' ? (
                  <div className="mt-1 text-xs text-rose-300" role="alert" data-testid="model-profiles-error">{modelProfiles.message}</div>
                ) : modelProfiles.status === 'loading' ? (
                  <div className="mt-1 text-[11px] text-slate-500">Loading model profiles…</div>
                ) : null}
                {autoLine ? (
                  <div className="mt-1 text-xs text-sky-200" data-testid="auto-route-line" title={autoLine.title}>{autoLine.line}</div>
                ) : null}
                {autoWarning ? (
                  <div className="mt-1 text-xs text-amber-300" role="status" data-testid="auto-route-warning">{autoWarning}</div>
                ) : null}
                {modelProfileRequest && modelProfileRequest.state !== 'applying' ? (
                  <button
                    type="button"
                    className="mt-1 text-[11px] text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-slate-200 disabled:opacity-50"
                    disabled={profileBusy}
                    onClick={() => { void cancelModelProfileRequest(); }}
                  >
                    Cancel queued profile
                  </button>
                ) : null}
              </div>
              <div className="flex" aria-label={`${providerLabel} model profile`}>
                {MODEL_PROFILE_KEYS.map((profile) => {
                  const level = profile === 'auto' ? undefined : profileLevels?.[profile as FixedModelProfileKey];
                  const shortcut = MODEL_PROFILE_SHORTCUTS[profile];
                  return (
                    <button
                      key={profile}
                      type="button"
                      disabled={!profilesReady || profileBusy || profileApplying}
                      aria-label={`Use ${profile} ${providerLabel} profile`}
                      aria-pressed={activeModelProfile === profile && currentProfileMatchesVisibleModel}
                      title={profile === 'auto'
                        ? `auto: the router picks a model when you send your next message (Alt ${shortcut})`
                        : level
                          ? `${profile}: ${level.launchName} / ${level.effort} (Alt ${shortcut})`
                          : `${profile} (Alt ${shortcut})`}
                      onClick={() => requestModelProfile(profile)}
                      className={clsx(
                        '-ml-px border border-slate-700 px-3 py-1.5 text-xs first:ml-0 first:rounded-l-lg last:rounded-r-lg disabled:opacity-50',
                        activeModelProfile === profile && currentProfileMatchesVisibleModel
                          ? 'bg-sky-500/20 text-sky-100'
                          : modelProfileRequest?.profile === profile
                            ? 'bg-amber-500/15 text-amber-100'
                            : 'bg-slate-950 text-slate-300 hover:bg-slate-800',
                      )}
                    >
                      {shortcut}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {(!mobileCollapsible || mobileInputPanel === 'reply') && clipboardImages.items.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2" aria-label="Attached images">
              {clipboardImages.items.map(item => (
                <div key={item.localId} className="relative rounded-lg border border-slate-700 bg-slate-900 p-2">
                  {item.image ? (
                    <img src={`/api/images/${encodeURIComponent(item.image.id)}`} alt={item.image.name} className="h-20 max-w-40 object-contain" />
                  ) : item.error ? (
                    <div className="max-w-64 text-xs text-red-300" role="alert">
                      {item.error}
                      <button type="button" onClick={() => { void clipboardImages.retry(item); }} disabled={bridgeBusy} className="ml-2 underline">Retry upload</button>
                    </div>
                  ) : <div role="status" className="text-xs text-slate-300">Uploading image…</div>}
                  <button type="button" aria-label="Remove attached image" disabled={bridgeBusy} onClick={() => clipboardImages.remove(item.localId)} className="absolute -right-1 -top-1 rounded-full bg-slate-700 px-1.5 text-white">×</button>
                </div>
              ))}
            </div>
          )}
          {(clipboardImages.error || imageSubmitError) && <div role="alert" className="mb-2 text-xs text-red-300">{clipboardImages.error ?? imageSubmitError}</div>}
          {agentReferenceError && <div role="alert" className="mb-2 text-xs text-red-300">{agentReferenceError}</div>}
          {(!mobileCollapsible || mobileInputPanel === 'reply') && <div className={mobileCollapsible ? 'flex items-end gap-2' : undefined}>
          <textarea
            aria-label="Message"
            placeholder={mobileCollapsible ? 'Message the agent…' : undefined}
            ref={captureRef}
            readOnly={bridgeBusy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint={mobileCollapsible ? 'enter' : 'send'}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = bridgeBusy ? 'none' : 'copy';
              setAgentDragOver(!bridgeBusy);
            }}
            onDragLeave={() => setAgentDragOver(false)}
            onDrop={dropAgentReference}
            onChange={(event) => {
              if (bridgeBusy) {
                return;
              }
              setDraftText(event.target.value);
            }}
            onPaste={(event) => {
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              const files = event.clipboardData.files
                ? Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
                : [];
              if (files.length) {
                event.preventDefault();
                clipboardImages.paste(files);
                const text = event.clipboardData.getData('text/plain');
                if (text) {
                  const input = event.currentTarget;
                  replaceDraftText(draftText.slice(0, input.selectionStart) + text + draftText.slice(input.selectionEnd));
                }
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                void stopTurn();
                return;
              }
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !mobileCollapsible) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            onBeforeInput={(event) => {
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              const nativeEvent = event.nativeEvent as InputEvent;
              if (nativeEvent.isComposing) {
                return;
              }
              if (!mobileCollapsible && nativeEvent.inputType === 'insertLineBreak') {
                event.preventDefault();
                void sendMessage();
              }
            }}
            rows={mobileCollapsible ? 1 : 3}
            value={draftText}
            style={{ height: `${mobileCollapsible ? mobileInputHeight : bridgeHeight}px` }}
            className={clsx(
              'w-full resize-none overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-400',
              mobileCollapsible && 'min-w-0 flex-1 !rounded-xl !px-3 !py-2 !font-sans !text-base',
              agentDragOver && 'ring-2 ring-sky-400',
            )}
          />
          {mobileCollapsible && <button type="button" aria-label="Send message" disabled={bridgeBusy || !canSend} onPointerDown={event => event.preventDefault()} onClick={() => { void sendMessage(); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-slate-950 disabled:opacity-40"><Send className="h-5 w-5" /></button>}
          {mobileCollapsible && stopButton}
          {mobileCollapsible && <button type="button" aria-label="Close input" onClick={onCloseMobileInput} className="flex h-11 w-8 shrink-0 items-center justify-center text-slate-400"><ChevronDown className="h-5 w-5" /></button>}
          </div>}
          {(!mobileCollapsible || mobileInputPanel === 'controls') && (
            <div className={clsx("mt-3 flex flex-wrap gap-2", mobileCollapsible && "order-first")}>
              {!mobileCollapsible && (
                <button
                  type="button"
                  aria-label="Send message"
                  disabled={bridgeBusy || !canSend}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void sendMessage();
                    captureRef.current?.focus({ preventScroll: true });
                  }}
                  className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Send
                </button>
              )}
              <button
                type="button"
                aria-label="Copy latest assistant message"
                title={copyingLastMessage ? 'Loading latest assistant message…' : 'Copy latest assistant message'}
                disabled={copyingLastMessage}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  void handleCopyLatestAssistantMessage();
                }}
                className={clsx(
                  'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition',
                  copiedLastMessage
                    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                    : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
                  copyingLastMessage && 'cursor-not-allowed opacity-60',
                )}
                >
                  {copiedLastMessage ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ConversationPaneProps {
  csrfToken?: string;
  projects?: ProjectSummary[];
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
  timeline?: ConversationTimeline;
  liveMode: boolean;
  resumeError?: string;
  resuming?: boolean;
  onRetryResume: () => Promise<void>;
  loading: boolean;
  workMode: boolean;
  mobileChromeHidden: boolean;
  onToggleMobileChrome: () => void;
  mobileInputPanel?: MobileInputPanel;
  onCloseMobileInput?: () => void;
  onOpenChats?: () => void;
  mobileDetailsOpen?: boolean;
  onBind: (options?: { confirmExternalHandoff?: boolean }) => Promise<void>;
  onRelease: (sessionId: string) => Promise<void>;
  onSuspend: (sessionId: string) => Promise<void>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<SessionInputResponse | undefined>;
  modelProfiles: ModelProfilesState;
  onSetModelProfile: (sessionId: string, profile: ModelProfileKey) => Promise<boolean>;
  onCancelModelProfileRequest: (sessionId: string, requestId: string) => Promise<boolean>;
  binding: boolean;
  releasing: boolean;
  suspending: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => Promise<void>;
  conversationKey?: string;
  historyPrependVersion: number;
  tailKey?: string;
}

export function ConversationPane({
  csrfToken,
  projects,
  project,
  selectedProvider,
  timeline,
  liveMode,
  resumeError,
  resuming,
  onRetryResume,
  loading,
  workMode,
  mobileChromeHidden,
  onToggleMobileChrome,
  mobileInputPanel = null,
  onCloseMobileInput,
  onOpenChats,
  mobileDetailsOpen = false,
  onBind,
  onRelease,
  onSuspend,
  onSendKeystrokes,
  modelProfiles,
  onSetModelProfile,
  onCancelModelProfileRequest,
  binding,
  releasing,
  suspending,
  hasOlderMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  conversationKey,
  historyPrependVersion,
  tailKey,
}: ConversationPaneProps) {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [desktopBridgeOpen, setDesktopBridgeOpen] = useState(true);
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false);
  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const boundSession = timeline?.boundSession;
  const liveScreen = timeline?.liveScreen;
  const compactLiveLayout = workMode && liveMode;
  const hideTopPanel = isMobile ? !mobileDetailsOpen : mobileChromeHidden;
  const largeTranscriptDismissKey = conversationKey ? `ac:large-chat-warning-dismissed:${conversationKey}` : undefined;
  const [largeTranscriptWarningDismissed, setLargeTranscriptWarningDismissed] = useState(false);
  useEffect(() => {
    setLargeTranscriptWarningDismissed(
      Boolean(largeTranscriptDismissKey && window.localStorage.getItem(largeTranscriptDismissKey)),
    );
  }, [largeTranscriptDismissKey]);
  const largeTranscriptWarningVisible = Boolean(
    timeline
    && typeof timeline.transcriptSizeBytes === 'number'
    && timeline.transcriptSizeBytes >= LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES
    && !largeTranscriptWarningDismissed,
  );
  function dismissLargeTranscriptWarning(): void {
    setLargeTranscriptWarningDismissed(true);
    if (largeTranscriptDismissKey) {
      window.localStorage.setItem(largeTranscriptDismissKey, new Date().toISOString());
    }
  }
  useEffect(() => {
    setHandoffDialogOpen(false);
    setHandoffConfirmed(false);
  }, [conversationKey]);

  const isClosedConversation = !boundSession && Boolean(timeline?.conversation.lastClosedAt);
  const isExternalClaude = timeline?.conversation.provider === 'claude' && !boundSession && !isClosedConversation;
  const bindActionLabel = isClosedConversation ? 'Resume' : isExternalClaude ? 'Move to Agent Console' : 'Bind / resume';
  const conversationStatus = boundSession ? 'Bound' : isClosedConversation ? 'Closed' : isExternalClaude ? 'Outside Agent Console' : 'Not bound';

  function requestBind(): void {
    if (isExternalClaude) {
      setHandoffConfirmed(false);
      setHandoffDialogOpen(true);
      return;
    }
    void onBind();
  }

  async function confirmExternalHandoff(): Promise<void> {
    await onBind({ confirmExternalHandoff: true });
    setHandoffDialogOpen(false);
  }

  const externalHandoffDialog = handoffDialogOpen ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4" role="dialog" aria-modal="true" aria-labelledby="external-handoff-title">
      <div className="w-full max-w-lg rounded-2xl border border-amber-400/30 bg-slate-950 p-5 shadow-panel">
        <h2 id="external-handoff-title" className="text-lg font-semibold text-slate-100">Move this Claude chat to Agent Console?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          If this chat is running in another terminal, stop that session first to avoid two Claudes working in the same chat. Agent Console will then resume this exact conversation in its managed workspace.
        </p>
        <p className="mt-2 text-sm leading-6 text-amber-200">
          Unsubmitted text in another terminal will not transfer.
        </p>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={handoffConfirmed}
            onChange={(event) => setHandoffConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-500"
          />
          <span>This chat is not running outside Agent Console.</span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setHandoffDialogOpen(false)}
            disabled={binding}
            className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-900 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmExternalHandoff()}
            disabled={!handoffConfirmed || binding}
            className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PlugZap className="h-4 w-4" />
            {binding ? 'Starting…' : 'Start in Agent Console'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const historyMessages = useMemo(() => timeline?.messages ?? [], [timeline?.messages]);
  const showHistory = historyMessages.length > 0;
  const latestAssistantMessage = useMemo(() => {
    for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
      const message = historyMessages[index];
      if (message?.role === 'assistant') {
        return message.text;
      }
    }
    return '';
  }, [historyMessages]);
  const activeSurface = showHistory || hasOlderMessages || loadingOlderMessages
    ? 'history'
    : (liveMode ? 'live' : 'empty');
  const layoutKey = [
    hideTopPanel ? 'top:hidden' : 'top:shown',
    isMobile ? `input:${mobileInputPanel}` : `bridge:${desktopBridgeOpen}`,
    `surface:${activeSurface}`,
    compactLiveLayout ? 'layout:compact' : 'layout:regular',
    isMobile ? 'viewport:mobile' : 'viewport:desktop',
  ].join('|');
  const { scrollRef, selectionActive } = useConversationScrollController({
    conversationKey,
    activeSurface,
    tailKey,
    layoutKey,
    historyPrependVersion,
    hasOlderHistory: hasOlderMessages,
    loadingOlderHistory: loadingOlderMessages,
    onLoadOlderHistory: onLoadOlderMessages,
    loading,
  });
  const historyRenderState = useMemo(() => ({
    messages: historyMessages,
    hasOlderMessages,
    loadingOlderMessages,
  }), [hasOlderMessages, historyMessages, loadingOlderMessages]);
  const renderedHistoryState = useFrozenValue(historyRenderState, selectionActive, conversationKey);
  const renderedHistoryMessages = renderedHistoryState.messages;
  const renderedHasOlderMessages = renderedHistoryState.hasOlderMessages;
  const renderedLoadingOlderMessages = renderedHistoryState.loadingOlderMessages;
  const visibleHistoryMessages = useMemo(
    () => renderedHistoryMessages.filter(shouldShowInMainTranscript),
    [renderedHistoryMessages],
  );
  const renderedShowMessages = visibleHistoryMessages.length > 0;
  const renderedHistoryTurns = useMemo(
    () => groupTranscriptTurns(visibleHistoryMessages),
    [visibleHistoryMessages],
  );
  if (!timeline) {
    if (loading && selectedProvider && project) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-slate-400">
          <div>
            <div className="mb-2 text-lg font-medium text-slate-200">Loading conversation…</div>
            <div>Fetching saved history and live session state.</div>
          </div>
        </div>
      );
    }
    if (isMobile) {
      return <div className="flex h-full items-center justify-center p-6 text-center text-slate-400"><div>
        <div className="mb-2 text-lg text-slate-100">Your conversations</div>
        <p className="mb-4 text-sm">Choose an active chat or start a new one.</p>
        <button type="button" onClick={onOpenChats} className="min-h-11 rounded-xl border border-sky-400/30 px-4 text-sky-200">Open chats</button>
      </div></div>;
    }
    if (workMode) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <div className="text-lg font-medium text-slate-100">Work mode</div>
            <div className="mt-2 text-sm text-slate-400">{isMobile ? 'Open Chats to choose a conversation or start a new one.' : 'Select a bound session from the left pane or start a new Codex or Claude session there.'}</div>
          </div>
        </div>
      );
    }
    return <ExplorerPane projects={projects} project={project} selectedProvider={selectedProvider} />;
  }

  if (!isMobile && workMode && !boundSession) {
    return (
      <>
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <div className="text-lg font-medium text-slate-100">{timeline.conversation.title}</div>
            <div className="mt-2 text-sm text-slate-400">
              {isClosedConversation
                ? 'This conversation is closed. Resume it to continue in Agent Console.'
                : isExternalClaude
                ? 'This Claude chat is not currently managed by Agent Console. If it is running in another terminal, stop that session before starting it here.'
                : 'This conversation is not currently bound. Start a new session from the left pane, or bind this one to continue working here.'}
            </div>
            <div className="mt-5">
              <button
                type="button"
                onClick={requestBind}
                disabled={binding}
                className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
              >
                <PlugZap className="h-4 w-4" />
                {bindActionLabel}
              </button>
            </div>
          </div>
        </div>
        {externalHandoffDialog}
      </>
    );
  }

  const proxyLinks = project?.allowedLocalhostPorts ?? [];
  const sessionSuspended = isBoundSessionSuspended(boundSession);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {boundSession?.queuedInputs?.length ? <QueuedInputNotice sessionId={boundSession.id} inputs={boundSession.queuedInputs} csrfToken={csrfToken} compact={isMobile} /> : null}
      {boundSession?.runFailure && !sessionSuspended && <RunFailureNotice failure={boundSession.runFailure}
        onStop={() => { void onSendKeystrokes(boundSession.id, { keys: ['Escape'] }); }} />}
      {sessionSuspended && (
        <div className="border-b border-slate-700 bg-slate-800/70 px-4 py-2 text-sm text-slate-200">
          {resumeError ? `Unable to resume: ${resumeError}` : resuming ? 'Resuming suspended session…' : boundSession?.pressureSuspendedAt ? 'Session suspended to free memory.' : boundSession?.idleSuspendedAt ? 'Session asleep after extended idle.' : 'Session suspended.'}
          {!resuming && <button type="button" onClick={() => { void onRetryResume(); }} className="ml-3 text-sky-300 hover:text-sky-200">{resumeError ? 'Retry' : 'Resume'}</button>}
        </div>
      )}
      {!hideTopPanel && (
        isMobile ? (
          <div className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
            <MobileSummaryStrip
              title="Conversation"
              summary={[
                timeline.conversation.title,
                conversationStatus,
                timeline.conversation.degraded ? 'Degraded parse' : undefined,
              ].filter(Boolean).join(' · ')}
              className=""
            />
            <div className="flex flex-wrap gap-2 px-4 pb-3">
              {boundSession ? (
                <>
                  <button
                    type="button"
                    onClick={() => onSuspend(boundSession.id)}
                    disabled={suspending || releasing || sessionSuspended}
                    title="Keep this conversation in Work and resume it when selected again"
                    className="inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-60"
                  >
                    <Pause className="h-4 w-4" />
                    Suspend
                  </button>
                  <button
                    type="button"
                    onClick={() => onRelease(boundSession.id)}
                    disabled={releasing || suspending}
                    className="inline-flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-60"
                  >
                    <Unplug className="h-4 w-4" />
                    Release
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={requestBind}
                  disabled={binding}
                  className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
                >
                  <PlugZap className="h-4 w-4" />
                  {bindActionLabel}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="border-b border-slate-800 bg-slate-950/90 px-4 py-4 backdrop-blur">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <NavigationCrumbs project={project} selectedProvider={timeline.conversation.provider} conversationTitle={timeline.conversation.title} />
                <h1 className="truncate text-xl font-semibold text-white">{timeline.conversation.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className={clsx('rounded-full border px-2.5 py-1', boundSession ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 text-slate-400')}>
                    {conversationStatus}
                  </span>
                  {timeline.conversation.degraded && (
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-amber-300">Degraded parse</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {boundSession ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onSuspend(boundSession.id)}
                      disabled={suspending || releasing || sessionSuspended}
                      title="Keep this conversation in Work and resume it when selected again"
                      className="inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-60"
                    >
                      <Pause className="h-4 w-4" />
                      Suspend
                    </button>
                    <button
                      type="button"
                      onClick={() => onRelease(boundSession.id)}
                      disabled={releasing || suspending}
                      className="inline-flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-60"
                    >
                      <Unplug className="h-4 w-4" />
                      Release
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={requestBind}
                    disabled={binding}
                    className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
                  >
                    <PlugZap className="h-4 w-4" />
                    {bindActionLabel}
                  </button>
                )}
              </div>
            </div>

            {proxyLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {proxyLinks.map((port) => (
                  <a
                    key={port}
                    href={`/proxy/${encodeURIComponent(project!.slug)}/${port}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10"
                  >
                    <LinkIcon className="h-4 w-4 text-sky-300" />
                    localhost:{port}
                  </a>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {largeTranscriptWarningVisible && (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          <span>
            This chat&apos;s transcript is {Math.round((timeline.transcriptSizeBytes ?? 0) / (1024 * 1024))}MB.
            Beyond {Math.round(LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES / (1024 * 1024))}MB, completed messages only
            appear after each turn finishes — consider starting a new chat for snappier updates.
          </span>
          <button
            type="button"
            onClick={dismissLargeTranscriptWarning}
            className="ml-auto shrink-0 rounded-lg border border-amber-400/30 px-2 py-1 text-amber-200 transition hover:bg-amber-500/20"
          >
            Dismiss
          </button>
        </div>
      )}

      {isExternalClaude && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span className="min-w-0 flex-1">This Claude chat is not currently managed by Agent Console. If it is running in another terminal, stop that session before starting it here.</span>
          <button
            type="button"
            onClick={requestBind}
            disabled={binding}
            className="shrink-0 rounded-xl border border-amber-300/30 bg-slate-950/30 px-3 py-2 text-sm text-amber-100 transition hover:bg-slate-950/50 disabled:opacity-60"
          >
            Move to Agent Console
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        data-testid="conversation-scroll"
        className="scrollbar-thin flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5"
      >
        {renderedShowMessages || renderedHasOlderMessages || renderedLoadingOlderMessages ? (
          <div className="w-full pb-5">
            <div className="divide-y divide-slate-900/80">
              {(renderedHasOlderMessages || renderedLoadingOlderMessages) && (
                <div className="text-center text-xs text-slate-500">
                  {renderedLoadingOlderMessages ? 'Loading earlier messages…' : 'Scroll up to load earlier messages'}
                </div>
              )}
              {renderedHistoryTurns.map((turn) => (
                <TranscriptDocumentTurn key={turn.id} turn={turn} />
              ))}
            </div>
          </div>
        ) : boundSession ? (
          <div className="mx-auto max-w-2xl rounded-md border border-dashed border-slate-700 p-6 text-center text-slate-400">
            Send a message to start this session.
          </div>
        ) : (
          <div className="mx-auto max-w-2xl rounded-md border border-dashed border-slate-700 p-6 text-center text-slate-400">
            {isClosedConversation ? 'No saved transcript yet. Resume this conversation to continue.' : 'No saved transcript yet. Bind this conversation and use the composer below to drive the live session.'}
          </div>
        )}
      </div>

      {boundSession?.pendingRequests?.length ? <PendingQuestionCard sessionId={boundSession.id} requests={boundSession.pendingRequests} csrfToken={csrfToken} /> : null}
      {sessionSuspended ? (
        <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4 text-sm text-slate-400">
          Resume this session to send messages.
        </div>
      ) : boundSession ? (
        <SessionComposer
          csrfToken={csrfToken}
          key={`${timeline.conversation.projectSlug}:${timeline.conversation.provider}:${timeline.conversation.ref}`}
          sessionId={boundSession.id}
          queuedDraftText={boundSession.queuedInputs?.at(-1)?.text}
          projectSlug={timeline.conversation.projectSlug}
          conversationKey={`${timeline.conversation.projectSlug}:${timeline.conversation.provider}:${timeline.conversation.ref}`}
          conversationRef={timeline.conversation.ref}
          provider={timeline.conversation.provider}
          onSendKeystrokes={onSendKeystrokes}
          modelProfiles={modelProfiles}
          onSetModelProfile={onSetModelProfile}
          onCancelModelProfileRequest={onCancelModelProfileRequest}
          compact={compactLiveLayout}
          mobileCollapsible={isMobile}
          bridgeOpen={isMobile || desktopBridgeOpen}
          onToggleBridge={() => setDesktopBridgeOpen((current) => !current)}
          mobileInputPanel={mobileInputPanel}
          onCloseMobileInput={onCloseMobileInput}
          mobileChromeHidden={mobileChromeHidden}
          onToggleMobileChrome={onToggleMobileChrome}
          latestAssistantMessage={latestAssistantMessage}
          activeModelProfile={boundSession.provider === 'codex' ? boundSession.codexProfile : boundSession.claudeProfile}
          autoRoute={boundSession.autoRoute}
          visibleModel={liveScreen?.model}
          modelProfileRequest={boundSession.modelProfileRequest}
        />
      ) : (
        <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4 text-sm text-slate-400">
          <div>{isClosedConversation ? 'This conversation is closed. Resume it to continue in Agent Console.' : isExternalClaude ? 'This chat is read-only here until you move it into Agent Console.' : 'Bind this conversation to send messages.'}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={requestBind}
              disabled={binding}
              className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
            >
              <PlugZap className="h-4 w-4" />
              {bindActionLabel}
            </button>
            {!isMobile && mobileChromeHidden && (
              <button
                type="button"
                onClick={onToggleMobileChrome}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                <ChevronDown className="h-4 w-4 rotate-180" />
                Show banners
              </button>
            )}
          </div>
        </div>
      )}

      {liveMode && liveScreen && (!isMobile || mobileInputPanel === 'controls') && (
        <LiveSessionStatus
          status={liveScreen.status}
          model={liveScreen.model ?? timeline?.conversation.model}
          contextPercent={liveScreen.contextPercent}
          mobileCompact={isMobile}
        />
      )}

      {externalHandoffDialog}
    </div>
  );
}
