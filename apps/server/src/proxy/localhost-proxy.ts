import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ProjectService } from '../projects/project-service.js';

export interface ParsedProxyRequest {
  projectSlug: string;
  port: number;
  proxiedPath: string;
}

export function parseProxyPath(url: string | undefined): ParsedProxyRequest | undefined {
  if (!url) return undefined;
  const match = url.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)?$/);
  if (!match) return undefined;
  const [, encodedProjectSlug, portValue, proxiedPath] = match;
  if (!encodedProjectSlug || !portValue) return undefined;
  const port = Number(portValue);
  if (!Number.isInteger(port)) return undefined;

  let projectSlug: string;
  try {
    projectSlug = decodeURIComponent(encodedProjectSlug);
  } catch {
    return undefined;
  }

  return {
    projectSlug,
    port,
    proxiedPath: proxiedPath ?? '/',
  };
}

export function assertPortAllowed(allowedPorts: number[], port: number): void {
  if (!allowedPorts.includes(port)) {
    throw new Error(`Port ${port} is not allowlisted for this project.`);
  }
}

export class LocalhostProxyService {
  private readonly proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    xfwd: true,
    ignorePath: false,
  });

  constructor(
    private readonly projectService: ProjectService,
    private readonly authService: AuthService,
  ) {}

  register(app: FastifyInstance): void {
    const handleProxyRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await this.authService.ensureAuthenticated(request, reply, false);
      const parsed = parseProxyPath(request.raw.url);
      if (!parsed) {
        reply.code(404).send({ error: 'Unknown proxy path.' });
        return;
      }
      const project = await this.projectService.getProjectBySlug(parsed.projectSlug);
      if (!project) {
        reply.code(404).send({ error: 'Unknown project.' });
        return;
      }
      try {
        assertPortAllowed(project.allowedLocalhostPorts, parsed.port);
      } catch (error) {
        reply.code(403).send({ error: (error as Error).message });
        return;
      }
      request.raw.url = parsed.proxiedPath;
      reply.hijack();
      this.proxy.web(request.raw, reply.raw, {
        target: `http://127.0.0.1:${parsed.port}`,
      });
    };

    this.proxy.on('error', (_error, _req, res) => {
      if (res && 'writeHead' in res) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy target unavailable.' }));
      }
    });

    app.all('/proxy/:projectSlug/:port', handleProxyRequest);
    app.all('/proxy/:projectSlug/:port/', handleProxyRequest);
    app.all('/proxy/:projectSlug/:port/*', handleProxyRequest);

    app.server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const parsed = parseProxyPath(req.url);
      if (!parsed) return;
      const authenticated = this.authService.authenticateRawHeaders(
        req.headers as Record<string, string | string[] | undefined>,
        req.socket.remoteAddress,
      );
      if (!authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const project = await this.projectService.getProjectBySlug(parsed.projectSlug);
      if (!project) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        assertPortAllowed(project.allowedLocalhostPorts, parsed.port);
      } catch {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      req.url = parsed.proxiedPath;
      this.proxy.ws(req, socket, head, {
        target: `ws://127.0.0.1:${parsed.port}`,
      });
    });
  }
}
