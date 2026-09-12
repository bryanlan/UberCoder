import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function git(cwd: string, args: string[], environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['--literal-pathspecs', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function preparedTree(checkout: string, paths: string[]): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-index-'));
  try {
    const environment = { GIT_INDEX_FILE: path.join(temporary, 'index') };
    git(checkout, ['read-tree', 'HEAD'], environment);
    git(checkout, ['add', '--', ...paths], environment);
    return git(checkout, ['write-tree'], environment);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function checkoutIdentity(directory: string): { checkout: string; repository: string } {
  const checkout = fs.realpathSync(git(directory, ['rev-parse', '--show-toplevel']));
  const repository = fs.realpathSync(git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return { checkout, repository };
}

export function claimPath(checkout: string, value: string): string {
  if (value === '.') return '.';
  const absolute = path.resolve(checkout, value);
  const relative = path.relative(checkout, absolute);
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('Claim path must be inside the checkout.');
  }
  // Symlink aliases must not give two names to the same editable resource.
  // Leave symlink edits to explicit human-reviewed reconciliation.
  let cursor = checkout;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlink paths require explicit reconciliation; claim the real target instead.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (relative.split(path.sep).includes('.git')) throw new Error('Git metadata cannot be claimed as an editable file.');
  return relative;
}

export function overlaps(a: string, b: string): boolean {
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function dirty(checkout: string, paths: string[]): boolean {
  return Boolean(git(checkout, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths]));
}

export function commitFingerprint(checkout: string, paths: string[]): string {
  // Include untracked content as well as tracked diffs and HEAD/index state.
  const files = git(checkout, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]).split('\0').filter(Boolean);
  const hash = createHash('sha256').update(git(checkout, ['rev-parse', 'HEAD']));
  hash.update(git(checkout, ['diff', '--cached', '--binary']));
  hash.update(git(checkout, ['diff', '--binary', 'HEAD', '--', ...paths]));
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    const absolute = path.join(checkout, file);
    try {
      const stat = fs.lstatSync(absolute);
      hash.update(String(stat.mode));
      hash.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('deleted');
    }
  }
  return hash.digest('hex');
}
