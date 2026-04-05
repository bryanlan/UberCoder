import { Bot, Check, FolderTree, GripVertical, Link as LinkIcon, Menu, Pencil, Plus, RefreshCcw, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ProjectSummary, ProviderId, SessionFreshnessThresholds, TreeResponse } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';

const enabledToggleClassName = 'border-emerald-500/45 bg-emerald-500/12 text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-500/16';

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
  manualProjectOrder: string[];
  sessionFreshnessThresholds: SessionFreshnessThresholds;
  onReorderProjects: (sourceSlug: string, targetSlug: string) => Promise<void>;
  onNewConversation: (projectSlug: string, provider: ProviderId) => void;
  onRenameProject: (project: ProjectSummary, displayName?: string) => Promise<boolean>;
  onRebindConversation: (projectSlug: string, provider: ProviderId, conversationRef: string) => Promise<boolean>;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  creatingConversationKey?: string;
  renamingProjectKey?: string;
  rebindingConversationKey?: string;
  renamingConversationKey?: string;
  onRefresh: () => void;
  refreshing: boolean;
}

type ConversationItem = ProjectSummary['providers'][ProviderId]['conversations'][number];
type BoundSessionItem = NonNullable<TreeResponse['boundSessions']>[number];

function getConversationRecencyTimestamp(
  conversation: ConversationItem,
  session?: BoundSessionItem,
): string {
  return session?.lastCompletedAt
    ?? session?.startedAt
    ?? conversation.updatedAt;
}

function getConversationIndicator(
  isBound: boolean,
  session?: BoundSessionItem,
): ReactNode {
  if (!isBound) {
    return <span className="h-2.5 w-2.5 rounded-full border border-slate-700 bg-transparent" />;
  }

  if (session?.attentionState === 'working') {
    return <X className="h-3 w-3 text-rose-400" strokeWidth={2.5} />;
  }

  if (session?.attentionState === 'waiting') {
    return <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />;
  }

  return <span className="h-2.5 w-2.5 rounded-full bg-slate-600" />;
}

function ConversationLink({
  project,
  provider,
  conversationRef,
  title,
  prefixLabel,
  isBound,
  indicator,
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
  indicator: ReactNode;
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
        <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">{indicator}</span>
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
}: {
  project: ProjectSummary & {
    combinedConversations: Array<{
      provider: ProviderId;
      conversation: ProjectSummary['providers'][ProviderId]['conversations'][number];
      freshnessTimestamp: string;
      indicator: ReactNode;
    }>;
  };
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
      .slice(0, 2))
    .sort((a, b) => b.freshnessTimestamp.localeCompare(a.freshnessTimestamp));

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
            {displayedConversations.map(({ provider, conversation, indicator }) => (
              <ConversationLink
                key={`${provider}:${conversation.ref}`}
                project={project}
                provider={provider}
                conversationRef={conversation.ref}
                title={conversation.title}
                prefixLabel={`${provider.toUpperCase()}:`}
                isBound={conversation.isBound}
                indicator={indicator}
                canRebind={conversation.kind === 'history'}
                onClose={onClose}
                onRebindConversation={onRebindConversation}
                onRenameConversation={onRenameConversation}
                rebinding={rebindingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
                renaming={renamingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
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
  manualProjectOrder,
  sessionFreshnessThresholds,
  onReorderProjects,
  onNewConversation,
  onRenameProject,
  onRebindConversation,
  onRenameConversation,
  creatingConversationKey,
  renamingProjectKey,
  rebindingConversationKey,
  renamingConversationKey,
  onRefresh,
  refreshing,
}: SidebarProps) {
  const creatingAnyConversation = Boolean(creatingConversationKey);
  const [draggingProjectSlug, setDraggingProjectSlug] = useState<string>();
  const [dragOverProjectSlug, setDragOverProjectSlug] = useState<string>();
  const [tailscaleIpv4, setTailscaleIpv4] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.networkInfo()
      .then((network) => {
        if (active) {
          setTailscaleIpv4(network.tailscaleIpv4);
        }
      })
      .catch(() => {
        if (active) {
          setTailscaleIpv4(undefined);
        }
      });
    return () => {
      active = false;
    };
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
            const aTimestamp = getConversationRecencyTimestamp(a, aSession);
            const bTimestamp = getConversationRecencyTimestamp(b, bSession);
            return bTimestamp.localeCompare(aTimestamp);
          });
        return [provider, { ...project.providers[provider], conversations }] as const;
      });
      const combinedConversations = (['codex', 'claude'] as const)
        .flatMap((provider) => project.providers[provider].conversations.map((conversation) => {
          const session = boundSessionMap.get(`${project.slug}:${provider}:${conversation.ref}`);
          const freshnessTimestamp = getConversationRecencyTimestamp(conversation, session);
          return {
            provider,
            conversation,
            freshnessTimestamp,
            indicator: getConversationIndicator(
              conversation.isBound,
              session,
            ),
          };
        }))
        .filter(({ conversation }) => !workMode || conversation.isBound)
        .sort((a, b) => b.freshnessTimestamp.localeCompare(a.freshnessTimestamp));
      return {
        ...project,
        providers: Object.fromEntries(providerEntries) as ProjectSummary['providers'],
        combinedConversations,
      };
    })
    .filter((project) => !workMode || project.combinedConversations.length > 0)
    .sort((a, b) => {
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
                  ? enabledToggleClassName
                  : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
              )}
            >
              Work mode
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
                onNewConversation={onNewConversation}
                onRenameProject={onRenameProject}
                renamingProject={renamingProjectKey === project.slug}
                onClose={onClose}
                manualOrderingEnabled
                isDragTarget={dragOverProjectSlug === project.slug}
                onDragStartProject={setDraggingProjectSlug}
                onDragOverProject={(event, projectSlug) => {
                  if (draggingProjectSlug === projectSlug) {
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
