import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../security/auth-service.js';
import type { CoordinationService } from '../coordination/service.js';
import type { GrantService } from './service.js';
import type { GrantPushService } from './push.js';
import { grantAgentSchema, grantDefinitionSchema } from './schema.js';
import type { AgentSessionLaunches } from './session-launches.js';

export async function dispatchGrants(coordination: CoordinationService, grants: GrantService, raw: unknown, launches?: AgentSessionLaunches) {
  const input = grantAgentSchema.parse(raw);
  coordination.authenticate(input.assignmentId, input.token);
  grants.bindAssignment(input.assignmentId, input.consoleSessionId);
  switch (input.action) {
    case 'list': return grants.listFor(input.assignmentId);
    case 'record':
      if (!input.definition || !input.humanMessageId) throw new Error('definition and humanMessageId are required.');
      return { grant: await grants.record(input.assignmentId, input.definition, input.humanMessageId) };
    case 'request':
      if (!input.definition || !input.reason) throw new Error('definition and reason are required.');
      return { grant: grants.request(input.assignmentId, input.definition, input.reason) };
    case 'launch':
      if (!launches) throw new Error('Session launches are unavailable.');
      return launches.request(input.assignmentId, 'launch_session', input);
    case 'restart':
      if (!launches) throw new Error('Session launches are unavailable.');
      return launches.request(input.assignmentId, 'restart_session', input);
    case 'close':
      if (!launches) throw new Error('Session controls are unavailable.');
      return launches.request(input.assignmentId, 'close_session', input);
    case 'cancel':
      if (!launches || !input.requestId) throw new Error('requestId and session controls are required.');
      return launches.cancel(input.requestId, input.assignmentId);
    case 'launch_status':
      if (!launches) throw new Error('Session launches are unavailable.');
      return launches.status(input.assignmentId, input.requestId);
  }
}

export function registerGrantRoutes(app: FastifyInstance, auth: AuthService, grants: GrantService, push: GrantPushService, launches: AgentSessionLaunches): void {
  app.get('/api/grants', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const query = z.object({ useOffset: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    return grants.snapshot(query.useOffset);
  });
  app.post('/api/grants/:grantId/decision', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approve', 'deny']), definition: grantDefinitionSchema.optional() }).strict().parse(request.body);
    try { return { grant: grants.decide(grantId, body.decision, body.definition) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'Grant decision failed.' }); }
  });
  app.post('/api/grants/:grantId/revoke', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(request.params);
    try { return { grant: grants.revoke(grantId) }; }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'Grant not found.' }); }
  });
  app.get('/api/grants/session-requests', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    return launches.snapshot();
  });
  app.post('/api/grants/session-requests/:requestId/cancel', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    try { return launches.cancel(requestId); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session request.' }); }
  });
  app.get('/api/grants/push-key', async (request, reply) => { await auth.ensureAuthenticated(request, reply); return { publicKey: push.publicKey() }; });
  app.post('/api/grants/push-subscriptions', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const subscription = z.object({ endpoint: z.url().refine(value => value.startsWith('https://')), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }), expirationTime: z.number().nullable().optional() }).parse(request.body);
    push.subscribe(subscription); return { subscribed: true };
  });
  app.delete('/api/grants/push-subscriptions', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply); const body = z.object({ endpoint: z.url() }).parse(request.body);
    push.unsubscribe(body.endpoint); return { subscribed: false };
  });
}
