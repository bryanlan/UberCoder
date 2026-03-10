import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  EditableProjectSettings,
  SettingsSummary,
  UpdateGlobalSettingsRequest,
  UpdateProjectSettingsRequest,
} from '@agent-console/shared';
import { ApiError, api } from '../lib/api';
import { DirectoryPickerModal } from '../components/DirectoryPickerModal';

interface GlobalDraft {
  projectsRoot: string;
  serverHost: string;
  serverPort: string;
  sessionTtlHours: string;
  cookieSecure: boolean;
  trustTailscaleHeaders: boolean;
}

interface ProjectDraft {
  active: boolean;
  displayName: string;
  allowedLocalhostPorts: string;
  tags: string;
  notes: string;
}

function toGlobalDraft(settings: SettingsSummary): GlobalDraft {
  return {
    projectsRoot: settings.projectsRoot,
    serverHost: settings.serverHost,
    serverPort: String(settings.serverPort),
    sessionTtlHours: String(settings.security.sessionTtlHours),
    cookieSecure: settings.security.cookieSecure,
    trustTailscaleHeaders: settings.security.trustTailscaleHeaders,
  };
}

function toProjectDraft(project: EditableProjectSettings): ProjectDraft {
  return {
    active: project.active,
    displayName: project.displayName ?? '',
    allowedLocalhostPorts: project.allowedLocalhostPorts.join(', '),
    tags: project.tags.join(', '),
    notes: project.notes ?? '',
  };
}

function normalizeGlobalDraft(draft: GlobalDraft): UpdateGlobalSettingsRequest {
  const serverPort = Number.parseInt(draft.serverPort, 10);
  const sessionTtlHours = Number.parseFloat(draft.sessionTtlHours);
  if (Number.isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error('Server port must be a whole number between 1 and 65535.');
  }
  if (Number.isNaN(sessionTtlHours) || sessionTtlHours <= 0 || sessionTtlHours > 24 * 365) {
    throw new Error('Session TTL must be a positive number of hours.');
  }
  return {
    projectsRoot: draft.projectsRoot.trim(),
    serverHost: draft.serverHost.trim(),
    serverPort,
    sessionTtlHours,
    cookieSecure: draft.cookieSecure,
    trustTailscaleHeaders: draft.trustTailscaleHeaders,
  };
}

function normalizeProjectDraft(draft: ProjectDraft): UpdateProjectSettingsRequest {
  const ports = draft.allowedLocalhostPorts
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  if (ports.some((value) => Number.isNaN(value) || value < 1 || value > 65535)) {
    throw new Error('Ports must be whole numbers between 1 and 65535.');
  }
  return {
    active: draft.active,
    displayName: draft.displayName.trim() || undefined,
    allowedLocalhostPorts: [...new Set(ports)].sort((a, b) => a - b),
    tags: [...new Set(draft.tags.split(',').map((value) => value.trim()).filter(Boolean))],
    notes: draft.notes.trim() || undefined,
  };
}

function sameGlobalDraft(settings: SettingsSummary, draft: GlobalDraft): boolean {
  return JSON.stringify(toGlobalDraft(settings)) === JSON.stringify(draft);
}

function sameProjectDraft(project: EditableProjectSettings, draft: ProjectDraft): boolean {
  return JSON.stringify(toProjectDraft(project)) === JSON.stringify(draft);
}

function getRestartUrl(current: SettingsSummary, next: UpdateGlobalSettingsRequest): string {
  const currentUrl = new URL(window.location.href);
  const currentMatchesServer = currentUrl.hostname === current.serverHost
    && Number(currentUrl.port || (currentUrl.protocol === 'https:' ? '443' : '80')) === current.serverPort;
  if (!currentMatchesServer) {
    return currentUrl.toString();
  }
  const nextUrl = new URL(currentUrl.toString());
  nextUrl.hostname = next.serverHost;
  nextUrl.port = String(next.serverPort);
  return nextUrl.toString();
}

export function SettingsPage({ settings, csrfToken }: { settings?: SettingsSummary; csrfToken?: string }) {
  const queryClient = useQueryClient();
  const [globalDraft, setGlobalDraft] = useState<GlobalDraft>();
  const [globalMessage, setGlobalMessage] = useState<string>();
  const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraft>>({});
  const [projectMessages, setProjectMessages] = useState<Record<string, string | undefined>>({});
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setGlobalDraft(toGlobalDraft(settings));
    setProjectDrafts(Object.fromEntries(settings.projects.map((project) => [project.directoryName, toProjectDraft(project)])));
    setGlobalMessage(undefined);
    setProjectMessages({});
  }, [settings]);

  const restartMutation = useMutation({
    mutationFn: () => api.restartServer(csrfToken),
  });

  const globalMutation = useMutation({
    mutationFn: (body: UpdateGlobalSettingsRequest) => api.updateGlobalSettings(body, csrfToken),
    onSuccess: async ({ settings: nextSettings, restartRequired }, variables) => {
      queryClient.setQueryData(['settings'], nextSettings);
      setGlobalDraft(toGlobalDraft(nextSettings));
      setGlobalMessage('Saved. Restart required for runtime changes.');

      if (!restartRequired) return;
      const confirmed = window.confirm('Global settings were saved. Restart now? If not, they will take effect on the next restart.');
      if (!confirmed) return;

      try {
        setGlobalMessage('Restarting server...');
        await restartMutation.mutateAsync();
        const reloadUrl = getRestartUrl(settings ?? nextSettings, variables);
        window.setTimeout(() => {
          window.location.href = reloadUrl;
        }, 1200);
      } catch (error) {
        setGlobalMessage(error instanceof ApiError ? error.message : 'Restart request failed. Restart the server manually to apply the saved settings.');
      }
    },
  });

  const projectMutation = useMutation({
    mutationFn: ({ directoryName, body }: { directoryName: string; body: UpdateProjectSettingsRequest }) =>
      api.updateProjectSettings(directoryName, body, csrfToken),
    onSuccess: ({ project }) => {
      queryClient.setQueryData<SettingsSummary | undefined>(['settings'], (current) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects
            .map((item) => (item.directoryName === project.directoryName ? project : item))
            .sort((a, b) => {
              if (a.active !== b.active) return a.active ? -1 : 1;
              const aLabel = a.displayName ?? a.directoryName;
              const bLabel = b.displayName ?? b.directoryName;
              return aLabel.localeCompare(bLabel);
            }),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      setProjectDrafts((current) => ({ ...current, [project.directoryName]: toProjectDraft(project) }));
      setProjectMessages((current) => ({ ...current, [project.directoryName]: 'Saved.' }));
    },
  });

  const orderedProjects = useMemo(
    () => [...(settings?.projects ?? [])].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const aLabel = a.displayName ?? a.directoryName;
      const bLabel = b.displayName ?? b.directoryName;
      return aLabel.localeCompare(bLabel);
    }),
    [settings?.projects],
  );

  if (!settings || !globalDraft) {
    return <div className="p-6 text-sm text-slate-400">Loading settings…</div>;
  }

  const savingProjectDirectory = projectMutation.variables?.directoryName;
  const globalUnchanged = sameGlobalDraft(settings, globalDraft);
  const discoveredProjects = orderedProjects.filter((project) => project.exists);
  const detachedProjects = orderedProjects.filter((project) => !project.exists);

  function renderProjectCard(project: EditableProjectSettings, detached = false) {
    const draft = projectDrafts[project.directoryName] ?? toProjectDraft(project);
    const unchanged = sameProjectDraft(project, draft);
    const isSaving = projectMutation.isPending && savingProjectDirectory === project.directoryName;
    const message = savingProjectDirectory === project.directoryName && projectMutation.error instanceof ApiError
      ? projectMutation.error.message
      : projectMessages[project.directoryName];

    return (
      <section key={project.directoryName} className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{project.displayName ?? project.directoryName}</h2>
            {detached ? (
              <p className="mt-1 text-xs text-amber-300">
                Stored project config key: <span className="font-mono">{project.directoryName}</span>. It will only apply if a child folder with this exact name exists under the current projects root.
              </p>
            ) : (
              <p className="mt-1 break-all text-xs text-slate-500">{project.path}</p>
            )}
          </div>
          <label className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-2 text-sm text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-500"
              checked={draft.active}
              onChange={(event) => {
                setProjectDrafts((current) => ({
                  ...current,
                  [project.directoryName]: { ...draft, active: event.target.checked },
                }));
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
              }}
            />
            Active
          </label>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Display name</span>
            <input
              type="text"
              value={draft.displayName}
              onChange={(event) => {
                setProjectDrafts((current) => ({
                  ...current,
                  [project.directoryName]: { ...draft, displayName: event.target.value },
                }));
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
              }}
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              placeholder={project.directoryName}
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Allowed localhost ports</span>
            <input
              type="text"
              value={draft.allowedLocalhostPorts}
              onChange={(event) => {
                setProjectDrafts((current) => ({
                  ...current,
                  [project.directoryName]: { ...draft, allowedLocalhostPorts: event.target.value },
                }));
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
              }}
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              placeholder="3000, 5173"
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Tags</span>
            <input
              type="text"
              value={draft.tags}
              onChange={(event) => {
                setProjectDrafts((current) => ({
                  ...current,
                  [project.directoryName]: { ...draft, tags: event.target.value },
                }));
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
              }}
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              placeholder="frontend, primary"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
            <textarea
              value={draft.notes}
              onChange={(event) => {
                setProjectDrafts((current) => ({
                  ...current,
                  [project.directoryName]: { ...draft, notes: event.target.value },
                }));
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
              }}
              rows={3}
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              placeholder="Optional project notes"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className={`text-sm ${message === 'Saved.' ? 'text-emerald-300' : 'text-rose-300'}`}>
            {message ?? ' '}
          </p>
          <button
            type="button"
            disabled={isSaving || unchanged}
            onClick={() => {
              try {
                const body = normalizeProjectDraft(draft);
                setProjectMessages((current) => ({ ...current, [project.directoryName]: undefined }));
                projectMutation.mutate({ directoryName: project.directoryName, body });
              } catch (error) {
                setProjectMessages((current) => ({
                  ...current,
                  [project.directoryName]: error instanceof Error ? error.message : 'Unable to save project settings.',
                }));
              }
            }}
            className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isSaving ? 'Saving…' : unchanged ? 'Saved' : 'Save changes'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <DirectoryPickerModal
        open={directoryPickerOpen}
        initialPath={globalDraft.projectsRoot}
        onClose={() => setDirectoryPickerOpen(false)}
        onSelect={(nextPath) => {
          setGlobalDraft((current) => current ? { ...current, projectsRoot: nextPath } : current);
          setGlobalMessage(undefined);
          setDirectoryPickerOpen(false);
        }}
      />
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Project settings save immediately. Global settings save to the config file and can optionally trigger a restart so runtime catches up.</p>
        </div>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Global settings</h2>
              <p className="mt-1 break-all text-xs text-slate-500">Config file: {settings.configPath}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Agent Console path</div>
              <div className="mt-1 break-all text-sm text-slate-200">{settings.agentConsolePath}</div>
              <div className="mt-2 text-xs text-slate-500">This is where the app itself is currently running. It is separate from `projectsRoot`.</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Config file</div>
              <div className="mt-1 break-all text-sm text-slate-200">{settings.configPath}</div>
              <div className="mt-2 text-xs text-slate-500">Global setting edits are written here and may require restart to take effect.</div>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-slate-500">Projects root</span>
                <button
                  type="button"
                  onClick={() => setDirectoryPickerOpen(true)}
                  className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                >
                  Browse folders
                </button>
              </div>
              <input
                type="text"
                value={globalDraft.projectsRoot}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, projectsRoot: event.target.value } : current);
                  setGlobalMessage(undefined);
                }}
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              />
            </div>

            <label className="space-y-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Server host</span>
              <input
                type="text"
                value={globalDraft.serverHost}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, serverHost: event.target.value } : current);
                  setGlobalMessage(undefined);
                }}
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              />
            </label>

            <label className="space-y-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Server port</span>
              <input
                type="text"
                value={globalDraft.serverPort}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, serverPort: event.target.value } : current);
                  setGlobalMessage(undefined);
                }}
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              />
            </label>

            <label className="space-y-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Session TTL hours</span>
              <input
                type="text"
                value={globalDraft.sessionTtlHours}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, sessionTtlHours: event.target.value } : current);
                  setGlobalMessage(undefined);
                }}
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              />
            </label>

            <label className="inline-flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cyan-500"
                checked={globalDraft.cookieSecure}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, cookieSecure: event.target.checked } : current);
                  setGlobalMessage(undefined);
                }}
              />
              Cookie secure
            </label>

            <label className="inline-flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cyan-500"
                checked={globalDraft.trustTailscaleHeaders}
                onChange={(event) => {
                  setGlobalDraft((current) => current ? { ...current, trustTailscaleHeaders: event.target.checked } : current);
                  setGlobalMessage(undefined);
                }}
              />
              Trust Tailscale headers
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className={`text-sm ${globalMessage === 'Saved.' || globalMessage?.startsWith('Saved.') || globalMessage === 'Restarting server...' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {globalMutation.error instanceof ApiError ? globalMutation.error.message : globalMessage ?? ' '}
            </p>
            <button
              type="button"
              disabled={globalMutation.isPending || restartMutation.isPending || globalUnchanged}
              onClick={() => {
                try {
                  const body = normalizeGlobalDraft(globalDraft);
                  setGlobalMessage(undefined);
                  globalMutation.mutate(body);
                } catch (error) {
                  setGlobalMessage(error instanceof Error ? error.message : 'Unable to save global settings.');
                }
              }}
              className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {globalMutation.isPending || restartMutation.isPending ? 'Saving…' : globalUnchanged ? 'Saved' : 'Save global settings'}
            </button>
          </div>
        </section>

        <div className="space-y-6">
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Projects under current root</h2>
              <p className="mt-1 text-sm text-slate-400">These are immediate child directories currently found under the selected `projectsRoot`.</p>
            </div>
            {discoveredProjects.length ? discoveredProjects.map((project) => renderProjectCard(project)) : (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 text-sm text-slate-400 shadow-panel">
                No project directories were found under the current projects root.
              </div>
            )}
          </section>

          {detachedProjects.length ? (
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Stored project configs not found under current root</h2>
                <p className="mt-1 text-sm text-slate-400">These are saved config entries keyed by directory name. They are not real directories under the current root, so their settings will not apply until matching child folders exist there.</p>
              </div>
              {detachedProjects.map((project) => renderProjectCard(project, true))}
            </section>
          ) : null}
        </div>
        </div>
      </div>
    </>
  );
}
