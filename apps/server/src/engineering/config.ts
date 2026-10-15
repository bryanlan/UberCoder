import fs from 'node:fs';
import { appConfigSchema } from '../config/schema.js';
import { normalizeFsPath } from '../lib/path-utils.js';

// Reuse backend defaults without constructing write-capable application services.
const summaryConfigSchema = appConfigSchema.pick({ databasePath: true, projectsRoot: true, projects: true });
export function readSummaryConfig(configPath: string) {
  return summaryConfigSchema.parse(JSON.parse(fs.readFileSync(normalizeFsPath(configPath), 'utf8')));
}
