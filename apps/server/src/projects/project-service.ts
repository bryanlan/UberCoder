import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProviderId } from '@agent-console/shared';
import type { ConfigService, MergedProviderSettings } from '../config/service.js';
import type { ProjectConfig } from '../config/schema.js';

export interface ActiveProject {
  slug: string;
  directoryName: string;
  displayName: string;
  path: string;
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
    const root = this.configService.getProjectsRoot();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const projects: ActiveProject[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const config = this.configService.getProjectConfig(entry.name);
      if (!config?.active) continue;

      projects.push({
        slug: entry.name,
        directoryName: entry.name,
        displayName: config.displayName ?? entry.name,
        path: path.join(root, entry.name),
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
    const root = this.configService.getProjectsRoot();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const existingDirectories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const names = new Set<string>([
      ...existingDirectories,
      ...this.configService.getConfiguredProjectDirectoryNames(),
    ]);

    return [...names]
      .map((directoryName) => {
        const config = this.configService.getProjectConfig(directoryName);
        return {
          directoryName,
          path: path.join(root, directoryName),
          exists: existingDirectories.has(directoryName),
          active: config?.active ?? false,
          displayName: config?.displayName,
          allowedLocalhostPorts: [...(config?.allowedLocalhostPorts ?? [])].sort((a, b) => a - b),
          tags: [...(config?.tags ?? [])],
          notes: config?.notes,
        };
      })
      .sort((a, b) => {
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
}
