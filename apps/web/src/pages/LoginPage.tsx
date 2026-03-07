import { useState } from 'react';
import { LockKeyhole, Wifi } from 'lucide-react';

interface LoginPageProps {
  onSubmit: (password: string) => Promise<void>;
  loading: boolean;
  error?: string;
  tailscaleEnabled: boolean;
}

export function LoginPage({ onSubmit, loading, error, tailscaleEnabled }: LoginPageProps) {
  const [password, setPassword] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/90 p-8 shadow-panel">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl border border-sky-400/30 bg-sky-500/10 p-3 text-sky-200">
            <LockKeyhole className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Agent Console</h1>
            <p className="text-sm text-slate-400">Single-user remote control for local Codex and Claude sessions.</p>
          </div>
        </div>

        {tailscaleEnabled && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            <Wifi className="h-4 w-4" />
            If you are coming through Tailscale Serve, the app can auto-authenticate after the first probe.
          </div>
        )}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!password.trim()) return;
            await onSubmit(password.trim());
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-2 block text-sm text-slate-300">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none transition focus:border-sky-400"
              placeholder="Enter your password"
            />
          </label>
          {error && <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 font-medium text-sky-50 transition hover:bg-sky-500/20 disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
