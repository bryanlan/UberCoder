import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProviderId } from '@agent-console/shared';
import type { ConfigService, MergedProviderSettings } from '../config/service.js';
import type { ProjectConfig } from '../config/schema.js';

export interface ActiveProject {
  slug: string;
  directoryName: string;
  displayName: string;
  rootPath: string;
  path: string;
  matchPaths: string[];
  allowedLocalhostPorts: number[];
  tags: string[];
  notes?: string;
  config: ProjectConfig;
}

export interface ProjectSettingsSummary {
  directoryName: string;
  path: string;
  exists: boolean;
  active: boolean;
  displayName?: string;
  allowedLocalhostPorts: number[];
  tags: string[];
  notes?: string;
}

export class ProjectService {
  constructor(private readonly configService: ConfigService) {}

  async listActiveProjects(): Promise<ActiveProject[]> {
    const projects: ActiveProject[] = [];
    const projectsRoot = this.configService.getProjectsRoot();

    for (const directoryName of this.configService.getConfiguredProjectDirectoryNames()) {
      const config = this.configService.getProjectConfig(directoryName);
      if (!config?.active) continue;
      const projectPath = this.resolveProjectPath(directoryName, config);
      if (!(await this.isDirectory(projectPath))) continue;
      const { rootPath, matchPaths } = this.buildProjectPaths(directoryName, projectPath, projectsRoot, config);

      projects.push({
        slug: directoryName,
        directoryName,
        displayName: config.displayName ?? path.basename(projectPath),
        rootPath,
        path: projectPath,
        matchPaths,
        allowedLocalhostPorts: [...config.allowedLocalhostPorts].sort((a, b) => a - b),
        tags: [...config.tags],
        notes: config.notes,
        config,
      });
    }

    projects.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return projects;
  }

  async listProjectSettings(): Promise<ProjectSettingsSummary[]> {
    const names = this.configService.getConfiguredProjectDirectoryNames();
    const projects = await Promise.all(names.map(async (directoryName) => {
      const config = this.configService.getProjectConfig(directoryName);
      const projectPath = this.resolveProjectPath(directoryName, config);
      return {
        directoryName,
        path: projectPath,
        exists: await this.isDirectory(projectPath),
        active: config?.active ?? false,
        displayName: config?.displayName,
        allowedLocalhostPorts: [...(config?.allowedLocalhostPorts ?? [])].sort((a, b) => a - b),
        tags: [...(config?.tags ?? [])],
        notes: config?.notes,
      };
    }));

    return projects.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const aLabel = a.displayName ?? a.directoryName;
      const bLabel = b.displayName ?? b.directoryName;
      return aLabel.localeCompare(bLabel);
    });
  }

  async getProjectBySlug(slug: string): Promise<ActiveProject | undefined> {
    const projects = await this.listActiveProjects();
    return projects.find((project) => project.slug === slug);
  }

  getMergedProviderSettings(project: ActiveProject, provider: ProviderId): MergedProviderSettings {
    return this.configService.getMergedProviderSettings(project.directoryName, provider);
  }

  private resolveProjectPath(directoryName: string, config: ProjectConfig | undefined): string {
    return config?.path ?? path.join(this.configService.getProjectsRoot(), directoryName);
  }

  private buildProjectPaths(
    directoryName: string,
    projectPath: string,
    projectsRoot: string,
    config: ProjectConfig,
  ): { rootPath: string; matchPaths: string[] } {
    const relativePath = path.relative(projectsRoot, projectPath);
    const [firstSegment] = relativePath.split(path.sep).filter(Boolean);
    const rootPath = firstSegment && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
      ? path.join(projectsRoot, firstSegment)
      : projectPath;
    const matchPaths = config.explicit || rootPath === projectPath
      ? [projectPath]
      : [projectPath, rootPath];

    return {
      rootPath,
      matchPaths: Array.from(new Set(matchPaths)),
    };
  }

  private async isDirectory(candidatePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(candidatePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}
