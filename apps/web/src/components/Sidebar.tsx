import { Bot, Check, FolderTree, GripVertical, Link as LinkIcon, LoaderCircle, Menu, Pencil, Plus, RefreshCcw, Search, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ConversationSearchResult, ProjectSummary, ProviderId, SessionFreshnessThresholds, TreeResponse } from '@agent-console/shared';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import { deriveSidebarProjects, type SidebarProject } from '../features/navigation/sidebar-projects';

const enabledToggleClassName = 'border-emerald-500/45 bg-emerald-500/12 text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-500/16';
const summaryPanelMargin = 12;

function providerMeta(provider: ProviderId) {
  return provider === 'codex'
    ? { label: 'Codex', icon: Sparkles }
    : { label: 'Claude', icon: Bot };
}

interface SidebarProps {
  tree?: TreeResponse;
  open: boolean;
  onClose: () => void;
  workMode: boolean;
  onToggleWorkMode: () => void;
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
  sessionFreshnessThresholds: SessionFreshnessThresholds;
  onToggleRecentActivity: () => Promise<void>;
  onReorderProjects: (sourceSlug: string, targetSlug: string) => Promise<void>;
  onNewConversation: (projectSlug: string, provider: ProviderId) => void;
  onRenameProject: (project: ProjectSummary, displayName?: string) => Promise<boolean>;
  onRebindConversation: (projectSlug: string, provider: ProviderId, conversationRef: string) => Promise<boolean>;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  creatingConversationKey?: string;
  renamingProjectKey?: string;
  rebindingConversationKey?: string;
  renamingConversationKey?: string;
  updatingUiPreferences: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}

type ConversationItem = ProjectSummary['providers'][ProviderId]['conversations'][number];

interface SummaryPanelLayout {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getConversationFreshnessClass(
  isBound: boolean,
  freshnessTimestamp: string | undefined,
  thresholds: SessionFreshnessThresholds,
  nowMs: number,
): string {
  if (!isBound) {
    return 'border border-slate-700 bg-transparent';
  }

  const parsedTime = freshnessTimestamp ? Date.parse(freshnessTimestamp) : Number.NaN;
  if (!Number.isFinite(parsedTime)) {
    return 'bg-emerald-400';
  }

  const ageMinutes = Math.max(0, nowMs - parsedTime) / 60_000;
  if (ageMinutes >= thresholds.redMinutes) {
    return 'bg-rose-500';
  }
  if (ageMinutes >= thresholds.yellowMinutes) {
    return 'bg-amber-400';
  }
  return 'bg-emerald-400';
}

function formatRelativeAge(timestamp: string | undefined, nowMs: number): string {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return 'unknown';
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (ageSeconds < 60) {
    return 'just now';
  }
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 48) {
    return `${ageHours}h ago`;
  }
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays}d ago`;
}

function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHighlightTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms
    .filter((term) => term.length > 1 || /^\d$/.test(term))
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function renderHighlightedText(text: string, query: string): ReactNode {
  const terms = getHighlightTerms(query);
  if (terms.length === 0) {
    return text;
  }
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'igu');
  return text.split(pattern).map((part, index) => (
    terms.some((term) => term.toLowerCase() === part.toLowerCase())
      ? <span key={`${part}:${index}`} className="rounded bg-sky-400/20 text-sky-100">{part}</span>
      : part
  ));
}

function calculateSummaryPanelLayout(panelElement: HTMLElement): SummaryPanelLayout {
  const panelRect = panelElement.getBoundingClientRect();
  const panelTop = Math.max(summaryPanelMargin, panelRect.top + summaryPanelMargin);
  const panelBottom = Math.min(window.innerHeight - summaryPanelMargin, panelRect.bottom - summaryPanelMargin);
  const left = Math.max(summaryPanelMargin, panelRect.left + summaryPanelMargin);
  const right = Math.min(window.innerWidth - summaryPanelMargin, panelRect.right - summaryPanelMargin);
  const width = Math.max(240, right - left);
  return {
    top: Math.round(panelTop),
    left: Math.round(left),
    width: Math.round(width),
    height: Math.max(0, Math.round(panelBottom - panelTop)),
  };
}

function SearchResultsPanel({
  query,
  results,
  loading,
  error,
  onClose,
}: {
  query: string;
  results: ConversationSearchResult[];
  loading: boolean;
  error?: string;
  onClose: () => void;
}) {
  const nowMs = useNowMs();
  if (!query.trim()) {
    return null;
  }
  if (loading && results.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-sm text-slate-400">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Searching...
      </div>
    );
  }
  if (error && results.length === 0) {
    return <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm text-rose-100">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-400">No matching chats.</div>;
  }
  return (
    <div className="space-y-4">
      {(loading || error) && (
        <div className={clsx(
          'flex items-center gap-2 px-2 text-xs',
          error ? 'text-rose-300' : 'text-slate-500',
        )}>
          {loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {error ? error : 'Refreshing results...'}
        </div>
      )}
      <div className="space-y-1">
        {results.map((result) => {
          const meta = providerMeta(result.provider);
          const ProviderIcon = meta.icon;
          return (
            <section key={`${result.projectSlug}:${result.provider}:${result.conversationRef}:${result.timestamp}`}>
              <Link
                to={`/projects/${encodeURIComponent(result.projectSlug)}`}
                onClick={onClose}
                className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 text-slate-100 transition hover:bg-slate-800/60"
              >
                <FolderTree className="h-4 w-4 shrink-0 text-sky-300" />
                <span className="min-w-0 flex-1 truncate font-medium">{result.projectDisplayName}</span>
              </Link>
              <div className="ml-7 border-l border-slate-800 pl-3">
                <Link
                  to={`/projects/${encodeURIComponent(result.projectSlug)}/${result.provider}/${encodeURIComponent(result.conversationRef)}`}
                  onClick={onClose}
                  className="block rounded-xl px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800/70 hover:text-white"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', result.isBound ? 'bg-emerald-400' : 'border border-slate-700 bg-transparent')} />
                    <ProviderIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-100">
                      {renderHighlightedText(result.conversationTitle, query)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs uppercase text-slate-500">{meta.label} · {formatRelativeAge(result.conversationUpdatedAt, nowMs)}</div>
                  <p className="mt-1 line-clamp-3 break-words text-xs leading-5 text-slate-400">
                    {renderHighlightedText(result.snippet, query)}
                  </p>
                </Link>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ConversationLink({
  project,
  provider,
  conversationRef,
  title,
  prefixLabel,
  isBound,
  canRebind,
  onClose,
  onRebindConversation,
  onRenameConversation,
  rebinding,
  renaming,
  sessionSummary,
  lastInteractionAt,
  sessionFreshnessThresholds,
  summaryPanelRef,
}: {
  project: ProjectSummary;
  provider: ProviderId;
  conversationRef: string;
  title: string;
  prefixLabel?: string;
  isBound: boolean;
  canRebind: boolean;
  onClose: () => void;
  onRebindConversation: (projectSlug: string, provider: ProviderId, conversationRef: string) => Promise<boolean>;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  rebinding: boolean;
  renaming: boolean;
  sessionSummary?: ConversationItem['sessionSummary'];
  lastInteractionAt?: string;
  sessionFreshnessThresholds: SessionFreshnessThresholds;
  summaryPanelRef: RefObject<HTMLDivElement | null>;
}) {
  const location = useLocation();
  const nowMs = useNowMs();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLayout, setSummaryLayout] = useState<SummaryPanelLayout>();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const summaryTimerRef = useRef<number | undefined>(undefined);
  const href = `/projects/${encodeURIComponent(project.slug)}/${provider}/${encodeURIComponent(conversationRef)}`;
  const active = location.pathname === href;
  const summaryTimestamp = sessionSummary?.lastInteractionAt ?? lastInteractionAt;
  const indicatorClassName = getConversationFreshnessClass(isBound, summaryTimestamp, sessionFreshnessThresholds, nowMs);
  const summaryReady = sessionSummary?.status === 'ready';
  const lastHourSummaryTimestamp = sessionSummary?.windowEndAt;
  const lastHourSummaryAge = lastHourSummaryTimestamp ? formatRelativeAge(lastHourSummaryTimestamp, nowMs) : undefined;
  const lastHourSummaryLabel = lastHourSummaryAge
    ? `Last hour summary from ${lastHourSummaryAge}`
    : 'Last hour summary pending';
  const mainSummaryText = summaryReady
    ? sessionSummary.chatSummary ?? 'No user or agent conversation summary is available yet.'
    : sessionSummary?.status === 'failed' ? 'Summary unavailable.' : 'Summary pending.';
  const lastHourSummaryText = summaryReady
    ? sessionSummary.recentChangesSummary ?? 'No transcript activity in the last hour.'
    : sessionSummary?.status === 'failed' ? 'Summary unavailable.' : 'Summary pending.';

  const updateSummaryLayout = useCallback(() => {
    const panelElement = summaryPanelRef.current;
    if (!panelElement) {
      setSummaryOpen(false);
      return;
    }
    setSummaryLayout(calculateSummaryPanelLayout(panelElement));
  }, [summaryPanelRef]);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(title);
    }
  }, [editing, title]);

  useEffect(() => () => {
    if (summaryTimerRef.current !== undefined) {
      window.clearTimeout(summaryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!summaryOpen) {
      return undefined;
    }
    updateSummaryLayout();
    const panelElement = summaryPanelRef.current;
    window.addEventListener('resize', updateSummaryLayout);
    panelElement?.addEventListener('scroll', updateSummaryLayout, { passive: true });
    return () => {
      window.removeEventListener('resize', updateSummaryLayout);
      panelElement?.removeEventListener('scroll', updateSummaryLayout);
    };
  }, [summaryOpen, summaryPanelRef, updateSummaryLayout]);

  function scheduleSummaryOpen(): void {
    if (!isBound) {
      return;
    }
    if (summaryTimerRef.current !== undefined) {
      window.clearTimeout(summaryTimerRef.current);
    }
    summaryTimerRef.current = window.setTimeout(() => {
      updateSummaryLayout();
      setSummaryOpen(true);
    }, 1000);
  }

  function closeSummary(): void {
    if (summaryTimerRef.current !== undefined) {
      window.clearTimeout(summaryTimerRef.current);
      summaryTimerRef.current = undefined;
    }
    setSummaryOpen(false);
    setSummaryLayout(undefined);
  }

  async function submitRename(): Promise<void> {
    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === title) {
      setDraftTitle(title);
      setEditing(false);
      return;
    }
    const saved = await onRenameConversation(project.slug, provider, conversationRef, nextTitle);
    if (saved) {
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div className={clsx(
        'rounded-xl border px-3 py-2',
        active ? 'border-sky-400/40 bg-sky-500/10' : 'border-slate-800 bg-slate-950/70',
      )}>
        <input
          type="text"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={async (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              await submitRename();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraftTitle(title);
              setEditing(false);
            }
          }}
          autoFocus
          disabled={renaming}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDraftTitle(title);
              setEditing(false);
            }}
            className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
            aria-label="Cancel rename"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void submitRename()}
            disabled={renaming || !draftTitle.trim()}
            className="rounded-lg border border-sky-400/40 bg-sky-500/10 p-2 text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Save conversation title"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="group relative flex items-center gap-1"
      onMouseEnter={scheduleSummaryOpen}
      onMouseLeave={closeSummary}
      onFocus={scheduleSummaryOpen}
      onBlur={closeSummary}
    >
      <Link
        to={href}
        onClick={onClose}
        className={clsx(
          'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm transition',
          active ? 'bg-sky-500/15 text-sky-100' : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
        )}
      >
        <span className={clsx('h-2.5 w-2.5 rounded-full', indicatorClassName)} />
        {prefixLabel ? (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{prefixLabel}</span>
        ) : null}
        <span className="line-clamp-1 min-w-0">{title}</span>
      </Link>
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((current) => !current)}
          className="rounded-lg border border-transparent p-2 text-slate-500 opacity-0 transition hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={`Conversation actions for ${title}`}
        >
          <Menu className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 min-w-[9rem] rounded-xl border border-slate-800 bg-slate-950/95 p-1 shadow-panel">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5 text-slate-400" />
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void onRebindConversation(project.slug, provider, conversationRef);
              }}
              disabled={!canRebind || rebinding}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5 text-slate-400" />
              {rebinding ? 'Rebinding…' : 'Rebind'}
            </button>
          </div>
        )}
      </div>
      {summaryOpen && isBound && summaryLayout ? createPortal(
        <div
          role="tooltip"
          style={{
            top: summaryLayout.top,
            left: summaryLayout.left,
            width: summaryLayout.width,
            height: summaryLayout.height,
          }}
          className="pointer-events-none fixed z-50 flex flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 p-4 text-sm text-slate-300 shadow-panel"
        >
          <p className="shrink-0 font-medium leading-5 text-slate-100">Last interaction: {formatRelativeAge(summaryTimestamp, nowMs)}</p>
          <p className={clsx(
            'mt-3 min-h-0 shrink overflow-y-auto break-words leading-6',
            !summaryReady && 'text-slate-400',
          )}>
            {mainSummaryText}
          </p>
          <div className="mt-3 shrink-0 border-t border-slate-800 pt-2">
            <p className="text-[11px] font-semibold uppercase text-slate-500">{lastHourSummaryLabel}</p>
            <p className="mt-1 break-words leading-6 text-slate-400">{lastHourSummaryText}</p>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function fallbackProjectDisplayName(project: Pick<ProjectSummary, 'path' | 'directoryName'>): string {
  const normalized = project.path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? project.directoryName;
}

function ProjectSection({
  project,
  workMode,
  creatingConversationKey,
  creatingAnyConversation,
  onNewConversation,
  onRenameProject,
  renamingProject,
  onClose,
  manualOrderingEnabled,
  isDragTarget,
  onDragStartProject,
  onDragOverProject,
  onDropProject,
  onEndProjectDrag,
  onRebindConversation,
  onRenameConversation,
  rebindingConversationKey,
  renamingConversationKey,
  tailscaleIpv4,
  sessionFreshnessThresholds,
  summaryPanelRef,
}: {
  project: SidebarProject;
  workMode: boolean;
  creatingConversationKey?: string;
  creatingAnyConversation: boolean;
  onNewConversation: (projectSlug: string, provider: ProviderId) => void;
  onRenameProject: (project: ProjectSummary, displayName?: string) => Promise<boolean>;
  renamingProject: boolean;
  onClose: () => void;
  manualOrderingEnabled: boolean;
  isDragTarget: boolean;
  onDragStartProject: (projectSlug: string) => void;
  onDragOverProject: (event: DragEvent<HTMLElement>, projectSlug: string) => void;
  onDropProject: (projectSlug: string) => void;
  onEndProjectDrag: () => void;
  onRebindConversation: (projectSlug: string, provider: ProviderId, conversationRef: string) => Promise<boolean>;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  rebindingConversationKey?: string;
  renamingConversationKey?: string;
  tailscaleIpv4?: string;
  sessionFreshnessThresholds: SessionFreshnessThresholds;
  summaryPanelRef: RefObject<HTMLDivElement | null>;
}) {
  const location = useLocation();
  const [editingProject, setEditingProject] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftName, setDraftName] = useState(project.displayName);
  const [showAllConversations, setShowAllConversations] = useState(false);

  useEffect(() => {
    if (workMode) {
      setShowAllConversations(false);
    }
  }, [workMode]);

  useEffect(() => {
    if (!editingProject) {
      setDraftName(project.displayName);
    }
  }, [editingProject, project.displayName]);

  async function submitProjectRename(): Promise<void> {
    const nextName = draftName.trim();
    const currentName = project.displayName.trim();
    if (nextName === currentName) {
      setEditingProject(false);
      return;
    }
    const saved = await onRenameProject(project, nextName || undefined);
    if (saved) {
      setEditingProject(false);
    }
  }

  async function handleCopyPortUrl(port: number): Promise<void> {
    const url = `${globalThis.location.origin}/proxy/${encodeURIComponent(project.slug)}/${port}/`;
    await copyTextToClipboard(url);
    setMenuOpen(false);
  }

  async function handleCopyTailscalePortUrl(port: number): Promise<void> {
    if (!tailscaleIpv4) {
      return;
    }
    const url = `http://${tailscaleIpv4}:${port}/`;
    await copyTextToClipboard(url);
    setMenuOpen(false);
  }

  const collapsedConversations = (['codex', 'claude'] as const)
    .flatMap((provider) => project.combinedConversations
      .filter((conversation) => conversation.provider === provider)
      .slice(0, 2));

  const displayedConversations = workMode || showAllConversations
    ? project.combinedConversations
    : collapsedConversations;

  const hasHiddenConversations = !workMode && project.combinedConversations.length > collapsedConversations.length;

  return (
    <section
      className={clsx('mb-4 rounded-2xl transition', isDragTarget && 'bg-slate-900/40 ring-1 ring-sky-400/40')}
      draggable={manualOrderingEnabled && !editingProject}
      onDragStart={() => onDragStartProject(project.slug)}
      onDragOver={(event) => onDragOverProject(event, project.slug)}
      onDrop={() => onDropProject(project.slug)}
      onDragEnd={onEndProjectDrag}
    >
      <div className="flex items-start justify-between gap-3">
        {editingProject ? (
          <div className="flex min-w-0 flex-1 items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-2 py-2">
            <FolderTree className="mt-2 h-4 w-4 shrink-0 text-sky-300" />
            <div className="min-w-0 flex-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={async (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    await submitProjectRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setDraftName(project.displayName);
                    setEditingProject(false);
                  }
                }}
                autoFocus
                disabled={renamingProject}
                placeholder={fallbackProjectDisplayName(project)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(project.displayName);
                    setEditingProject(false);
                  }}
                  className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
                  aria-label="Cancel project rename"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void submitProjectRename()}
                  disabled={renamingProject}
                  className="rounded-lg border border-sky-400/40 bg-sky-500/10 p-2 text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Save project name"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <Link
            to={`/projects/${encodeURIComponent(project.slug)}`}
            onClick={onClose}
            className={clsx(
              'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 transition',
              location.pathname === `/projects/${encodeURIComponent(project.slug)}`
                ? 'bg-sky-500/10 text-sky-100'
                : 'text-slate-100 hover:bg-slate-800/60',
            )}
          >
            {manualOrderingEnabled && (
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-500" />
            )}
            <FolderTree className="h-4 w-4 shrink-0 text-sky-300" />
            <div className="min-w-0 flex-1 truncate font-medium">{project.displayName}</div>
          </Link>
        )}
        {!editingProject ? (
          <div className="flex shrink-0 items-center gap-2">
            {project.tags.length > 0 && (
              <div className="hidden max-w-[8rem] flex-wrap justify-end gap-1.5 xl:flex">
                {project.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{tag}</span>
                ))}
              </div>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((current) => !current)}
                disabled={renamingProject}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={`Project actions for ${project.displayName}`}
              >
                <Menu className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 min-w-[14rem] rounded-xl border border-slate-800 bg-slate-950/95 p-1 shadow-panel">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setEditingProject(true);
                    }}
                    disabled={renamingProject || creatingAnyConversation}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5 text-slate-400" />
                    Rename project
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onClose();
                      onNewConversation(project.slug, 'codex');
                    }}
                    disabled={creatingAnyConversation}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-sky-300" />
                    {creatingConversationKey === `${project.slug}:codex` ? 'Starting Codex…' : 'New Codex conversation'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onClose();
                      onNewConversation(project.slug, 'claude');
                    }}
                    disabled={creatingAnyConversation}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Bot className="h-3.5 w-3.5 text-sky-300" />
                    {creatingConversationKey === `${project.slug}:claude` ? 'Starting Claude…' : 'New Claude conversation'}
                  </button>
                  {project.allowedLocalhostPorts.length > 0 && (
                    <div className="mt-1 border-t border-slate-800 pt-1">
                      {project.allowedLocalhostPorts.map((port) => (
                        <div key={port}>
                          {tailscaleIpv4 && (
                            <button
                              type="button"
                              onClick={() => {
                                void handleCopyTailscalePortUrl(port);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
                            >
                              <LinkIcon className="h-3.5 w-3.5 text-slate-400" />
                              {`Copy Tailscale URL :${port}`}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              void handleCopyPortUrl(port);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
                          >
                            <LinkIcon className="h-3.5 w-3.5 text-slate-400" />
                            {`Copy proxied URL :${port}`}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div className="ml-7 mt-2 border-l border-slate-800 pl-3">
        {project.combinedConversations.length > 0 ? (
          <div className="space-y-1">
            {displayedConversations.map(({ provider, conversation, freshnessTimestamp }) => (
              <ConversationLink
                key={`${provider}:${conversation.ref}`}
                project={project}
                provider={provider}
                conversationRef={conversation.ref}
                title={conversation.title}
                prefixLabel={`${provider.toUpperCase()}:`}
                isBound={conversation.isBound}
                canRebind={conversation.kind === 'history'}
                onClose={onClose}
                onRebindConversation={onRebindConversation}
                onRenameConversation={onRenameConversation}
                rebinding={rebindingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
                renaming={renamingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
                sessionSummary={conversation.sessionSummary}
                lastInteractionAt={freshnessTimestamp}
                sessionFreshnessThresholds={sessionFreshnessThresholds}
                summaryPanelRef={summaryPanelRef}
              />
            ))}
            {hasHiddenConversations ? (
              <button
                type="button"
                onClick={() => setShowAllConversations((current) => !current)}
                className="ml-3 mt-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
              >
                {showAllConversations
                  ? 'Show less'
                  : `Show all (${project.combinedConversations.length})`}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="px-3 py-2 text-sm text-slate-500">No conversations indexed yet.</div>
        )}
      </div>
    </section>
  );
}

export function Sidebar({
  tree,
  open,
  onClose,
  workMode,
  onToggleWorkMode,
  recentActivitySortEnabled,
  manualProjectOrder,
  sessionFreshnessThresholds,
  onToggleRecentActivity,
  onReorderProjects,
  onNewConversation,
  onRenameProject,
  onRebindConversation,
  onRenameConversation,
  creatingConversationKey,
  renamingProjectKey,
  rebindingConversationKey,
  renamingConversationKey,
  updatingUiPreferences,
  onRefresh,
  refreshing,
}: SidebarProps) {
  const creatingAnyConversation = Boolean(creatingConversationKey);
  const [draggingProjectSlug, setDraggingProjectSlug] = useState<string>();
  const [dragOverProjectSlug, setDragOverProjectSlug] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('');
  const [searchSubmissionVersion, setSearchSubmissionVersion] = useState(0);
  const summaryPanelRef = useRef<HTMLDivElement | null>(null);
  const trimmedSearchQuery = searchQuery.trim();
  const trimmedSubmittedSearchQuery = submittedSearchQuery.trim();
  const showingSubmittedSearchResults = Boolean(
    trimmedSubmittedSearchQuery
    && trimmedSearchQuery === trimmedSubmittedSearchQuery,
  );

  const networkInfoQuery = useQuery({
    queryKey: ['network-info'],
    queryFn: api.networkInfo,
    staleTime: 60_000,
  });
  const tailscaleIpv4 = networkInfoQuery.data?.tailscaleIpv4;

  const searchQueryResult = useQuery({
    queryKey: ['conversation-search', trimmedSubmittedSearchQuery, searchSubmissionVersion],
    queryFn: ({ signal }) => api.searchConversations(trimmedSubmittedSearchQuery, { limit: 24, signal }),
    enabled: Boolean(trimmedSubmittedSearchQuery),
  });
  const searchResults = showingSubmittedSearchResults ? searchQueryResult.data?.results ?? [] : [];
  const searchLoading = showingSubmittedSearchResults && searchQueryResult.isFetching;
  const searchError = showingSubmittedSearchResults && searchQueryResult.error instanceof Error
    ? searchQueryResult.error.message
    : undefined;

  function submitSearch(): void {
    setSubmittedSearchQuery(trimmedSearchQuery);
    setSearchSubmissionVersion((current) => current + 1);
  }

  function updateSearchQuery(value: string): void {
    setSearchQuery(value);
  }

  const visibleProjects = useMemo(() => deriveSidebarProjects({
    tree,
    workMode,
    recentActivitySortEnabled,
    manualProjectOrder,
  }), [manualProjectOrder, recentActivitySortEnabled, tree, workMode]);

  function handleProjectDrop(targetSlug: string): void {
    if (!draggingProjectSlug || draggingProjectSlug === targetSlug) {
      setDraggingProjectSlug(undefined);
      setDragOverProjectSlug(undefined);
      return;
    }
    void onReorderProjects(draggingProjectSlug, targetSlug);
    setDraggingProjectSlug(undefined);
    setDragOverProjectSlug(undefined);
  }
  return (
    <>
      <div className={clsx('fixed inset-0 z-20 bg-slate-950/70 lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} />
      <aside className={clsx(
        'fixed inset-y-0 left-0 z-30 max-w-[88vw] overflow-hidden backdrop-blur transition-[transform,width,border-color] lg:relative lg:inset-y-auto lg:left-auto lg:z-0 lg:max-w-none',
        open
          ? 'w-[22rem] translate-x-0 border-r border-slate-800'
          : 'w-[22rem] -translate-x-full border-r border-slate-800 lg:w-0 lg:translate-x-0 lg:border-r-0',
      )}>
        <div className="flex h-full w-[22rem] max-w-[88vw] flex-col bg-slate-950/95">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-4">
            <div>
              <div className="text-lg font-semibold">Agent Console</div>
              <div className="text-xs text-slate-400">project → provider → conversation</div>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-xl border border-slate-700 p-2 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              aria-label="Refresh project tree"
            >
              <RefreshCcw className={clsx('h-4 w-4', refreshing && 'animate-spin')} />
            </button>
          </div>
          <div className="flex flex-wrap gap-2 border-b border-slate-800 px-4 py-3">
            <button
              type="button"
              onClick={onToggleWorkMode}
              className={clsx(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                workMode
                  ? enabledToggleClassName
                  : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
              )}
            >
              Work mode
            </button>
            <button
              type="button"
              onClick={() => void onToggleRecentActivity()}
              disabled={updatingUiPreferences}
              className={clsx(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
                recentActivitySortEnabled
                  ? enabledToggleClassName
                  : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
              )}
            >
              Recent activity
            </button>
            <div className="relative min-w-[13rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => updateSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitSearch();
                  }
                }}
                placeholder="Search all chats"
                className="h-9 w-full rounded-full border border-slate-700 bg-slate-900/70 pl-9 pr-9 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    updateSearchQuery('');
                    setSubmittedSearchQuery('');
                    setSearchSubmissionVersion((current) => current + 1);
                  }}
                  className="absolute right-2 top-1/2 rounded-full p-1 text-slate-500 transition -translate-y-1/2 hover:bg-slate-800 hover:text-slate-200"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <div ref={summaryPanelRef} className="scrollbar-thin flex-1 overflow-y-auto p-3">
            {showingSubmittedSearchResults ? (
              <SearchResultsPanel
                query={trimmedSubmittedSearchQuery}
                results={searchResults}
                loading={searchLoading}
                error={searchError}
                onClose={onClose}
              />
            ) : visibleProjects.length ? visibleProjects.map((project) => (
              <ProjectSection
                key={project.slug}
                project={project}
                workMode={workMode}
                creatingConversationKey={creatingConversationKey}
                creatingAnyConversation={creatingAnyConversation}
                onNewConversation={onNewConversation}
                onRenameProject={onRenameProject}
                renamingProject={renamingProjectKey === project.slug}
                onClose={onClose}
                manualOrderingEnabled={!recentActivitySortEnabled}
                isDragTarget={dragOverProjectSlug === project.slug}
                onDragStartProject={setDraggingProjectSlug}
                onDragOverProject={(event, projectSlug) => {
                  if (recentActivitySortEnabled || draggingProjectSlug === projectSlug) {
                    return;
                  }
                  event.preventDefault();
                  setDragOverProjectSlug(projectSlug);
                }}
                onDropProject={handleProjectDrop}
                onEndProjectDrag={() => {
                  setDraggingProjectSlug(undefined);
                  setDragOverProjectSlug(undefined);
                }}
                onRebindConversation={onRebindConversation}
                onRenameConversation={onRenameConversation}
                rebindingConversationKey={rebindingConversationKey}
                renamingConversationKey={renamingConversationKey}
                tailscaleIpv4={tailscaleIpv4}
                sessionFreshnessThresholds={sessionFreshnessThresholds}
                summaryPanelRef={summaryPanelRef}
              />
            )) : (
              <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-sm text-slate-400">
                {workMode ? 'No bound sessions are active right now.' : 'No active projects are visible yet. Check your config JSON and refresh.'}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
