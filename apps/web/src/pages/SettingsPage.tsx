import type { SettingsSummary } from '@agent-console/shared';

export function SettingsPage({ settings }: { settings?: SettingsSummary }) {
  if (!settings) {
    return <div className="p-6 text-sm text-slate-400">Loading settings…</div>;
  }
  return (
    <div className="p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Server runtime configuration and security posture.</p>
        </div>
        <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-panel">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Config path</dt>
              <dd className="mt-1 break-all text-sm text-slate-200">{settings.configPath}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Projects root</dt>
              <dd className="mt-1 break-all text-sm text-slate-200">{settings.projectsRoot}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Listen address</dt>
              <dd className="mt-1 text-sm text-slate-200">{settings.serverHost}:{settings.serverPort}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Session TTL</dt>
              <dd className="mt-1 text-sm text-slate-200">{settings.security.sessionTtlHours} hours</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Cookie secure</dt>
              <dd className="mt-1 text-sm text-slate-200">{settings.security.cookieSecure ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Tailscale identity bootstrap</dt>
              <dd className="mt-1 text-sm text-slate-200">{settings.security.trustTailscaleHeaders ? 'Enabled' : 'Disabled'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
