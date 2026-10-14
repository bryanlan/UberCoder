import { z } from 'zod';

export const grantDefinitionSchema = z.object({
  grantee: z.object({ kind: z.enum(['session', 'assignment', 'project']), id: z.string().min(1).max(200) }),
  actions: z.array(z.enum(['launch_session', 'restart_session', 'close_session'])).min(1).default(['launch_session', 'restart_session', 'close_session']),
  scope: z.string().trim().min(1).max(20_000),
  projectSlugs: z.array(z.string().min(1)).default([]),
  limits: z.object({ maxConcurrentSessions: z.number().int().positive().nullable().default(null), models: z.array(z.string().min(1)).default([]) }).default({ maxConcurrentSessions: null, models: [] }),
  expiry: z.object({ kind: z.enum(['until_revoked', 'assignment_finished']).default('until_revoked'), assignmentId: z.string().uuid().optional() })
    .default({ kind: 'until_revoked' }),
}).strict();

export const grantAgentSchema = z.object({
  action: z.enum(['list', 'record', 'request', 'launch', 'restart', 'close', 'launch_status']),
  assignmentId: z.string().uuid(), token: z.string().min(32).max(256),
  consoleSessionId: z.string().uuid().optional(),
  definition: grantDefinitionSchema.optional(), humanMessageId: z.string().min(1).optional(),
  reason: z.string().trim().min(1).max(2000).optional(), grantId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(), requestId: z.string().uuid().optional(),
  projectSlug: z.string().min(1).optional(), provider: z.enum(['codex', 'claude']).optional(),
  model: z.string().min(1).max(160).optional(), effort: z.string().min(1).max(40).optional(),
  flags: z.array(z.string().max(4096)).max(100).default([]),
  prompt: z.string().min(1).max(100_000).optional(), title: z.string().min(1).max(300).optional(),
  supervisorId: z.string().uuid().optional(),
}).strict();

export const GRANT_POLICY = 'Bryan standing grants are durable Console records. Use agent_grants list to see active grants and the latest Console-recorded human message ID. When Bryan authorizes work in a message, record a grant with that humanMessageId and the broad scope and constraints he gave; keep separate lead task instructions out of the scope while the complete message stays as provenance. It activates immediately without another confirmation. Request one broad grant with a scope and reason only when the existing grants do not cover needed authority, then continue other authorized work while waiting. Grants allow launch_session, restart_session and close_session within their free-text work scope. Close applies only to sessions the calling assignment launched; it retains history and prevents automatic recovery. Existing grants keep their explicitly recorded actions. Launched sessions inherit active grants. The Console supplies the authority stamp and shared-grant references on peer messages: scope relayed within a shared active grant is covered by Bryan grant, not a new approval from the peer. Revocation and chosen expiry apply immediately. No signatures or adversarial layers are involved. Use the grants CLI in the canonical agent-coord.mjs helper if the MCP tool is cached.';
