// AGENT MAINTENANCE GUARD:
// If you are an AI agent modifying this Waltium CLI/API/MCP/job command surface,
// stop unless you have loaded the waltium-cli-maintainer skill. That skill owns
// command changes, safety guards, tests, docs, and top-level skill routing updates.
// If unavailable, notify Bryan before editing.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeFsPath } from '../lib/path-utils.js';
import { readSummaryConfig } from './config.js';
import { engineeringSummary } from './summary.js';


function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json' },
    database: { type: 'string' }, 'wiki-database': { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Read-only Agent Console engineering summary (schema_version 1).\n'
      + 'node apps/server/dist/engineering/summary-cli.js [--config PATH] [--database PATH] [--wiki-database PATH]\n'
      + 'Source mode: node_modules/.bin/tsx apps/server/src/engineering/summary-cli.ts [same options]\n'
      + 'Reads explicit metadata columns from existing SQLite databases; never starts the backend or migrates a database.\n'
      + 'Reads configured project paths; no profiles or auth state are exported.\nExit 0: complete; exit 2: partial/unavailable sources; exit 1: invalid invocation/config.');
    return;
  }
  let database = values.database;
  if (!database) {
    database = readSummaryConfig(values.config!).databasePath;
  }
  database = normalizeFsPath(database);
  const wikiDatabase = normalizeFsPath(values['wiki-database'] ?? path.join(path.dirname(database), 'wiki/agent-wiki.sqlite'));
  const summary = engineeringSummary({ database, wikiDatabase, config: normalizeFsPath(values.config!) });
  console.log(JSON.stringify(summary));
  if (summary.status !== 'ok') process.exitCode = 2;
}

try { main(); }
catch {
  console.log(JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), status: 'error',
    configured_projects: [], sources: { projects: { path: '[config path omitted]', status: 'error', observed_at: new Date().toISOString(), issues: [{ source: 'projects', code: 'CONFIG_UNAVAILABLE', message: 'Configured project paths could not be read.' }] } }, agents: null, wiki: null,
    issues: [{ source: 'config', code: 'INVALID_INVOCATION', message: 'Summary configuration or arguments could not be read. Use --help and check the config path. Private error details are omitted.' }] }));
  process.exitCode = 1;
}
