import { Bot, Check, FolderTree, Pencil, Plus, RefreshCcw, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useState } from 'react';

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
  onNewConversation: (projectSlug: string, provider: ProviderId) => void;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  creatingConversationKey?: string;
  renamingConversationKey?: string;
  onRefresh: () => void;
  refreshing: boolean;
}

function ConversationLink({
  project,
  provider,
  conversationRef,
  title,
  prefixLabel,
  isBound,
  onClose,
  onRenameConversation,
  renaming,
}: {
  project: ProjectSummary;
  provider: ProviderId;
  conversationRef: string;
  title: string;
  prefixLabel?: string;
  isBound: boolean;
  onClose: () => void;
  onRenameConversation: (projectSlug: string, provider: ProviderId, conversationRef: string, title: string) => Promise<boolean>;
  renaming: boolean;
}) {
  const location = useLocation();
  const [editing, setEditing] = useState(false);
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
        <span className={clsx('h-2.5 w-2.5 rounded-full', isBound ? 'bg-emerald-400' : 'bg-transparent border border-slate-700')} />
        {prefixLabel ? (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{prefixLabel}</span>
        ) : null}
        <span className="line-clamp-1 min-w-0">{title}</span>
      </Link>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-lg border border-transparent p-2 text-slate-500 opacity-0 transition hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200 group-hover:opacity-100 group-focus-within:opacity-100"
        aria-label={`Rename ${title}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Sidebar({
  tree,
  open,
  onClose,
  workMode,
  onToggleWorkMode,
  onNewConversation,
  onRenameConversation,
  creatingConversationKey,
  renamingConversationKey,
  onRefresh,
  refreshing,
}: SidebarProps) {
  const location = useLocation();
  const creatingAnyConversation = Boolean(creatingConversationKey);
  const [sortByRecency, setSortByRecency] = useLocalStorageBoolean('agent-console:sidebar-recency-sort', false);
  const [providerPickerProjectSlug, setProviderPickerProjectSlug] = useState<string>();
  const autoSortByRecency = workMode || sortByRecency;

  const boundSessionMap = new Map((tree?.boundSessions ?? []).map((session) => [`${session.projectSlug}:${session.provider}:${session.conversationRef}`, session]));
  const visibleProjects = (tree?.projects ?? [])
    .map((project) => {
      const providerEntries = (['codex', 'claude'] as const).map((provider) => {
        const conversations = project.providers[provider].conversations
          .filter((conversation) => !workMode || conversation.isBound)
          .sort((a, b) => {
            if (!autoSortByRecency) {
              return b.updatedAt.localeCompare(a.updatedAt);
            }
            const aSession = boundSessionMap.get(`${project.slug}:${provider}:${a.ref}`);
            const bSession = boundSessionMap.get(`${project.slug}:${provider}:${b.ref}`);
            const aTimestamp = aSession?.lastActivityAt ?? aSession?.updatedAt ?? a.updatedAt;
            const bTimestamp = bSession?.lastActivityAt ?? bSession?.updatedAt ?? b.updatedAt;
            return bTimestamp.localeCompare(aTimestamp);
          });
        return [provider, { ...project.providers[provider], conversations }] as const;
      });
      const combinedConversations = (['codex', 'claude'] as const)
        .flatMap((provider) => project.providers[provider].conversations.map((conversation) => ({ provider, conversation })))
        .filter(({ conversation }) => !workMode || conversation.isBound)
        .sort((a, b) => {
          const aSession = boundSessionMap.get(`${project.slug}:${a.provider}:${a.conversation.ref}`);
          const bSession = boundSessionMap.get(`${project.slug}:${b.provider}:${b.conversation.ref}`);
          const aTimestamp = autoSortByRecency
            ? (aSession?.lastActivityAt ?? aSession?.updatedAt ?? a.conversation.updatedAt)
            : a.conversation.updatedAt;
          const bTimestamp = autoSortByRecency
            ? (bSession?.lastActivityAt ?? bSession?.updatedAt ?? b.conversation.updatedAt)
            : b.conversation.updatedAt;
          return bTimestamp.localeCompare(aTimestamp);
        });
      return {
        ...project,
        providers: Object.fromEntries(providerEntries) as ProjectSummary['providers'],
        combinedConversations,
      };
    })
    .filter((project) => !workMode || project.combinedConversations.length > 0);
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
            {!workMode && (
              <button
                type="button"
                onClick={() => setSortByRecency((current) => !current)}
                className={clsx(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                  sortByRecency
                    ? 'border-sky-400/40 bg-sky-500/10 text-sky-100'
                    : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
                )}
              >
                Auto sort by recency
              </button>
            )}
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
            {visibleProjects.length ? visibleProjects.map((project) => (
              <section key={project.slug} className="mb-4">
                <div className="flex items-start justify-between gap-3">
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
                    <FolderTree className="h-4 w-4 shrink-0 text-sky-300" />
                    <div className="min-w-0 flex-1 truncate font-medium">{project.displayName}</div>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {project.tags.length > 0 && (
                      <div className="hidden max-w-[8rem] flex-wrap justify-end gap-1.5 xl:flex">
                        {project.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{tag}</span>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setProviderPickerProjectSlug((current) => current === project.slug ? undefined : project.slug)}
                      disabled={creatingAnyConversation}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      aria-label={`New conversation in ${project.displayName}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {creatingConversationKey?.startsWith(`${project.slug}:`) ? 'Starting…' : 'New'}
                    </button>
                  </div>
                </div>
                {providerPickerProjectSlug === project.slug && (
                  <div className="ml-7 mt-2 flex flex-wrap gap-2">
                    {(['codex', 'claude'] as const).map((provider) => {
                      const meta = providerMeta(provider);
                      const Icon = meta.icon;
                      return (
                        <button
                          key={provider}
                          type="button"
                          onClick={() => {
                            setProviderPickerProjectSlug(undefined);
                            onNewConversation(project.slug, provider);
                          }}
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
                      {project.combinedConversations.map(({ provider, conversation }) => (
                        <ConversationLink
                          key={`${provider}:${conversation.ref}`}
                          project={project}
                          provider={provider}
                          conversationRef={conversation.ref}
                          title={conversation.title}
                          prefixLabel={`${provider.toUpperCase()}:`}
                          isBound={conversation.isBound}
                          onClose={onClose}
                          onRenameConversation={onRenameConversation}
                          renaming={renamingConversationKey === `${project.slug}:${provider}:${conversation.ref}`}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm text-slate-500">No conversations indexed yet.</div>
                  )}
                </div>
              </section>
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
