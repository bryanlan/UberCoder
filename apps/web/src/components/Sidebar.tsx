import { Bot, Check, FolderTree, GripVertical, Menu, Pencil, Plus, RefreshCcw, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ProjectSummary, ProviderId, SessionFreshnessThresholds, TreeResponse } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useState, type DragEvent } from 'react';

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
  if (ageMinutes >= thresholds.orangeMinutes) {
    return 'bg-orange-400';
  }
  if (ageMinutes >= thresholds.yellowMinutes) {
    return 'bg-amber-400';
  }
  return 'bg-emerald-400';
}

function ConversationLink({
  project,
  provider,
  conversationRef,
  title,
  prefixLabel,
  isBound,
  indicatorClassName,
  canRebind,
  onClose,
  onRebindConversation,
  onRenameConversation,
  rebinding,
  renaming,
}: {
  project: ProjectSummary;
  provider: ProviderId;
  conversationRef: string;
  title: string;
  prefixLabel?: string;
  isBound: boolean;
  indicatorClassName: string;
  canRebind: boolean;
  onClose: () => void;
  onRebindConversation: (projectSlug: string, provider: ProviderId, conversationRef: string) => Promise<boolean>;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  rebinding: boolean;
  renaming: boolean;
}) {
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const href = `/projects/${encodeURIComponent(project.slug)}/${provider}/${encodeURIComponent(conversationRef)}`;
  const active = location.pathname === href;

  useEffect(() => {
    if (!editing) {
      setDraftTitle(title);
    }
  }, [editing, title]);

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
    <div className="group flex items-center gap-1">
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
  providerPickerOpen,
  onToggleProviderPicker,
  onSelectProvider,
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
}: {
  project: ProjectSummary & {
    combinedConversations: Array<{
      provider: ProviderId;
      conversation: ProjectSummary['providers'][ProviderId]['conversations'][number];
      freshnessTimestamp: string;
      indicatorClassName: string;
    }>;
  };
  workMode: boolean;
  creatingConversationKey?: string;
  creatingAnyConversation: boolean;
  providerPickerOpen: boolean;
  onToggleProviderPicker: () => void;
  onSelectProvider: (provider: ProviderId) => void;
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
}) {
  const location = useLocation();
  const [editingProject, setEditingProject] = useState(false);
  const [draftName, setDraftName] = useState(project.displayName);

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
            {workMode && (
              <button
                type="button"
                onClick={() => setEditingProject(true)}
                disabled={renamingProject || creatingAnyConversation}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={`Rename ${project.displayName}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleProviderPicker}
              disabled={creatingAnyConversation}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`New conversation in ${project.displayName}`}
            >
              <Plus className="h-3.5 w-3.5" />
              {creatingConversationKey?.startsWith(`${project.slug}:`) ? 'Starting…' : 'New'}
            </button>
          </div>
        ) : null}
      </div>
      {providerPickerOpen && (
        <div className="ml-7 mt-2 flex flex-wrap gap-2">
          {(['codex', 'claude'] as const).map((provider) => {
            const meta = providerMeta(provider);
            const Icon = meta.icon;
            return (
              <button
                key={provider}
                type="button"
                onClick={() => onSelectProvider(provider)}
                disabled={creatingAnyConversation}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon className="h-3.5 w-3.5 text-sky-300" />
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="ml-7 mt-2 border-l border-slate-800 pl-3">
        {project.combinedConversations.length > 0 ? (
          <div className="space-y-1">
            {project.combinedConversations.map(({ provider, conversation, indicatorClassName }) => (
              <ConversationLink
                key={`${provider}:${conversation.ref}`}
                project={project}
                provider={provider}
                conversationRef={conversation.ref}
                title={conversation.title}
                prefixLabel={`${provider.toUpperCase()}:`}
                isBound={conversation.isBound}
                indicatorClassName={indicatorClassName}
                canRebind={conversation.kind === 'history'}
                onClose={onClose}
                onRebindConversation={onRebindConversation}
                onRenameConversation={onRenameConversation}
                rebinding={rebindingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
                renaming={renamingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
              />
            ))}
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
  const [providerPickerProjectSlug, setProviderPickerProjectSlug] = useState<string>();
  const [draggingProjectSlug, setDraggingProjectSlug] = useState<string>();
  const [dragOverProjectSlug, setDragOverProjectSlug] = useState<string>();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const boundSessionMap = new Map((tree?.boundSessions ?? []).map((session) => [`${session.projectSlug}:${session.provider}:${session.conversationRef}`, session]));
  const manualOrderIndex = new Map(manualProjectOrder.map((slug, index) => [slug, index]));
  const visibleProjects = (tree?.projects ?? [])
    .map((project) => {
      const providerEntries = (['codex', 'claude'] as const).map((provider) => {
        const conversations = project.providers[provider].conversations
          .filter((conversation) => !workMode || conversation.isBound)
          .sort((a, b) => {
            const aSession = boundSessionMap.get(`${project.slug}:${provider}:${a.ref}`);
            const bSession = boundSessionMap.get(`${project.slug}:${provider}:${b.ref}`);
            const aTimestamp = aSession?.lastOutputAt ?? aSession?.lastActivityAt ?? aSession?.startedAt ?? aSession?.updatedAt ?? a.updatedAt;
            const bTimestamp = bSession?.lastOutputAt ?? bSession?.lastActivityAt ?? bSession?.startedAt ?? bSession?.updatedAt ?? b.updatedAt;
            return bTimestamp.localeCompare(aTimestamp);
          });
        return [provider, { ...project.providers[provider], conversations }] as const;
      });
      const combinedConversations = (['codex', 'claude'] as const)
        .flatMap((provider) => project.providers[provider].conversations.map((conversation) => {
          const session = boundSessionMap.get(`${project.slug}:${provider}:${conversation.ref}`);
          const freshnessTimestamp = session?.lastOutputAt ?? session?.lastActivityAt ?? session?.startedAt ?? session?.updatedAt ?? conversation.updatedAt;
          return {
            provider,
            conversation,
            freshnessTimestamp,
            indicatorClassName: getConversationFreshnessClass(
              conversation.isBound,
              freshnessTimestamp,
              sessionFreshnessThresholds,
              nowMs,
            ),
          };
        }))
        .filter(({ conversation }) => !workMode || conversation.isBound)
        .sort((a, b) => b.freshnessTimestamp.localeCompare(a.freshnessTimestamp));
      return {
        ...project,
        providers: Object.fromEntries(providerEntries) as ProjectSummary['providers'],
        combinedConversations,
        latestActivityAt: combinedConversations[0]
          ? combinedConversations[0].freshnessTimestamp
          : '',
      };
    })
    .filter((project) => !workMode || project.combinedConversations.length > 0)
    .sort((a, b) => {
      if (recentActivitySortEnabled) {
        return (b.latestActivityAt || '').localeCompare(a.latestActivityAt || '');
      }
      const aIndex = manualOrderIndex.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = manualOrderIndex.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.displayName.localeCompare(b.displayName);
    });

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
                  ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
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
                  ? 'border-sky-400/40 bg-sky-500/10 text-sky-100'
                  : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
              )}
            >
              Recent activity
            </button>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
            {visibleProjects.length ? visibleProjects.map((project) => (
              <ProjectSection
                key={project.slug}
                project={project}
                workMode={workMode}
                creatingConversationKey={creatingConversationKey}
                creatingAnyConversation={creatingAnyConversation}
                providerPickerOpen={providerPickerProjectSlug === project.slug}
                onToggleProviderPicker={() => setProviderPickerProjectSlug((current) => current === project.slug ? undefined : project.slug)}
                onSelectProvider={(provider) => {
                  setProviderPickerProjectSlug(undefined);
                  onNewConversation(project.slug, provider);
                }}
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
