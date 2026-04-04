import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ConfigService } from '../config/service.js';
import { IndexingService } from '../indexing/indexing-service.js';
import { AppDatabase } from '../db/database.js';
import { ProjectService } from '../projects/project-service.js';
import { RestartService } from '../runtime/restart-service.js';
import { getAgentConsolePath } from '../lib/agent-console-path.js';
import { normalizeFsPath } from '../lib/path-utils.js';
import type { UiPreferences } from '@agent-console/shared';

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

const createProjectBodySchema = z.object({
  path: z.string().trim().min(1),
});

const createDirectoryBodySchema = z.object({
  parentPath: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120)
    .refine((value) => value !== '.' && value !== '..', 'Invalid directory name.')
    .refine((value) => !value.includes('/') && !value.includes('\\'), 'Directory name must not include path separators.'),
});

const updateGlobalSettingsBodySchema = z.object({
  projectsRoot: z.string().trim().min(1),
  serverHost: z.string().trim().min(1),
  serverPort: z.number().int().min(1).max(65535),
  sessionTtlHours: z.number().positive().max(24 * 365),
  cookieSecure: z.boolean(),
  trustTailscaleHeaders: z.boolean(),
});

const updateUiPreferencesBodySchema = z.object({
  recentActivitySortEnabled: z.boolean().optional(),
  manualProjectOrder: z.array(z.string().trim().min(1)).optional(),
  sessionFreshnessThresholds: z.object({
    yellowMinutes: z.number().int().min(1).max(24 * 60),
    orangeMinutes: z.number().int().min(1).max(24 * 60),
    redMinutes: z.number().int().min(1).max(24 * 60),
  }).refine((value) => value.yellowMinutes < value.orangeMinutes && value.orangeMinutes < value.redMinutes, {
    message: 'Freshness thresholds must increase from yellow to orange to red.',
  }).optional(),
}).refine((value) => (
  value.recentActivitySortEnabled !== undefined
  || value.manualProjectOrder !== undefined
  || value.sessionFreshnessThresholds !== undefined
), {
  message: 'Expected at least one UI preference field.',
});

const browseDirectoriesQuerySchema = z.object({
  path: z.string().optional(),
});

const SIDEBAR_UI_PREFERENCES_KEY = 'sidebar';
const DEFAULT_SESSION_FRESHNESS_THRESHOLDS = {
  yellowMinutes: 3,
  orangeMinutes: 7,
  redMinutes: 20,
} as const;

function isTailscaleIpv4Address(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }
  const firstOctet = octets[0] ?? -1;
  const secondOctet = octets[1] ?? -1;
  return firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127;
}

function getPrimaryTailscaleIpv4(): string | undefined {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      if (isTailscaleIpv4Address(entry.address)) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeUiPreferences(input: Partial<UiPreferences> | undefined, availableProjectSlugs: string[]): UiPreferences {
  const dedupedOrder: string[] = [];
  const seen = new Set<string>();

  for (const slug of input?.manualProjectOrder ?? []) {
    if (!availableProjectSlugs.includes(slug) || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    dedupedOrder.push(slug);
  }

  for (const slug of availableProjectSlugs) {
    if (!seen.has(slug)) {
      dedupedOrder.push(slug);
    }
  }

  return {
    recentActivitySortEnabled: input?.recentActivitySortEnabled ?? true,
    manualProjectOrder: dedupedOrder,
    sessionFreshnessThresholds: (() => {
      const thresholds = input?.sessionFreshnessThresholds;
      if (
        thresholds
        && thresholds.yellowMinutes > 0
        && thresholds.yellowMinutes < thresholds.orangeMinutes
        && thresholds.orangeMinutes < thresholds.redMinutes
      ) {
        return thresholds;
      }
      return DEFAULT_SESSION_FRESHNESS_THRESHOLDS;
    })(),
  };
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  authService: AuthService,
  configService: ConfigService,
  db: AppDatabase,
  indexing: IndexingService,
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

  app.post('/api/settings/directories', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }

    const parsedBody = createDirectoryBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid directory request.', details: parsedBody.error.flatten() });
      return;
    }

    const projectsRoot = normalizeFsPath(configService.getStoredConfig().projectsRoot ?? os.homedir());
    const parentPath = normalizeFsPath(parsedBody.data.parentPath);
    if (!isPathInsideRoot(projectsRoot, parentPath)) {
      reply.code(400).send({ error: 'New folders must be created inside the current projects root.' });
      return;
    }

    try {
      const parentStats = await fs.stat(parentPath);
      if (!parentStats.isDirectory()) {
        reply.code(400).send({ error: 'Parent path must be a directory.' });
        return;
      }
    } catch {
      reply.code(404).send({ error: 'Parent directory not found.' });
      return;
    }

    const createdPath = path.join(parentPath, parsedBody.data.name);
    if (!isPathInsideRoot(projectsRoot, createdPath)) {
      reply.code(400).send({ error: 'New folder must stay inside the current projects root.' });
      return;
    }

    try {
      await fs.mkdir(createdPath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'EEXIST') {
          reply.code(409).send({ error: 'A file or folder with that name already exists.' });
          return;
        }
        if (error.code === 'ENOENT') {
          reply.code(404).send({ error: 'Parent directory not found.' });
          return;
        }
      }
      throw error;
    }

    return { path: createdPath };
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

  app.get('/api/settings/network', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }

    return {
      tailscaleIpv4: getPrimaryTailscaleIpv4(),
    };
  });

  app.get('/api/settings/ui-preferences', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }

    const availableProjectSlugs = (await projectService.listActiveProjects()).map((project) => project.slug);
    return normalizeUiPreferences(
      db.getUiPreference<UiPreferences>(SIDEBAR_UI_PREFERENCES_KEY),
      availableProjectSlugs,
    );
  });

  app.put('/api/settings/ui-preferences', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }

    const parsedBody = updateUiPreferencesBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid UI preferences.', details: parsedBody.error.flatten() });
      return;
    }

    const availableProjectSlugs = (await projectService.listActiveProjects()).map((project) => project.slug);
    const current = normalizeUiPreferences(
      db.getUiPreference<UiPreferences>(SIDEBAR_UI_PREFERENCES_KEY),
      availableProjectSlugs,
    );
    const next = normalizeUiPreferences(
      {
        ...current,
        ...parsedBody.data,
      },
      availableProjectSlugs,
    );
    db.setUiPreference(SIDEBAR_UI_PREFERENCES_KEY, next);
    return { preferences: next };
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

  app.post('/api/settings/projects', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }

    const parsedBody = createProjectBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({ error: 'Invalid project settings.', details: parsedBody.error.flatten() });
      return;
    }

    const projectsRoot = normalizeFsPath(configService.getStoredConfig().projectsRoot ?? os.homedir());
    const projectPath = normalizeFsPath(parsedBody.data.path);
    if (!isPathInsideRoot(projectsRoot, projectPath)) {
      reply.code(400).send({ error: 'Project path must be inside the current projects root.' });
      return;
    }

    try {
      const stats = await fs.stat(projectPath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Project path must be a directory.' });
        return;
      }
    } catch {
      reply.code(404).send({ error: 'Project path not found.' });
      return;
    }

    const existingDirectoryName = configService.findProjectDirectoryNameByPath(projectPath);
    if (existingDirectoryName) {
      reply.code(409).send({ error: 'Project is already added.' });
      return;
    }

    const created = configService.createProjectConfig({ path: projectPath, active: true, displayName: path.basename(projectPath) });
    await indexing.primeProjectMetadata();
    const project = (await projectService.listProjectSettings()).find((item) => item.directoryName === created.directoryName);
    if (!project) {
      reply.code(500).send({ error: 'Project was created but could not be loaded.' });
      return;
    }

    return { project };
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
    await indexing.primeProjectMetadata();

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

  app.delete('/api/settings/projects/:directoryName', async (request, reply) => {
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

    const deleted = configService.deleteProjectConfig(parsedParams.data.directoryName);
    if (!deleted) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }

    await indexing.primeProjectMetadata();

    reply.code(204).send();
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
