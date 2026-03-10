import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getAgentConsolePath(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '../../../../');
}
