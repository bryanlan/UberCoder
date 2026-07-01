export type SqliteRow = Record<string, unknown>;

export function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

export function boolAsInt(value: boolean): number {
  return value ? 1 : 0;
}

export function optionalString(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return undefined;
  return Number(value);
}
