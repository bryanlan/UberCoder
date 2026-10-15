import contract from './export_redaction.v1.json' with { type: 'json' };

// Independently runnable owners package the same versioned data contract.
const rules = contract.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, `${rule.flags}g`) }));
const providerRules = contract.provider_rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, `${rule.flags}g`) }));
const sensitiveKey = new RegExp(contract.sensitive_key, 'i');
const entropyPattern = new RegExp(contract.entropy.pattern, 'g');
const uuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i;
const identifier = /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const prefixedIdentifiers = contract.identifier_patterns.map(pattern => new RegExp(`^(?:${pattern})$`, 'i'));
const pathIdentifier = /[^\x00-\x1f\x7f:="'<>|\\]+/;
const countMapPaths = contract.count_map_paths.map(path => path.split('.'));
const publicFields = new Set<string>(contract.public_fields);
const freeTextFields = new Set<string>(contract.free_text_fields);
const identifierFields = new Set<string>(contract.identifier_fields);
const pathFields = new Set<string>(contract.path_fields);
const fieldIdentifiers = new Map(Object.entries(contract.identifier_field_patterns).map(([field, pattern]) => [field, new RegExp(`^(?:${pattern})$`)]));
const repoIdentifierFields = new Set<string>(contract.repo_identifier_fields);
const publicValues: Record<string, readonly string[]> = contract.public_values;
const fullMatch = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;

export function isPathIdentifier(value: string, allowName = false): boolean {
  return Boolean(value.trim() && (allowName || value.includes('/') || /\.[a-z0-9]{1,8}$/i.test(value))
    && fullMatch(pathIdentifier, value) && Array.from(value).length <= contract.max_export_text_length);
}

function isMetadata(value: string, field: string): boolean {
  if (freeTextFields.has(field)) return false;
  if (identifierFields.has(field) && (fullMatch(identifier, value) || fullMatch(uuid, value)
    || prefixedIdentifiers.some(pattern => fullMatch(pattern, value)))) return true;
  const fieldPattern = fieldIdentifiers.get(field);
  if (fieldPattern && fullMatch(fieldPattern, value)) return true;
  return pathFields.has(field) && isPathIdentifier(value, repoIdentifierFields.has(field));
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

function redactProviders(value: string): string {
  for (const rule of providerRules) {
    if (!rule.keywords.length || rule.keywords.some(keyword => value.toLowerCase().includes(keyword))) {
      value = value.replace(rule.regex, rule.replacement);
    }
  }
  return value;
}

export function redactText(value: string, allowedIdentifiers: ReadonlySet<string> = new Set()): string {
  const text = rules.reduce((result, rule) => result.replace(rule.regex, rule.replacement), value);
  return redactProviders(text).replace(entropyPattern, candidate => allowedIdentifiers.has(candidate) || fullMatch(uuid, candidate)
    || entropy(candidate) < contract.entropy.minimum_bits_per_character ? candidate : contract.entropy.replacement);
}

/** Redact values only. Owners validate structural and identifier-map keys. */
export function sanitizeExport<T>(value: T): T {
  const allowed = new Set<string>();
  function collect(item: unknown, field = ''): void {
    if (typeof item === 'string') {
      if (isMetadata(item, field)) {
        allowed.add(item);
        for (const match of item.matchAll(entropyPattern)) allowed.add(match[0]);
      }
    } else if (Array.isArray(item)) {
      for (const child of item) collect(child, field);
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) collect(child, key);
    }
  }
  function walk(item: unknown, field = '', fieldPath: readonly string[] = []): unknown {
    const publicValue = typeof item === 'string' && (publicValues[field] ?? []).includes(item);
    if (typeof item === 'string' && (publicValue || isMetadata(item, field))) return item;
    if (fullMatch(sensitiveKey, field) && !publicFields.has(field) && !publicValue) return '[credential omitted]';
    if (typeof item === 'string') {
      return Array.from(redactText(item, allowed)).slice(0, contract.max_export_text_length).join('');
    }
    if (Array.isArray(item)) return item.map(child => walk(child, field, fieldPath));
    if (item && typeof item === 'object') {
      const countMap = countMapPaths.some(path => path.length <= fieldPath.length
        && path.every((part, index) => part === fieldPath[fieldPath.length - path.length + index]));
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
        countMap && typeof child === 'number' && Number.isSafeInteger(child) && child >= 0
          ? child : walk(child, key, [...fieldPath, key])]),
      );
    }
    return item;
  }
  collect(value);
  return walk(value) as T;
}
