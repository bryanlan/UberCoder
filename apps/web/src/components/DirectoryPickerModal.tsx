import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';

export function DirectoryPickerModal({
  open,
  initialPath,
  onClose,
  onSelect,
}: {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [currentPath, setCurrentPath] = useState(initialPath);

  useEffect(() => {
    if (!open) return;
    setCurrentPath(initialPath);
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

  if (!open) return null;

  const current = directoryQuery.data?.currentPath ?? currentPath;
  const errorMessage = directoryQuery.error instanceof ApiError ? directoryQuery.error.message : 'Unable to load directories.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-3xl border border-slate-800 bg-slate-900 p-5 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Choose projects root</h2>
            <p className="mt-1 text-sm text-slate-400">Browse folders on the Linux host. The selected path is written into config as `projectsRoot`.</p>
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

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400">Choose the currently shown folder to use it as the projects root.</p>
          <button
            type="button"
            onClick={() => onSelect(current)}
            className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
