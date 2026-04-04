import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  EditableProjectSettings,
  SettingsSummary,
  UiPreferences,
  UpdateGlobalSettingsRequest,
  UpdateProjectSettingsRequest,
  UpdateUiPreferencesRequest,
} from '@agent-console/shared';
import { Link } from 'react-router-dom';
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

interface FreshnessDraft {
  yellowMinutes: string;
  orangeMinutes: string;
  redMinutes: string;
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

function toFreshnessDraft(uiPreferences: UiPreferences): FreshnessDraft {
  return {
    yellowMinutes: String(uiPreferences.sessionFreshnessThresholds.yellowMinutes),
    orangeMinutes: String(uiPreferences.sessionFreshnessThresholds.orangeMinutes),
    redMinutes: String(uiPreferences.sessionFreshnessThresholds.redMinutes),
  };
}

function normalizeFreshnessDraft(draft: FreshnessDraft): UpdateUiPreferencesRequest {
  const yellowMinutes = Number.parseInt(draft.yellowMinutes, 10);
  const orangeMinutes = Number.parseInt(draft.orangeMinutes, 10);
  const redMinutes = Number.parseInt(draft.redMinutes, 10);

  if ([yellowMinutes, orangeMinutes, redMinutes].some((value) => Number.isNaN(value) || value < 1 || value > 24 * 60)) {
    throw new Error('Freshness thresholds must be whole numbers between 1 and 1440 minutes.');
  }

  if (!(yellowMinutes < orangeMinutes && orangeMinutes < redMinutes)) {
    throw new Error('Freshness thresholds must increase from yellow to orange to red.');
  }

  return {
    sessionFreshnessThresholds: {
      yellowMinutes,
      orangeMinutes,
      redMinutes,
    },
  };
}

function sameGlobalDraft(settings: SettingsSummary, draft: GlobalDraft): boolean {
  return JSON.stringify(toGlobalDraft(settings)) === JSON.stringify(draft);
}

function sameProjectDraft(project: EditableProjectSettings, draft: ProjectDraft): boolean {
  return JSON.stringify(toProjectDraft(project)) === JSON.stringify(draft);
}

function sameFreshnessDraft(uiPreferences: UiPreferences, draft: FreshnessDraft): boolean {
  return JSON.stringify(toFreshnessDraft(uiPreferences)) === JSON.stringify(draft);
}

function sortProjects(a: EditableProjectSettings, b: EditableProjectSettings): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  const aLabel = a.displayName ?? a.directoryName;
  const bLabel = b.displayName ?? b.directoryName;
  return aLabel.localeCompare(bLabel);
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

export function SettingsPage({
  settings,
  uiPreferences,
  onUpdateUiPreferences,
  updatingUiPreferences,
  csrfToken,
  backHref,
}: {
  settings?: SettingsSummary;
  uiPreferences: UiPreferences;
  onUpdateUiPreferences: (body: UpdateUiPreferencesRequest) => Promise<boolean>;
  updatingUiPreferences: boolean;
  csrfToken?: string;
  backHref: string;
}) {
  const queryClient = useQueryClient();
  const [globalDraft, setGlobalDraft] = useState<GlobalDraft>();
  const [globalMessage, setGlobalMessage] = useState<string>();
  const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraft>>({});
  const [projectMessages, setProjectMessages] = useState<Record<string, string | undefined>>({});
  const [freshnessDraft, setFreshnessDraft] = useState<FreshnessDraft>(() => toFreshnessDraft(uiPreferences));
  const [freshnessMessage, setFreshnessMessage] = useState<string>();
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setGlobalDraft(toGlobalDraft(settings));
    setProjectDrafts(Object.fromEntries(settings.projects.map((project) => [project.directoryName, toProjectDraft(project)])));
    setGlobalMessage(undefined);
    setProjectMessages({});
  }, [settings]);

  useEffect(() => {
    setFreshnessDraft(toFreshnessDraft(uiPreferences));
    setFreshnessMessage(undefined);
  }, [uiPreferences]);

  async function refreshProjectTree(): Promise<void> {
    await queryClient.fetchQuery({
      queryKey: ['tree'],
      queryFn: () => api.refreshTree(csrfToken),
    });
  }

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
    onSuccess: async ({ project }) => {
      queryClient.setQueryData<SettingsSummary | undefined>(['settings'], (current) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects
            .map((item) => (item.directoryName === project.directoryName ? project : item))
            .sort(sortProjects),
        };
      });
      await refreshProjectTree();
      setProjectDrafts((current) => ({ ...current, [project.directoryName]: toProjectDraft(project) }));
      setProjectMessages((current) => ({ ...current, [project.directoryName]: 'Saved.' }));
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: ({ path }: { path: string }) => api.createProject({ path }, csrfToken),
    onSuccess: async ({ project }) => {
      queryClient.setQueryData<SettingsSummary | undefined>(['settings'], (current) => {
        if (!current) return current;
        return {
          ...current,
          projects: [...current.projects, project].sort(sortProjects),
        };
      });
      await refreshProjectTree();
      setProjectDrafts((current) => ({ ...current, [project.directoryName]: toProjectDraft(project) }));
      setProjectMessages((current) => ({ ...current, [project.directoryName]: 'Saved.' }));
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: ({ directoryName }: { directoryName: string }) => api.deleteProject(directoryName, csrfToken),
    onSuccess: async (_result, variables) => {
      queryClient.setQueryData<SettingsSummary | undefined>(['settings'], (current) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects.filter((project) => project.directoryName !== variables.directoryName),
        };
      });
      await refreshProjectTree();
      setProjectDrafts((current) => {
        const next = { ...current };
        delete next[variables.directoryName];
        return next;
      });
      setProjectMessages((current) => {
        const next = { ...current };
        delete next[variables.directoryName];
        return next;
      });
    },
  });

  const orderedProjects = useMemo(
    () => [...(settings?.projects ?? [])].sort(sortProjects),
    [settings?.projects],
  );

  if (!settings || !globalDraft) {
    return <div className="p-6 text-sm text-slate-400">Loading settings…</div>;
  }

  const savingProjectDirectory = projectMutation.variables?.directoryName;
  const deletingProjectDirectory = deleteProjectMutation.variables?.directoryName;
  const globalUnchanged = sameGlobalDraft(settings, globalDraft);
  const freshnessUnchanged = sameFreshnessDraft(uiPreferences, freshnessDraft);

  function renderProjectCard(project: EditableProjectSettings) {
    const draft = projectDrafts[project.directoryName] ?? toProjectDraft(project);
    const unchanged = sameProjectDraft(project, draft);
    const isSaving = projectMutation.isPending && savingProjectDirectory === project.directoryName;
    const isDeleting = deleteProjectMutation.isPending && deletingProjectDirectory === project.directoryName;
    const message = savingProjectDirectory === project.directoryName && projectMutation.error instanceof ApiError
      ? projectMutation.error.message
      : projectMessages[project.directoryName];

    return (
      <section key={project.directoryName} className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{project.displayName ?? project.directoryName}</h2>
            <p className="mt-1 break-all text-xs text-slate-500">{project.path}</p>
            <p className="mt-1 text-xs text-slate-600">Config key: <span className="font-mono">{project.directoryName}</span></p>
            {!project.exists ? <p className="mt-1 text-xs text-amber-300">This saved project path is missing under the current projects root.</p> : null}
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => {
                const confirmed = window.confirm(`Remove ${project.displayName ?? project.directoryName} from saved projects?`);
                if (!confirmed) return;
                deleteProjectMutation.mutate({ directoryName: project.directoryName });
              }}
              className="rounded-2xl border border-rose-800 px-4 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-600 hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
            >
              {isDeleting ? 'Removing…' : 'Remove project'}
            </button>
            <button
              type="button"
              disabled={isSaving || isDeleting || unchanged}
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
        title="Choose projects root"
        description="Browse folders on the Linux host. The selected path is written into config as `projectsRoot`."
        confirmLabel="Use this folder"
        helperText="Choose the currently shown folder to use it as the projects root."
        onSelect={(nextPath) => {
          setGlobalDraft((current) => current ? { ...current, projectsRoot: nextPath } : current);
          setGlobalMessage(undefined);
          setDirectoryPickerOpen(false);
        }}
      />
      <DirectoryPickerModal
        open={projectPickerOpen}
        initialPath={globalDraft.projectsRoot}
        onClose={() => setProjectPickerOpen(false)}
        title="Add project"
        description="Choose any folder under the current projects root. Saved Codex and Claude history will still be indexed even without AGENTS.md or CLAUDE.md."
        confirmLabel="Add this project"
        helperText="The selected folder will be saved as an explicit project path."
        allowCreateDirectory
        createDirectoryRoot={globalDraft.projectsRoot}
        createDirectoryLabel="Create folder here"
        csrfToken={csrfToken}
        onSelect={(nextPath) => {
          createProjectMutation.mutate({ path: nextPath });
          setProjectPickerOpen(false);
        }}
      />
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <div>
            <Link
              to={backHref}
              className="mb-3 inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
            >
              Back to Console
            </Link>
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

          <section className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-panel">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Bound session freshness</h2>
              <p className="mt-1 text-sm text-slate-400">These thresholds control the work-mode activity dot for bound Codex and Claude sessions. They save immediately and roam across browsers.</p>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Yellow after minutes</span>
                <input
                  type="text"
                  value={freshnessDraft.yellowMinutes}
                  onChange={(event) => {
                    setFreshnessDraft((current) => ({ ...current, yellowMinutes: event.target.value }));
                    setFreshnessMessage(undefined);
                  }}
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
                />
              </label>

              <label className="space-y-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Orange after minutes</span>
                <input
                  type="text"
                  value={freshnessDraft.orangeMinutes}
                  onChange={(event) => {
                    setFreshnessDraft((current) => ({ ...current, orangeMinutes: event.target.value }));
                    setFreshnessMessage(undefined);
                  }}
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
                />
              </label>

              <label className="space-y-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Red after minutes</span>
                <input
                  type="text"
                  value={freshnessDraft.redMinutes}
                  onChange={(event) => {
                    setFreshnessDraft((current) => ({ ...current, redMinutes: event.target.value }));
                    setFreshnessMessage(undefined);
                  }}
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className={`text-sm ${freshnessMessage === 'Saved.' ? 'text-emerald-300' : 'text-rose-300'}`}>
                {freshnessMessage ?? ' '}
              </p>
              <button
                type="button"
                disabled={updatingUiPreferences || freshnessUnchanged}
                onClick={async () => {
                  try {
                    const body = normalizeFreshnessDraft(freshnessDraft);
                    setFreshnessMessage(undefined);
                    const saved = await onUpdateUiPreferences(body);
                    if (saved) {
                      setFreshnessMessage('Saved.');
                    }
                  } catch (error) {
                    setFreshnessMessage(error instanceof Error ? error.message : 'Unable to save freshness thresholds.');
                  }
                }}
                className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {updatingUiPreferences ? 'Saving…' : freshnessUnchanged ? 'Saved' : 'Save freshness thresholds'}
              </button>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Saved projects</h2>
                <p className="mt-1 text-sm text-slate-400">Projects are explicit folders under `projectsRoot`. Marker files are optional; saved Codex and Claude history is matched from the folder path.</p>
              </div>
              <button
                type="button"
                onClick={() => setProjectPickerOpen(true)}
                className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                Add project
              </button>
            </div>
            <p className="text-sm text-rose-300">
              {createProjectMutation.error instanceof ApiError ? createProjectMutation.error.message : ' '}
            </p>
            {orderedProjects.length ? orderedProjects.map((project) => renderProjectCard(project)) : (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 text-sm text-slate-400 shadow-panel">
                No saved projects yet. Add a folder under the current projects root to make it appear in the console.
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
