import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

type CheckoutIdentity = { checkout: string; repository: string };

// Hooks, the coordination MCP and the activity panel ask for the same few directories many times a
// second. Each lookup runs two synchronous `git rev-parse` calls that block the event loop, which on a
// loaded host cost seconds per request (2026-11-21). A directory's checkout and repository do not
// change while it exists, so successful lookups are reused briefly; failures are never cached.
const IDENTITY_TTL_MS = 60_000;
const identities = new Map<string, { identity: CheckoutIdentity; expiresAt: number }>();

// Repository discovery is read-only. Coordination never stages or mutates Git.
export function checkoutIdentity(directory: string): CheckoutIdentity {
  const now = Date.now();
  const cached = identities.get(directory);
  if (cached && cached.expiresAt > now) return cached.identity;
  const resolve = (cwd: string, args: string[]) => fs.realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  const checkout = resolve(directory, ['--show-toplevel']);
  const repository = resolve(checkout, ['--path-format=absolute', '--git-common-dir']);
  const identity = { checkout, repository };
  if (identities.size > 500) identities.clear();
  identities.set(directory, { identity, expiresAt: now + IDENTITY_TTL_MS });
  return identity;
}
