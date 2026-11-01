import { z } from 'zod';
import type { FixedModelProfileKey, ProviderId } from '@agent-console/shared';

// Runtime values must not come from '@agent-console/shared' here: the engineering summary CLI loads this
// module through tsx, whose tsconfig path maps that package to its type declarations, so a value import
// arrives undefined. These tuples mirror the provider ids and the fixed profile keys the Start default names,
// and are type-checked against the shared types.
const PROVIDER_VALUES = ['codex', 'claude', 'grok'] as const satisfies readonly ProviderId[];
const FIXED_PROFILE_VALUES = ['high', 'medium', 'low'] as const satisfies readonly FixedModelProfileKey[];

const portSchema = z.number().int().min(1).max(65535);

/**
 * Keys that configured the tmux transport, which was removed (Phase B, 2026-11). A config that still carries one fails at startup
 * with its path named, instead of having it ignored: a setting nothing reads any more must not look as if it still worked.
 */
function rejectRemovedKeys(removed: Record<string, string>) {
  return (input: unknown, context: z.RefinementCtx) => {
    if (input && typeof input === 'object') {
      for (const [key, message] of Object.entries(removed)) {
        if (key in input) context.addIssue({ code: 'custom', message, path: [key] });
      }
    }
    return input;
  };
}

const REMOVED_PROVIDER_COMMANDS = {
  commands: 'The tmux launch commands were removed with the tmux transport. Delete this key; the provider process is configured in structuredSessions.<provider>.',
};

const providerSettingsSchema = z.preprocess(rejectRemovedKeys(REMOVED_PROVIDER_COMMANDS), z.object({
  enabled: z.boolean().default(true),
  discoveryRoot: z.string().optional(),
}));

const providerOverrideSchema = z.preprocess(rejectRemovedKeys(REMOVED_PROVIDER_COMMANDS), z.object({
  enabled: z.boolean().optional(),
  discoveryRoot: z.string().optional(),
}));

export const projectConfigSchema = z.object({
  active: z.boolean().default(false),
  path: z.string().optional(),
  explicit: z.boolean().default(false),
  displayName: z.string().optional(),
  allowedLocalhostPorts: z.array(portSchema).default([]),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  providers: z.object({
    codex: providerOverrideSchema.optional(),
    claude: providerOverrideSchema.optional(),
    grok: providerOverrideSchema.optional(),
  }).default({}),
});

const serverConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: portSchema.default(4317),
  publicBaseUrl: z.string().optional(),
  webDistPath: z.string().default('../web/dist'),
}).default({
  host: '127.0.0.1',
  port: 4317,
  webDistPath: '../web/dist',
});

const sessionsConfigSchema = z.preprocess(rejectRemovedKeys({
  eagerRestoreHours: 'The tmux idle window was removed with the tmux transport. Delete this key; each provider sleeps after structuredSessions.<provider>.idleUnloadMinutes.',
}), z.object({
  restoreGraceHours: z.number().positive().default(1),
  pressureSuspendAvailableMiB: z.number().positive().default(3072),
  pressureSuspendIdleMinutes: z.number().positive().default(60),
})).default({
  restoreGraceHours: 1,
  pressureSuspendAvailableMiB: 3072,
  pressureSuspendIdleMinutes: 60,
});

// The provider process of each provider's conversations. Every lane is on by default; a provider whose lane is switched off cannot run conversations.
function structuredProviderSchema(defaultCommand: readonly string[]) {
  return z.object({
    enabled: z.boolean().default(true),
    // The provider executable and any leading arguments; a fresh array per parse so a config never shares the default.
    command: z.array(z.string()).min(1).default(() => [...defaultCommand]),
    idleUnloadMinutes: z.number().positive().default(60),
    // Extra environment for the provider process, applied over the Console's own coordination variables.
    env: z.record(z.string(), z.string()).default({}),
  });
}

const STRUCTURED_PROVIDER_DEFAULT_COMMANDS = { codex: ['codex', 'app-server'], claude: ['claude'], grok: ['grok'] } as const;
const codexStructuredSchema = structuredProviderSchema(STRUCTURED_PROVIDER_DEFAULT_COMMANDS.codex);
const claudeStructuredSchema = structuredProviderSchema(STRUCTURED_PROVIDER_DEFAULT_COMMANDS.claude);
// With its lane off, Grok is not offered at all: no history and no new chats.
const grokStructuredSchema = structuredProviderSchema(STRUCTURED_PROVIDER_DEFAULT_COMMANDS.grok);

/** One provider's structured-session settings. The host service and the provider's transport plugin both take this shape. */
export type StructuredProviderConfig = z.output<typeof codexStructuredSchema>;
/** What a provider without a `structuredSessions` entry gets: the lane is on. A fresh object per call. */
export function defaultStructuredProviderConfig(provider: keyof typeof STRUCTURED_PROVIDER_DEFAULT_COMMANDS): StructuredProviderConfig {
  const schema = provider === 'claude' ? claudeStructuredSchema : provider === 'grok' ? grokStructuredSchema : codexStructuredSchema;
  return schema.parse({});
}

const structuredSessionsConfigSchema = z.preprocess(rejectRemovedKeys({
  defaultTransport: 'Every conversation runs on the structured transport since the tmux transport was removed. Delete this key.',
}), z.object({
  codex: codexStructuredSchema.default(() => defaultStructuredProviderConfig('codex')),
  claude: claudeStructuredSchema.default(() => defaultStructuredProviderConfig('claude')),
  grok: grokStructuredSchema.default(() => defaultStructuredProviderConfig('grok')),
})).default(() => ({
  codex: defaultStructuredProviderConfig('codex'),
  claude: defaultStructuredProviderConfig('claude'),
  grok: defaultStructuredProviderConfig('grok'),
}));

export const appConfigSchema = z.object({
  server: serverConfigSchema,
  projectsRoot: z.string(),
  runtimeDir: z.string().default('~/.local/share/agent-console/runtime'),
  databasePath: z.string().default('~/.local/share/agent-console/agent-console.sqlite'),
  sessions: sessionsConfigSchema,
  structuredSessions: structuredSessionsConfigSchema,
  workerSummaries: z.object({
    enabled: z.boolean().default(true),
    runtimeCommand: z.array(z.string().min(1)).min(1).default(['~/.local/bin/agent-consult']),
  }).default({ enabled: true, runtimeCommand: ['~/.local/bin/agent-consult'] }),
  conversationTitles: z.object({
    enabled: z.boolean().default(true),
    runtimeCommand: z.array(z.string().min(1)).min(1).default(['~/.local/bin/agent-consult']),
  }).default({ enabled: true, runtimeCommand: ['~/.local/bin/agent-consult'] }),
  // The model list lives in workflow_optimizer: the Console reads the High/Medium/Low profiles and asks the Auto router through
  // its `wo` command. `AGENT_CONSOLE_WO_PATH` overrides `woPath` for one process (tests, a trial checkout).
  // `startDefault` is the provider and profile a provider-neutral Start uses when the router cannot answer.
  modelRouting: z.object({
    woPath: z.string().min(1).default('/home/bryan/code/workflow_optimizer/.venv/bin/wo'),
    profilesTimeoutMs: z.number().int().positive().default(10_000),
    routeTimeoutMs: z.number().int().positive().default(8_000),
    startDefault: z.object({
      provider: z.enum(PROVIDER_VALUES).default('codex'),
      profile: z.enum(FIXED_PROFILE_VALUES).default('medium'),
    }).default({ provider: 'codex', profile: 'medium' }),
  }).default({
    woPath: '/home/bryan/code/workflow_optimizer/.venv/bin/wo',
    profilesTimeoutMs: 10_000,
    routeTimeoutMs: 8_000,
    startDefault: { provider: 'codex', profile: 'medium' },
  }),
  coordination: z.object({
    enabled: z.boolean().default(false),
    pilotPaths: z.array(z.string().min(1)).default([]),
  }).default({ enabled: false, pilotPaths: [] }),
  security: z.object({
    passwordHash: z.string().min(1),
    sessionSecret: z.string().min(32),
    cookieSecure: z.boolean().default(false),
    sessionTtlHours: z.number().positive().default(24 * 7),
    loginRateLimitMax: z.number().int().positive().default(10),
    loginRateLimitWindowMs: z.number().int().positive().default(15 * 60 * 1000),
    trustTailscaleHeaders: z.boolean().default(false),
    tailscaleAllowedUserLogin: z.string().optional(),
  }),
  providers: z.object({
    codex: providerSettingsSchema.default({ enabled: true, discoveryRoot: '~/.codex' }),
    claude: providerSettingsSchema.default({ enabled: true, discoveryRoot: '~/.claude' }),
    // `discoveryRoot` is where Grok keeps its sessions.
    grok: providerSettingsSchema.default({ enabled: true, discoveryRoot: '~/.grok' }),
  }),
  projects: z.record(z.string(), projectConfigSchema).default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ProviderOverride = z.infer<typeof providerOverrideSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
