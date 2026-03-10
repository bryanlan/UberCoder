import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ConfigService } from '../config/service.js';
import { ProjectService } from '../projects/project-service.js';
import { RestartService } from '../runtime/restart-service.js';
import { getAgentConsolePath } from '../lib/agent-console-path.js';
import { normalizeFsPath } from '../lib/path-utils.js';

const paramsSchema = z.object({
  directoryName: z.string().min(1).refine((value) => !value.includes('/') && !value.includes('\\'), 'Invalid project directory name.'),
});

const updateProjectSettingsBodySchema = z.object({
  active: z.boolean(),
  displayName: z.string().trim().max(120).optional(),
  allowedLocalhostPorts: z.array(z.number().int().min(1).max(65535)).max(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  notes: z.string().trim().max(1000).optional(),
});

const updateGlobalSettingsBodySchema = z.object({
  projectsRoot: z.string().trim().min(1),
  serverHost: z.string().trim().min(1),
  serverPort: z.number().int().min(1).max(65535),
  sessionTtlHours: z.number().positive().max(24 * 365),
  cookieSecure: z.boolean(),
  trustTailscaleHeaders: z.boolean(),
});

const browseDirectoriesQuerySchema = z.object({
  path: z.string().optional(),
});

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  authService: AuthService,
  configService: ConfigService,
  projectService: ProjectService,
  restartService: RestartService,
): Promise<void> {
  const agentConsolePath = getAgentConsolePath(import.meta.url);

  app.get('/api/settings/directories', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }

    const parsedQuery = browseDirectoriesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      reply.code(400).send({ error: 'Invalid directory query.', details: parsedQuery.error.flatten() });
      return;
    }

    const requestedPath = normalizeFsPath(parsedQuery.data.path ?? configService.getStoredConfig().projectsRoot ?? os.homedir());
    let stats;
    try {
      stats = await fs.stat(requestedPath);
    } catch {
      reply.code(404).send({ error: 'Directory not found.' });
      return;
    }
    if (!stats.isDirectory()) {
      reply.code(400).send({ error: 'Requested path is not a directory.' });
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(requestedPath, { withFileTypes: true });
    } catch {
      reply.code(403).send({ error: 'Unable to read that directory.' });
      return;
    }

    const directories = (await Promise.all(entries.map(async (entry) => {
      const childPath = path.join(requestedPath, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, path: childPath, isSymlink: false };
      }
      if (!entry.isSymbolicLink()) return null;
      try {
        const childStats = await fs.stat(childPath);
        if (!childStats.isDirectory()) return null;
        return { name: entry.name, path: childPath, isSymlink: true };
      } catch {
        return null;
      }
    }))).filter((entry): entry is { name: string; path: string; isSymlink: boolean } => Boolean(entry))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = path.dirname(requestedPath);
    return {
      currentPath: requestedPath,
      parentPath: parentPath === requestedPath ? undefined : parentPath,
      homePath: os.homedir(),
      rootPath: path.parse(requestedPath).root || '/',
      directories,
    };
  });

  app.get('/api/settings', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const config = configService.getStoredConfig();
    return {
      configPath: configService.getConfigPath(),
      agentConsolePath,
      projectsRoot: config.projectsRoot,
      serverHost: config.server.host,
      serverPort: config.server.port,
      security: {
        trustTailscaleHeaders: config.security.trustTailscaleHeaders,
        cookieSecure: config.security.cookieSecure,
        sessionTtlHours: config.security.sessionTtlHours,
      },
      projects: await projectService.listProjectSettings(),
    };
  });

  app.put('/api/settings/global', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }

    const parsedBody = updateGlobalSettingsBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid global settings.', details: parsedBody.error.flatten() });
      return;
    }

    const updated = configService.updateGlobalSettings(parsedBody.data);
    return {
      settings: {
        configPath: configService.getConfigPath(),
        agentConsolePath,
        projectsRoot: updated.projectsRoot,
        serverHost: updated.server.host,
        serverPort: updated.server.port,
        security: {
          trustTailscaleHeaders: updated.security.trustTailscaleHeaders,
          cookieSecure: updated.security.cookieSecure,
          sessionTtlHours: updated.security.sessionTtlHours,
        },
        projects: await projectService.listProjectSettings(),
      },
      restartRequired: true,
    };
  });

  app.put('/api/settings/projects/:directoryName', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      reply.code(400).send({ error: 'Invalid project directory.', details: parsedParams.error.flatten() });
      return;
    }

    const parsedBody = updateProjectSettingsBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid project settings.', details: parsedBody.error.flatten() });
      return;
    }

    const existing = (await projectService.listProjectSettings()).find((project) => project.directoryName === parsedParams.data.directoryName);
    if (!existing) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }

    const dedupedPorts = [...new Set(parsedBody.data.allowedLocalhostPorts)].sort((a, b) => a - b);
    const dedupedTags = [...new Set(parsedBody.data.tags.map((tag) => tag.trim()).filter(Boolean))];
    const updated = configService.updateProjectConfig(parsedParams.data.directoryName, {
      active: parsedBody.data.active,
      displayName: normalizeOptionalText(parsedBody.data.displayName),
      allowedLocalhostPorts: dedupedPorts,
      tags: dedupedTags,
      notes: normalizeOptionalText(parsedBody.data.notes),
    });

    return {
      project: {
        directoryName: parsedParams.data.directoryName,
        path: existing.path,
        exists: existing.exists,
        active: updated.active,
        displayName: updated.displayName,
        allowedLocalhostPorts: [...updated.allowedLocalhostPorts].sort((a, b) => a - b),
        tags: [...updated.tags],
        notes: updated.notes,
      },
    };
  });

  app.post('/api/settings/restart', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    restartService.scheduleRestart();
    reply.code(202).send({ restarting: true });
  });
}
