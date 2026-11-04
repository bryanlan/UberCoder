// Small readers over untyped JSON-RPC frames. A value that does not have the expected shape is ignored, never trusted.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The current value of a `select` config option in a `configOptions` list. */
export function readConfigValue(options: unknown, id: string): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (isRecord(option) && option.id === id) return asString(option.currentValue);
  }
  return undefined;
}
