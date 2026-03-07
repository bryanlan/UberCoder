import { Bot, FolderTree, Plus, RefreshCcw, Sparkles } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import clsx from 'clsx';

function providerMeta(provider: ProviderId) {
  return provider === 'codex'
    ? { label: 'Codex', icon: Sparkles }
    : { label: 'Claude', icon: Bot };
}

interface SidebarProps {
  tree?: TreeResponse;
  open: boolean;
  onClose: () => void;
  onNewConversation: (projectSlug: string, provider: ProviderId) => void;
  creatingConversationKey?: string;
  onRefresh: () => void;
  refreshing: boolean;
}

function ConversationLink({ project, provider, conversationRef, title, isBound, onClose }: { project: ProjectSummary; provider: ProviderId; conversationRef: string; title: string; isBound: boolean; onClose: () => void; }) {
  const location = useLocation();
  const href = `/projects/${encodeURIComponent(project.slug)}/${provider}/${encodeURIComponent(conversationRef)}`;
  const active = location.pathname === href;
  return (
    <Link
      to={href}
      onClick={onClose}
      className={clsx(
        'flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition',
        active ? 'bg-sky-500/15 text-sky-100' : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
      )}
    >
      <span className={clsx('h-2.5 w-2.5 rounded-full', isBound ? 'bg-emerald-400' : 'bg-transparent border border-slate-700')} />
      <span className="line-clamp-1">{title}</span>
    </Link>
  );
}

export function Sidebar({ tree, open, onClose, onNewConversation, creatingConversationKey, onRefresh, refreshing }: SidebarProps) {
  const creatingAnyConversation = Boolean(creatingConversationKey);
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
          <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
            {tree?.projects.length ? tree.projects.map((project) => (
              <section key={project.slug} className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 shadow-panel">
                <div className="mb-3 flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl border border-slate-700 bg-slate-900 p-2 text-sky-300">
                    <FolderTree className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{project.displayName}</div>
                    <div className="truncate text-xs text-slate-400">{project.path}</div>
                    {project.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {project.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {(['codex', 'claude'] as const).map((provider) => {
                    const meta = providerMeta(provider);
                    const Icon = meta.icon;
                    const conversations = project.providers[provider].conversations;
                    const creationKey = `${project.slug}:${provider}`;
                    const creating = creatingConversationKey === creationKey;
                    return (
                      <div key={provider} className="rounded-xl border border-slate-800 bg-slate-900/90 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2 px-1">
                          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                            <Icon className="h-4 w-4 text-sky-300" />
                            {meta.label}
                          </div>
                          <button
                            type="button"
                            onClick={() => onNewConversation(project.slug, provider)}
                            disabled={creatingAnyConversation}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {creating ? 'Starting…' : 'New'}
                          </button>
                        </div>
                        <div className="space-y-1">
                          {conversations.length > 0 ? conversations.map((conversation) => (
                            <ConversationLink
                              key={conversation.ref}
                              project={project}
                              provider={provider}
                              conversationRef={conversation.ref}
                              title={conversation.title}
                              isBound={conversation.isBound}
                              onClose={onClose}
                            />
                          )) : (
                            <div className="rounded-xl px-3 py-2 text-sm text-slate-500">No conversations indexed yet.</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )) : (
              <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-sm text-slate-400">
                No active projects are visible yet. Check your config JSON and refresh.
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
