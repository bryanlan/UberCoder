export function shellEscape(value: string): string {
  if (value === '') return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderTemplateTokens(tokens: string[], context: Record<string, string | undefined>): string[] {
  return tokens.map((token) => token.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const resolved = context[key];
    if (resolved === undefined) {
      throw new Error(`Missing template token: ${key}`);
    }
    return resolved;
  }));
}

export function commandToShell(argv: string[], env: Record<string, string>): string {
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellEscape(value)}`).join('; ');
  const command = argv.map(shellEscape).join(' ');
  return ['unset CLAUDECODE', exports, `exec ${command}`].filter(Boolean).join('; ');
}
