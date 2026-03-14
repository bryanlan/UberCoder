import { z } from 'zod';

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

export const appConfigSchema = z.object({
  server: serverConfigSchema,
  projectsRoot: z.string(),
  runtimeDir: z.string().default('~/.local/share/agent-console/runtime'),
  databasePath: z.string().default('~/.local/share/agent-console/agent-console.sqlite'),
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
