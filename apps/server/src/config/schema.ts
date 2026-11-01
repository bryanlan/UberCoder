import { z } from 'zod';
import type { SessionTransport } from '@agent-console/shared';

// Runtime values must not come from '@agent-console/shared' here: the engineering summary CLI loads this
// module through tsx, whose tsconfig path maps that package to its type declarations, so a value import
// arrives undefined. The tuple mirrors SESSION_TRANSPORTS in packages/shared and is type-checked against it.
const SESSION_TRANSPORT_VALUES = ['tmux', 'structured'] as const satisfies readonly SessionTransport[];

const portSchema = z.number().int().min(1).max(65535);

const providerCommandsSchema = z.object({
  newCommand: z.array(z.string()).min(1),
  resumeCommand: z.array(z.string()).min(1),
  continueCommand: z.array(z.string()).min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
});

const providerSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  discoveryRoot: z.string().optional(),
  commands: providerCommandsSchema,
});

const providerOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  discoveryRoot: z.string().optional(),
  commands: z.object({
    newCommand: z.array(z.string()).min(1).optional(),
    resumeCommand: z.array(z.string()).min(1).optional(),
    continueCommand: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).partial().optional(),
}).partial();

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

const sessionsConfigSchema = z.object({
  eagerRestoreHours: z.number().positive().default(1),
  restoreGraceHours: z.number().positive().default(1),
  pressureSuspendAvailableMiB: z.number().positive().default(3072),
  pressureSuspendIdleMinutes: z.number().positive().default(60),
}).default({
  eagerRestoreHours: 1,
  restoreGraceHours: 1,
  pressureSuspendAvailableMiB: 3072,
  pressureSuspendIdleMinutes: 60,
});

// Structured (protocol-driven, non-tmux) sessions per provider. Off unless a provider is enabled explicitly.
function structuredProviderSchema(defaultCommand: readonly string[]) {
  return z.object({
    enabled: z.boolean().default(false),
    // The provider executable and any leading arguments; a fresh array per parse so a config never shares the default.
    command: z.array(z.string()).min(1).default(() => [...defaultCommand]),
    idleUnloadMinutes: z.number().positive().default(60),
    // Extra environment for the provider process, applied over the Console's own coordination variables.
    env: z.record(z.string(), z.string()).default({}),
  });
}

const STRUCTURED_PROVIDER_DEFAULT_COMMANDS = { codex: ['codex', 'app-server'], claude: ['claude'] } as const;
const codexStructuredSchema = structuredProviderSchema(STRUCTURED_PROVIDER_DEFAULT_COMMANDS.codex);
const claudeStructuredSchema = structuredProviderSchema(STRUCTURED_PROVIDER_DEFAULT_COMMANDS.claude);

/** One provider's structured-session settings. The host service and the provider's transport plugin both take this shape. */
export type StructuredProviderConfig = z.output<typeof codexStructuredSchema>;
/** What a provider without a `structuredSessions` entry gets: the lane is off. A fresh object per call. */
export function defaultStructuredProviderConfig(provider: keyof typeof STRUCTURED_PROVIDER_DEFAULT_COMMANDS): StructuredProviderConfig {
  return (provider === 'claude' ? claudeStructuredSchema : codexStructuredSchema).parse({});
}

const structuredSessionsConfigSchema = z.object({
  // The transport a new conversation gets when the request does not name one (new chats, binds, granted launches), and
  // the transport the backend moves existing tmux conversations to. Only effective for a provider whose lane is enabled.
  defaultTransport: z.enum(SESSION_TRANSPORT_VALUES).default('tmux'),
  codex: codexStructuredSchema.default(() => defaultStructuredProviderConfig('codex')),
  claude: claudeStructuredSchema.default(() => defaultStructuredProviderConfig('claude')),
}).default(() => ({
  defaultTransport: 'tmux' as const,
  codex: defaultStructuredProviderConfig('codex'),
  claude: defaultStructuredProviderConfig('claude'),
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
  modelRouting: z.object({
    woPath: z.string().min(1).default('/home/bryan/code/workflow_optimizer/.venv/bin/wo'),
    profilesTimeoutMs: z.number().int().positive().default(10_000),
    routeTimeoutMs: z.number().int().positive().default(8_000),
  }).default({ woPath: '/home/bryan/code/workflow_optimizer/.venv/bin/wo', profilesTimeoutMs: 10_000, routeTimeoutMs: 8_000 }),
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
    codex: providerSettingsSchema.default({
      enabled: true,
      discoveryRoot: '~/.codex',
      commands: {
        newCommand: ['codex', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
        resumeCommand: ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--no-alt-screen', '{{conversationId}}'],
        continueCommand: ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--no-alt-screen', '--last'],
        env: {},
      },
    }),
    claude: providerSettingsSchema.default({
      enabled: true,
      discoveryRoot: '~/.claude',
      commands: {
        newCommand: ['claude', '--dangerously-skip-permissions', '--effort', 'medium'],
        resumeCommand: ['claude', '--dangerously-skip-permissions', '--resume', '{{conversationId}}', '--effort', 'medium'],
        continueCommand: ['claude', '--dangerously-skip-permissions', '--continue', '--effort', 'medium'],
        env: {},
      },
    }),
  }),
  projects: z.record(z.string(), projectConfigSchema).default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ProviderOverride = z.infer<typeof providerOverrideSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
