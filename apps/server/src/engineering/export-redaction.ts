import contract from './export_redaction.v1.json' with { type: 'json' };

// This packaged contract is shared with the independently runnable owner exports.
const rules = contract.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, `${rule.flags}g`) }));
const sensitiveKey = new RegExp(contract.sensitive_key, 'i');
export function redactText(value: string): string {
  return rules.reduce((text, rule) => text.replace(rule.regex, rule.replacement), value);
}

/** Sanitize the complete boundary object, including free-text map keys. */
export function sanitizeExport<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(item => sanitizeExport(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redactText(key), sensitiveKey.test(key)
      ? '[credential omitted]' : sanitizeExport(item)]),
  ) as T;
  return value;
}
