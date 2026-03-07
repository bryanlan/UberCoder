export function nowIso(): string {
  return new Date().toISOString();
}

export function maxIso(...values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value));
  if (filtered.length === 0) return undefined;
  return filtered.sort().at(-1);
}
