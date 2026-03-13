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
  const effectiveEnv: Record<string, string> = {
    FORCE_COLOR: env.FORCE_COLOR ?? '1',
    CLICOLOR_FORCE: env.CLICOLOR_FORCE ?? '1',
    ...env,
  };
  delete effectiveEnv.NO_COLOR;

  const exports = Object.entries(effectiveEnv).map(([key, value]) => `export ${key}=${shellEscape(value)}`).join('; ');
  const command = argv.map(shellEscape).join(' ');
  return ['unset CLAUDECODE NO_COLOR', exports, `exec ${command}`].filter(Boolean).join('; ');
}
