import { Bot, ChevronRight, FolderTree, Sparkles } from 'lucide-react';
import type { ProjectSummary, ProviderId } from '@agent-console/shared';
import clsx from 'clsx';
import { Link } from 'react-router-dom';

function ProviderPill({ provider }: { provider: ProviderId }) {
  return provider === 'codex' ? (
    <>
      <Sparkles className="h-4 w-4 text-sky-300" />
      Codex
    </>
  ) : (
    <>
      <Bot className="h-4 w-4 text-sky-300" />
      Claude
    </>
  );
}

export function NavigationCrumbs({
  project,
  selectedProvider,
  conversationTitle,
}: {
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
  conversationTitle?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
      <Link to="/" className="inline-flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100">
        <FolderTree className="h-4 w-4 text-sky-300" />
        Projects
      </Link>
      {project ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {project ? (
        <Link to={`/projects/${encodeURIComponent(project.slug)}`} className="rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100">
          {project.displayName}
        </Link>
      ) : null}
      {project && selectedProvider ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {project && selectedProvider ? (
        <Link
          to={`/projects/${encodeURIComponent(project.slug)}/${selectedProvider}`}
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100"
        >
          <ProviderPill provider={selectedProvider} />
        </Link>
      ) : null}
      {conversationTitle ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {conversationTitle ? <span className="rounded-lg px-2 py-1 text-slate-200">{conversationTitle}</span> : null}
    </div>
  );
}

export function ExplorerPane({
  projects,
  project,
  selectedProvider,
}: {
  projects?: ProjectSummary[];
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
}) {
  if (!project) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <NavigationCrumbs />
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">Projects</h1>
            <p className="mt-1 text-sm text-slate-400">Browse the active project folders under the configured projects root.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(projects ?? []).map((item) => (
              <Link
                key={item.slug}
                to={`/projects/${encodeURIComponent(item.slug)}`}
                className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3 text-sky-300">
                    <FolderTree className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-semibold text-slate-100">{item.displayName}</div>
                    <div className="mt-1 break-all text-sm text-slate-400">{item.path}</div>
                    <div className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-500">
                      {item.providers.codex.conversations.length + item.providers.claude.conversations.length} conversations
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <NavigationCrumbs project={project} />
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{project.displayName}</h1>
            <p className="mt-1 text-sm text-slate-400">Choose a provider to browse indexed conversations for this project.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {(['codex', 'claude'] as const).map((provider) => (
              <Link
                key={provider}
                to={`/projects/${encodeURIComponent(project.slug)}/${provider}`}
                className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3 text-sky-300">
                    {provider === 'codex' ? <Sparkles className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-2 text-lg font-semibold text-slate-100">
                      <ProviderPill provider={provider} />
                    </div>
                    <div className="mt-1 text-sm text-slate-400">
                      {project.providers[provider].conversations.length} indexed conversations
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const conversations = project.providers[selectedProvider].conversations;
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <NavigationCrumbs project={project} selectedProvider={selectedProvider} />
        <div>
          <h1 className="inline-flex items-center gap-2 text-2xl font-semibold text-slate-100">
            <ProviderPill provider={selectedProvider} />
          </h1>
          <p className="mt-1 text-sm text-slate-400">Choose an indexed conversation or start a new one from the sidebar.</p>
        </div>
        {conversations.length > 0 ? (
          <div className="space-y-3">
            {conversations.map((conversation) => (
              <Link
                key={conversation.ref}
                to={`/projects/${encodeURIComponent(project.slug)}/${selectedProvider}/${encodeURIComponent(conversation.ref)}`}
                className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <span className={clsx('h-2.5 w-2.5 rounded-full', conversation.isBound ? 'bg-emerald-400' : 'border border-slate-700 bg-transparent')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-100">{conversation.title}</div>
                  <div className="truncate text-xs text-slate-500">{new Date(conversation.updatedAt).toLocaleString()}</div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-700 p-6 text-sm text-slate-400">
            No indexed conversations yet for this provider.
          </div>
        )}
      </div>
    </div>
  );
}
