import contract from './export_redaction.v1.json' with { type: 'json' };

// Independently runnable owners package the same versioned data contract.
const rules = contract.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, `${rule.flags}g`) }));
const sensitiveKey = new RegExp(contract.sensitive_key, 'i');
const entropyPattern = new RegExp(contract.entropy.pattern, 'g');
const uuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i;
const identifier = /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const prefixedIdentifiers = contract.identifier_patterns.map(pattern => new RegExp(`^(?:${pattern})$`, 'i'));
const pathIdentifier = /[a-z0-9_./ +@()\[\]-]+/i;
const publicFields = new Set<string>(contract.public_fields);
const identifierFields = new Set<string>(contract.identifier_fields);
const pathFields = new Set<string>(contract.path_fields);
const repoIdentifierFields = new Set<string>(contract.repo_identifier_fields);
const publicValues: Record<string, readonly string[]> = contract.public_values;
const fullMatch = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;

export function isPathIdentifier(value: string, allowName = false): boolean {
  return (allowName || value.includes('/') || /\.[a-z0-9]{1,8}$/i.test(value)) && fullMatch(pathIdentifier, value)
    && value.length <= contract.max_export_text_length;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

export function redactText(value: string, allowedIdentifiers: ReadonlySet<string> = new Set()): string {
  const text = rules.reduce((result, rule) => result.replace(rule.regex, rule.replacement), value);
  return text.replace(entropyPattern, candidate => allowedIdentifiers.has(candidate) || fullMatch(uuid, candidate)
    || entropy(candidate) < contract.entropy.minimum_bits_per_character ? candidate : contract.entropy.replacement);
}

/** Redact values only. Owners validate structural and identifier-map keys. */
export function sanitizeExport<T>(value: T): T {
  const allowed = new Set<string>();
  function collect(item: unknown, field = ''): void {
    if (typeof item === 'string') {
      if (identifierFields.has(field) && (fullMatch(identifier, item) || fullMatch(uuid, item)
        || prefixedIdentifiers.some(pattern => fullMatch(pattern, item)))) {
        allowed.add(item);
        for (const match of item.matchAll(entropyPattern)) allowed.add(match[0]);
      }
      if (pathFields.has(field) && isPathIdentifier(item, repoIdentifierFields.has(field))) {
        for (const match of item.matchAll(entropyPattern)) allowed.add(match[0]);
      }
    } else if (Array.isArray(item)) {
      for (const child of item) collect(child, field);
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) collect(child, key);
    }
  }
  function walk(item: unknown, field = ''): unknown {
    const publicValue = typeof item === 'string' && (publicValues[field] ?? []).includes(item);
    if (fullMatch(sensitiveKey, field) && !publicFields.has(field) && !publicValue) return '[credential omitted]';
    if (typeof item === 'string') {
      if (pathFields.has(field) && isPathIdentifier(item, repoIdentifierFields.has(field))) return item;
      return Array.from(redactText(item, allowed)).slice(0, contract.max_export_text_length).join('');
    }
    if (Array.isArray(item)) return item.map(child => walk(child, field));
    if (item && typeof item === 'object') return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [key, walk(child, key)]),
    );
    return item;
  }
  collect(value);
  return walk(value) as T;
}
