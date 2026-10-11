// AGENT MAINTENANCE GUARD: Load waltium-cli-maintainer before changing this job command surface.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { normalizeFsPath } from '../lib/path-utils.js';
import { auditPeerWakes } from './audit.js';

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', default: process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json' },
    hours: { type: 'string', default: '24' }, usage: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { console.log('node apps/server/dist/coordination/audit-cli.js [--config PATH] [--hours 1..168] [--usage]\nRead-only peer-wake and transport audit JSON. Default reads SQLite and bounded private telemetry; --usage also reads native transcripts.'); return; }
  const config = JSON.parse(fs.readFileSync(normalizeFsPath(values.config!), 'utf8')) as { databasePath: string; runtimeDir: string };
  if (typeof config.databasePath !== 'string') throw new Error('Console config must specify databasePath.');
  if (typeof config.runtimeDir !== 'string') throw new Error('Console config must specify runtimeDir.');
  const db = new Database(normalizeFsPath(config.databasePath), { readonly: true, fileMustExist: true });
  try { console.log(JSON.stringify(await auditPeerWakes(db, { hours: Number(values.hours), includeUsage: values.usage,
    runtimeDir: normalizeFsPath(config.runtimeDir) }))); }
  finally { db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Peer-wake audit failed.'); process.exitCode = 1; });
