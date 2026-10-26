// Portions of this file are copied from T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2):
//   apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, lines 1473-1545
//   (`redactCodexProtocolValue`, `isSensitiveCodexProtocolKey`).
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Modification: T3 bounded values with its own `boundProviderEventForLogging`. This copy uses the local
// `boundProtocolValue` below, so the helpers do not depend on T3 modules.

const MAX_STRING_CHARACTERS = 2_000;
const MAX_ENTRIES = 50;
const MAX_DEPTH = 6;

/** Bounded copy of a protocol value for logs: long strings, wide objects and deep trees are cut. */
export function boundProtocolValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARACTERS ? `${value.slice(0, MAX_STRING_CHARACTERS)}...[${value.length} chars]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((entry) => boundProtocolValue(entry, depth + 1));
    return value.length > MAX_ENTRIES ? [...items, `[${value.length - MAX_ENTRIES} more]`] : items;
  }
  const entries = Object.entries(value);
  const bounded = Object.fromEntries(entries.slice(0, MAX_ENTRIES).map(([key, nested]) => [key, boundProtocolValue(nested, depth + 1)]));
  if (entries.length > MAX_ENTRIES) bounded['[truncated]'] = `${entries.length - MAX_ENTRIES} more keys`;
  return bounded;
}

export function redactCodexProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCodexProtocolValue);
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') {
      return value;
    }
    if (/^Bearer\s+/i.test(value)) {
      return '[REDACTED]';
    }
    const trimmed = value.trim();
    if (
      !(
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      )
    ) {
      return value;
    }
    try {
      return JSON.stringify(redactCodexProtocolValue(boundProtocolValue(JSON.parse(trimmed) as unknown)));
    } catch {
      return value;
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveCodexProtocolKey(key) ? '[REDACTED]' : redactCodexProtocolValue(nested),
    ]),
  );
}

export function isSensitiveCodexProtocolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.endsWith('authorization') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret')
  );
}

/** Bounded and redacted copy of a value, for log fields. */
export function redactedLogValue(value: unknown): unknown {
  return redactCodexProtocolValue(boundProtocolValue(value));
}

/** Redacts credential-looking substrings from free text (error messages) and bounds its length. */
export function redactFreeText(text: string, maxLength = 2_000): string {
  const redacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi, '$1[REDACTED]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}
