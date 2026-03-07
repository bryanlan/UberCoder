import { createHash } from 'node:crypto';

export function truncate(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function coerceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function stableTextHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function stripAnsiAndControl(text: string): string {
  let cleaned = text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001BP[\s\S]*?\u001B\\/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/\r\n?/g, '\n');

  while (/[^\n]\u0008/.test(cleaned)) {
    cleaned = cleaned.replace(/[^\n]\u0008/g, '');
  }

  return cleaned.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

export function normalizeComparableText(text: string): string {
  return normalizeWhitespace(stripAnsiAndControl(text)).toLowerCase();
}
