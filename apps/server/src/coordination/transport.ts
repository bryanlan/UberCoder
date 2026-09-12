import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../security/auth-service.js';
import { CoordinationService } from './service.js';

const text = z.string().trim().min(1);
const paths = z.array(text.max(2048)).min(1).max(100);
const inputSchema = z.object({
  action: z.enum(['register', 'poll', 'status', 'update', 'claim', 'check', 'release', 'handoff', 'send', 'ack', 'finish', 'disconnect', 'preview', 'review', 'adopt', 'commit', 'recover-git', 'maintenance-enter', 'maintenance-exit']),
  assignmentId: z.string().uuid().optional(), token: z.string().min(32).max(256).optional(),
  provider: z.enum(['codex', 'claude', 'maintenance']).optional(), nativeSessionId: text.max(160).optional(),
  pid: z.number().int().positive().optional(), cwd: text.max(4096).optional(), checkout: text.max(4096).optional(),
  description: text.max(500).optional(), summary: text.max(2000).optional(),
  status: z.enum(['active', 'waiting']).optional(), after: z.number().int().nonnegative().default(0),
  paths: paths.optional(), recipientId: z.string().uuid().optional(), messageId: z.string().uuid().optional(),
  text: text.max(2000).optional(), messageIds: z.array(z.string().uuid()).max(100).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), message: text.max(2000).optional(),
}).strict();

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required.`);
  return value;
}

export async function dispatchCoordination(service: CoordinationService, raw: unknown) {
  const input = inputSchema.parse(raw);
  const need = <T>(value: T | undefined, name: string) => required(value, name);
  if (input.action === 'register') return service.register({ provider: need(input.provider, 'provider'), nativeSessionId: need(input.nativeSessionId, 'nativeSessionId'), token: need(input.token, 'token'), pid: need(input.pid, 'pid'), cwd: need(input.cwd, 'cwd') });
  const id = need(input.assignmentId, 'assignmentId');
  service.authenticate(id, need(input.token, 'token'));
  switch (input.action) {
    case 'status': return service.snapshot(input.checkout);
    case 'poll': return service.poll(id, input.after);
    case 'update': {
      service.update(id, input);
      return { ...service.poll(id, input.after, false), activity: service.snapshot(input.checkout) };
    }
    case 'claim': return service.claim(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'));
    case 'check': return service.check(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'));
    case 'review': return service.review(need(input.checkout, 'checkout'), need(input.paths, 'paths'));
    case 'adopt': return service.adopt(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'), need(input.fingerprint, 'fingerprint'), need(input.summary, 'summary'));
    case 'maintenance-enter': return service.maintenanceEnter(id, need(input.checkout, 'checkout'));
    case 'maintenance-exit': return service.maintenanceExit(id, need(input.checkout, 'checkout'));
    case 'recover-git': return service.recoverGit(id, need(input.checkout, 'checkout'), need(input.fingerprint, 'fingerprint'), need(input.summary, 'summary'));
    case 'release': return service.release(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'));
    case 'handoff': return service.handoff(id, need(input.recipientId, 'recipientId'), need(input.checkout, 'checkout'), need(input.paths, 'paths'), need(input.fingerprint, 'fingerprint'));
    case 'send': return service.send(id, { id: need(input.messageId, 'messageId'), recipientId: need(input.recipientId, 'recipientId'), text: need(input.text, 'text') });
    case 'ack': return service.acknowledge(id, need(input.messageIds, 'messageIds'));
    case 'finish': return service.finish(id, need(input.summary, 'summary'));
    case 'disconnect': return service.disconnect(id);
    case 'preview': return service.preview(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'));
    case 'commit': return service.commit(id, need(input.checkout, 'checkout'), need(input.paths, 'paths'), need(input.fingerprint, 'fingerprint'), need(input.message, 'message'));
  }
}

export async function startCoordinationSocket(service: CoordinationService, runtimeDir: string) {
  const directory = path.join(runtimeDir, 'coordination');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Coordination runtime directory must not be a symlink.');
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'agent.sock');
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) throw new Error('Coordination socket path exists and is not a socket.');
    const live = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        // Only ECONNREFUSED proves a stale socket. Other errors must not steal it.
        resolve(error.code !== 'ECONNREFUSED');
      });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    });
    if (live) throw new Error('Another coordination server owns this runtime directory.');
    await fs.unlink(socketPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const ipc = fastify({ logger: false, bodyLimit: 32 * 1024 });
  ipc.post('/rpc', async (request, reply) => {
    try { return await dispatchCoordination(service, request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Coordination request failed.' }); }
  });
  await ipc.listen({ path: socketPath });
  await fs.chmod(socketPath, 0o600);
  return ipc;
}

export async function registerCoordinationRoutes(app: FastifyInstance, auth: AuthService, service: CoordinationService) {
  app.get('/api/coordination', async (request, reply) => {
    await auth.ensureAuthenticated(request, reply);
    const input = z.object({ checkout: text.max(4096).optional() }).parse(request.query);
    try { return service.snapshot(input.checkout); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Cannot load coordination.' }); }
  });
}
