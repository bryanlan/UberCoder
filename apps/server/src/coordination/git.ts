import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Repository discovery is read-only. Coordination never stages or mutates Git.
export function checkoutIdentity(directory: string): { checkout: string; repository: string } {
  const resolve = (cwd: string, args: string[]) => fs.realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  const checkout = resolve(directory, ['--show-toplevel']);
  const repository = resolve(checkout, ['--path-format=absolute', '--git-common-dir']);
  return { checkout, repository };
}
