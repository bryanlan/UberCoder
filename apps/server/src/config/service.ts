import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, type ProviderId } from '@agent-console/shared';
import { appConfigSchema, projectConfigSchema, type AppConfig, type ProjectConfig, type ProviderSettings } from './schema.js';
import { expandHome, normalizeFsPath } from '../lib/path-utils.js';

const PROJECT_MARKER_FILES = new Set(['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md']);
const IGNORED_PROJECT_SCAN_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);

export interface MergedProviderSettings extends Omit<ProviderSettings, 'discoveryRoot'> {
  id: ProviderId;
  discoveryRoot: string;
}

export class ConfigService {
  private readonly configPath: string;
  private runtimeConfig: AppConfig;
  private storedConfig: AppConfig;

  constructor(configPath?: string) {
    this.configPath = normalizeFsPath(configPath ?? process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json');
    const raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    const parsed = appConfigSchema.parse(raw);
    const migrated = this.migrateLegacyProjects(parsed);
    this.runtimeConfig = migrated.config;
    this.storedConfig = migrated.config;
    if (migrated.changed) {
      this.persist();
    }
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfig(): AppConfig {
    return this.normalizeConfig(this.runtimeConfig);
  }

  getStoredConfig(): AppConfig {
    return this.normalizeConfig(this.storedConfig);
  }

  private normalizeConfig(config: AppConfig): AppConfig {
    return {
      ...config,
      projectsRoot: normalizeFsPath(config.projectsRoot),
      runtimeDir: normalizeFsPath(config.runtimeDir),
      databasePath: normalizeFsPath(config.databasePath),
      projects: Object.fromEntries(Object.entries(config.projects).map(([key, project]) => [
        key,
        {
          ...project,
          path: project.path ? normalizeFsPath(project.path) : undefined,
        },
      ])),
      server: {
        ...config.server,
        webDistPath: path.resolve(path.dirname(this.configPath), config.server.webDistPath),
      },
      providers: {
        codex: {
          ...config.providers.codex,
          discoveryRoot: normalizeFsPath(config.providers.codex.discoveryRoot ?? '~/.codex'),
          commands: {
            ...config.providers.codex.commands,
            env: Object.fromEntries(Object.entries(config.providers.codex.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
        claude: {
          ...config.providers.claude,
          discoveryRoot: normalizeFsPath(config.providers.claude.discoveryRoot ?? '~/.claude'),
          commands: {
            ...config.providers.claude.commands,
            env: Object.fromEntries(Object.entries(config.providers.claude.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
      },
    };
  }

  getProjectsRoot(): string {
    return normalizeFsPath(this.runtimeConfig.projectsRoot);
  }

  getRuntimeDir(): string {
    return normalizeFsPath(this.runtimeConfig.runtimeDir);
  }

  getDatabasePath(): string {
    return normalizeFsPath(this.runtimeConfig.databasePath);
  }

  getProjectConfig(directoryName: string): ProjectConfig | undefined {
    const project = this.runtimeConfig.projects[directoryName];
    if (!project) return undefined;
    return {
      ...project,
      path: project.path ? normalizeFsPath(project.path) : undefined,
    };
  }

  getMergedProviderSettings(directoryName: string, providerId: ProviderId): MergedProviderSettings {
    const globalProvider = this.runtimeConfig.providers[providerId];
    const projectOverride = directoryName === '__global__' ? undefined : this.runtimeConfig.projects[directoryName]?.providers[providerId];
    return {
      id: providerId,
      enabled: projectOverride?.enabled ?? globalProvider.enabled,
      discoveryRoot: normalizeFsPath(projectOverride?.discoveryRoot ?? globalProvider.discoveryRoot ?? (providerId === 'codex' ? '~/.codex' : '~/.claude')),
      commands: {
        newCommand: projectOverride?.commands?.newCommand ?? globalProvider.commands.newCommand,
        resumeCommand: projectOverride?.commands?.resumeCommand ?? globalProvider.commands.resumeCommand,
        continueCommand: projectOverride?.commands?.continueCommand ?? globalProvider.commands.continueCommand,
        env: Object.fromEntries(
          Object.entries({
            ...globalProvider.commands.env,
            ...(projectOverride?.commands?.env ?? {}),
          }).map(([key, value]) => [key, expandHome(value)]),
        ),
      },
    };
  }

  getResolvedProviderEnv(directoryName: string, providerId: ProviderId): Record<string, string> {
    const settings = this.getMergedProviderSettings(directoryName, providerId);
    return Object.fromEntries(Object.entries(settings.commands.env).map(([key, value]) => [key, expandHome(value)]));
  }

  getActiveProjectDirectoryNames(): string[] {
    return Object.entries(this.runtimeConfig.projects)
      .filter(([, value]) => value.active)
      .map(([key]) => key);
  }

  getConfiguredProjectDirectoryNames(): string[] {
    return Object.keys(this.storedConfig.projects);
  }

  findProjectDirectoryNameByPath(projectPath: string): string | undefined {
    const normalizedTarget = normalizeFsPath(projectPath);
    const root = this.getStoredProjectsRoot();
    for (const [directoryName, project] of Object.entries(this.runtimeConfig.projects)) {
      const configuredPath = normalizeFsPath(project.path ?? path.join(root, directoryName));
      if (configuredPath === normalizedTarget) {
        return directoryName;
      }
    }
    return undefined;
  }

  createProjectConfig(input: {
    path: string;
    active?: boolean;
    displayName?: string;
    allowedLocalhostPorts?: number[];
    tags?: string[];
    notes?: string;
  }): { directoryName: string; project: ProjectConfig } {
    const normalizedPath = normalizeFsPath(input.path);
    const existingDirectoryName = this.findProjectDirectoryNameByPath(normalizedPath);
    if (existingDirectoryName) {
      return {
        directoryName: existingDirectoryName,
        project: this.getProjectConfig(existingDirectoryName)!,
      };
    }

    const directoryName = this.generateProjectDirectoryName(normalizedPath);
    const nextProject = projectConfigSchema.parse({
      active: input.active ?? true,
      path: normalizedPath,
      displayName: input.displayName,
      allowedLocalhostPorts: input.allowedLocalhostPorts ?? [],
      tags: input.tags ?? [],
      notes: input.notes,
      providers: {},
    });

    this.storedConfig = {
      ...this.storedConfig,
      projects: {
        ...this.storedConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.runtimeConfig = {
      ...this.runtimeConfig,
      projects: {
        ...this.runtimeConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.persist();
    return { directoryName, project: nextProject };
  }

  updateProjectConfig(
    directoryName: string,
    input: Pick<ProjectConfig, 'active' | 'allowedLocalhostPorts' | 'tags'> & Partial<Pick<ProjectConfig, 'path' | 'displayName' | 'notes'>>,
  ): ProjectConfig {
    const currentStored = this.storedConfig.projects[directoryName];
    const nextProject = projectConfigSchema.parse({
      ...currentStored,
      active: input.active,
      path: input.path ?? currentStored?.path,
      displayName: input.displayName,
      allowedLocalhostPorts: input.allowedLocalhostPorts,
      tags: input.tags,
      notes: input.notes,
      providers: currentStored?.providers ?? {},
    });
    this.storedConfig = {
      ...this.storedConfig,
      projects: {
        ...this.storedConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.runtimeConfig = {
      ...this.runtimeConfig,
      projects: {
        ...this.runtimeConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.persist();
    return nextProject;
  }

  deleteProjectConfig(directoryName: string): boolean {
    if (!this.storedConfig.projects[directoryName]) {
      return false;
    }

    const { [directoryName]: _removedStored, ...storedProjects } = this.storedConfig.projects;
    const { [directoryName]: _removedRuntime, ...runtimeProjects } = this.runtimeConfig.projects;
    this.storedConfig = {
      ...this.storedConfig,
      projects: storedProjects,
    };
    this.runtimeConfig = {
      ...this.runtimeConfig,
      projects: runtimeProjects,
    };
    this.persist();
    return true;
  }

  updateGlobalSettings(input: {
    projectsRoot: string;
    serverHost: string;
    serverPort: number;
    sessionTtlHours: number;
    cookieSecure: boolean;
    trustTailscaleHeaders: boolean;
  }): AppConfig {
    this.storedConfig = appConfigSchema.parse({
      ...this.storedConfig,
      projectsRoot: input.projectsRoot,
      server: {
        ...this.storedConfig.server,
        host: input.serverHost,
        port: input.serverPort,
      },
      security: {
        ...this.storedConfig.security,
        sessionTtlHours: input.sessionTtlHours,
        cookieSecure: input.cookieSecure,
        trustTailscaleHeaders: input.trustTailscaleHeaders,
      },
    });
    this.persist();
    return this.getStoredConfig();
  }

  getProviderIds(): ProviderId[] {
    return [...PROVIDERS];
  }

  private persist(): void {
    writeFileSync(this.configPath, `${JSON.stringify(this.storedConfig, null, 2)}\n`, 'utf8');
  }

  private getStoredProjectsRoot(): string {
    return normalizeFsPath(this.storedConfig.projectsRoot);
  }

  private migrateLegacyProjects(config: AppConfig): { config: AppConfig; changed: boolean } {
    const projectsRoot = normalizeFsPath(config.projectsRoot);
    let changed = false;
    const migratedProjects = Object.fromEntries(Object.entries(config.projects).map(([directoryName, project]) => {
      const legacyProjectPath = normalizeFsPath(path.join(projectsRoot, directoryName));
      const configuredPath = normalizeFsPath(project.path ?? legacyProjectPath);
      if (project.path && configuredPath !== legacyProjectPath) {
        return [directoryName, project];
      }

      const nextPath = this.resolveLegacyProjectPath(legacyProjectPath);
      if (!project.path || nextPath !== configuredPath) {
        changed = true;
      }

      return [directoryName, projectConfigSchema.parse({
        ...project,
        path: nextPath,
      })];
    }));

    if (!changed) {
      return { config, changed: false };
    }

    return {
      config: appConfigSchema.parse({
        ...config,
        projects: migratedProjects,
      }),
      changed: true,
    };
  }

  private resolveLegacyProjectPath(legacyProjectPath: string): string {
    return this.findSingleMarkedProjectPath(legacyProjectPath) ?? legacyProjectPath;
  }

  private findSingleMarkedProjectPath(candidatePath: string): string | undefined {
    let entries;
    try {
      entries = readdirSync(candidatePath, { withFileTypes: true });
    } catch {
      return undefined;
    }

    if (entries.some((entry) => entry.isFile() && PROJECT_MARKER_FILES.has(entry.name))) {
      return candidatePath;
    }

    let match: string | undefined;
    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_PROJECT_SCAN_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of childDirectories) {
      const childMatch = this.findSingleMarkedProjectPath(path.join(candidatePath, child.name));
      if (!childMatch) continue;
      if (match && match !== childMatch) {
        return undefined;
      }
      match = childMatch;
    }

    return match;
  }

  private getPreferredProjectDirectoryName(projectPath: string): string {
    const relativePath = path.relative(this.getStoredProjectsRoot(), projectPath);
    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return this.slugifySegment(path.basename(projectPath));
    }

    const segments = relativePath
      .split(path.sep)
      .filter(Boolean)
      .map((segment) => this.slugifySegment(segment));

    return segments.join('--');
  }

  private slugifySegment(value: string): string {
    const slug = value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'project';
  }

  private generateProjectDirectoryName(projectPath: string): string {
    const base = this.getPreferredProjectDirectoryName(projectPath);

    let candidate = base;
    let suffix = 2;
    while (this.storedConfig.projects[candidate]) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}
