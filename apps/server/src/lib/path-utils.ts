import os from 'node:os';
import path from 'node:path';

export function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeFsPath(input: string): string {
  return path.resolve(expandHome(input));
}

export function toPosixPath(input: string): string {
  return input.split(path.sep).join('/');
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function safeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}
