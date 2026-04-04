import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';

export function DirectoryPickerModal({
  open,
  initialPath,
  onClose,
  onSelect,
  title = 'Choose projects root',
  description = 'Browse folders on the Linux host. The selected path is written into config as `projectsRoot`.',
  confirmLabel = 'Use this folder',
  helperText = 'Choose the currently shown folder to use it as the projects root.',
  allowCreateDirectory = false,
  createDirectoryRoot,
  createDirectoryLabel = 'Create folder',
  csrfToken,
}: {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  helperText?: string;
  allowCreateDirectory?: boolean;
  createDirectoryRoot?: string;
  createDirectoryLabel?: string;
  csrfToken?: string;
}) {
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [newDirectoryName, setNewDirectoryName] = useState('');
  const [createMessage, setCreateMessage] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setCurrentPath(initialPath);
    setNewDirectoryName('');
    setCreateMessage(undefined);
  }, [initialPath, open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  const directoryQuery = useQuery({
    queryKey: ['directory-browser', currentPath],
    queryFn: () => api.browseDirectories(currentPath),
    enabled: open,
  });

  const createDirectoryMutation = useMutation({
    mutationFn: ({ parentPath, name }: { parentPath: string; name: string }) => api.createDirectory({ parentPath, name }, csrfToken),
    onSuccess: async ({ path: createdPath }) => {
      setCreateMessage('Folder created.');
      setNewDirectoryName('');
      setCurrentPath(createdPath);
      await queryClient.invalidateQueries({ queryKey: ['directory-browser'] });
    },
  });

  if (!open) return null;

  const current = directoryQuery.data?.currentPath ?? currentPath;
  const errorMessage = directoryQuery.error instanceof ApiError ? directoryQuery.error.message : 'Unable to load directories.';
  const createErrorMessage = createDirectoryMutation.error instanceof ApiError
    ? createDirectoryMutation.error.message
    : createMessage;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-3xl border border-slate-800 bg-slate-900 p-5 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => directoryQuery.data?.rootPath && setCurrentPath(directoryQuery.data.rootPath)}
            className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
          >
            Root
          </button>
          <button
            type="button"
            onClick={() => directoryQuery.data?.homePath && setCurrentPath(directoryQuery.data.homePath)}
            className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
          >
            Home
          </button>
          <button
            type="button"
            disabled={!directoryQuery.data?.parentPath}
            onClick={() => directoryQuery.data?.parentPath && setCurrentPath(directoryQuery.data.parentPath)}
            className="rounded-2xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
          >
            Up
          </button>
          <div className="min-w-0 flex-1 rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300">
            <div className="text-xs uppercase tracking-wide text-slate-500">Current folder</div>
            <div className="mt-1 break-all">{current}</div>
          </div>
        </div>

        <div className="mt-4 rounded-3xl border border-slate-800 bg-slate-950/70">
          {directoryQuery.isLoading ? (
            <div className="p-4 text-sm text-slate-400">Loading directories…</div>
          ) : directoryQuery.error ? (
            <div className="p-4 text-sm text-rose-300">{errorMessage}</div>
          ) : directoryQuery.data?.directories.length ? (
            <div className="max-h-96 overflow-y-auto p-2">
              {directoryQuery.data.directories.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setCurrentPath(entry.path)}
                  className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm text-slate-200 transition hover:bg-slate-800"
                >
                  <span className="min-w-0 truncate">{entry.name}</span>
                  {entry.isSymlink ? <span className="ml-3 shrink-0 text-xs text-amber-300">symlink</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-slate-400">No child directories here.</div>
          )}
        </div>

        {allowCreateDirectory ? (
          <div className="mt-4 rounded-3xl border border-slate-800 bg-slate-950/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Create child folder</div>
            <div className="mt-3 flex flex-col gap-3 md:flex-row">
              <input
                type="text"
                value={newDirectoryName}
                onChange={(event) => {
                  setNewDirectoryName(event.target.value);
                  setCreateMessage(undefined);
                }}
                placeholder="new-workspace"
                className="min-w-0 flex-1 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500"
              />
              <button
                type="button"
                disabled={createDirectoryMutation.isPending || !newDirectoryName.trim() || (createDirectoryRoot ? !current.startsWith(createDirectoryRoot) : false)}
                onClick={() => {
                  setCreateMessage(undefined);
                  createDirectoryMutation.mutate({ parentPath: current, name: newDirectoryName.trim() });
                }}
                className="rounded-2xl border border-slate-700 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              >
                {createDirectoryMutation.isPending ? 'Creating…' : createDirectoryLabel}
              </button>
            </div>
            <p className={`mt-3 text-sm ${createErrorMessage === 'Folder created.' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {createErrorMessage ?? 'Create an empty folder here, then add it as a project.'}
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400">{helperText}</p>
          <button
            type="button"
            onClick={() => onSelect(current)}
            className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
