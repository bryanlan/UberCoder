#!/usr/bin/env node
// Installs one explicitly enabled local pilot. Dry-run unless --apply is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pilots = args.flatMap((value, index) => value === '--pilot' ? [fs.realpathSync(args[index + 1])] : []);
if (!pilots.length) throw new Error('Provide at least one --pilot /absolute/repository. No files changed.');
const helper = fileURLToPath(new URL('./agent-coord.mjs', import.meta.url));
const configPath = process.env.AGENT_CONSOLE_CONFIG ?? path.join(os.homedir(), '.config/agent-console/config.json');
const codexConfig = path.join(os.homedir(), '.codex/config.toml');
const codexHooks = path.join(os.homedir(), '.codex/hooks.json');
const claudeSettings = path.join(os.homedir(), '.claude/settings.json');
const claudeConfig = path.join(os.homedir(), '.claude.json');
const targets = [configPath, codexConfig, codexHooks, claudeSettings, claudeConfig];
for (const file of targets) {
  let cursor = file;
  while (cursor !== path.dirname(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing to replace symlink ${cursor} -> ${fs.readlinkSync(cursor)}. Review its target before installation.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = path.dirname(cursor);
  }
}
for (const pilot of pilots) execFileSync('git', ['-C', pilot, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
const hostConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const runtimeDir = (hostConfig.runtimeDir ?? '~/.local/share/agent-console/runtime').replace(/^~(?=\/)/, os.homedir());
const serverName = 'agent_console_coordination';
const before = new Map(targets.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
const codexText = before.get(codexConfig)?.toString() ?? '';
if (codexText.includes(`[mcp_servers.${serverName}`)) throw new Error('Coordination is already installed in Codex. Review existing configuration instead of overwriting it.');
const claudeData = JSON.parse(before.get(claudeConfig)?.toString() ?? '{}');
if (claudeData.mcpServers?.[serverName]) throw new Error('Coordination is already installed in Claude. Review existing configuration instead of overwriting it.');
console.log(JSON.stringify({ apply, pilotPaths: pilots, files: targets, hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd'], mcpServer: serverName, runtimeDir, activation: 'Requires the updated Console backend; existing provider processes are not restarted.' }, null, 2));
if (!apply) process.exit(0);

const backup = path.join(os.homedir(), '.local/share/agent-console/coordination-install-backups', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const [file, data] of before) if (data) fs.writeFileSync(path.join(backup, path.basename(path.dirname(file)) + '-' + path.basename(file)), data, { mode: 0o600 });

function replaceJson(file, update) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const data = original ? JSON.parse(original) : {};
  update(data);
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) throw new Error(`Configuration changed during installation: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.coordination-install-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: original ? fs.statSync(file).mode & 0o777 : 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function addHooks(file, provider) {
  replaceJson(file, (data) => {
    data.hooks ??= {};
    const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
    if (provider === 'claude') events.push('PostToolUseFailure');
    for (const event of events) {
      data.hooks[event] ??= [];
      data.hooks[event].push({ hooks: [{ type: 'command', command: `node '${helper.replaceAll("'", "'\\''")}' hook ${provider}`, timeout: event === 'SessionEnd' ? 3 : 5 }] });
    }
    if (provider === 'claude') {
      data.permissions ??= {}; data.permissions.allow ??= [];
      data.permissions.allow.push(`mcp__${serverName}__agent_coordination`);
    }
  });
}

execFileSync('codex', ['mcp', 'add', serverName, '--env', `AGENT_COORD_RUNTIME=${runtimeDir}`, '--', process.execPath, helper, 'mcp'], { stdio: 'inherit' });
fs.appendFileSync(codexConfig, `\n[mcp_servers.${serverName}.tools.agent_coordination]\napproval_mode = "approve"\n`);
execFileSync('claude', ['mcp', 'add', serverName, '--scope', 'user', '--transport', 'stdio', '--env', `AGENT_COORD_RUNTIME=${runtimeDir}`, '--', process.execPath, helper, 'mcp'], { stdio: 'inherit' });
addHooks(codexHooks, 'codex');
addHooks(claudeSettings, 'claude');
replaceJson(configPath, (data) => { data.coordination = { enabled: true, pilotPaths: pilots }; });
console.log(`Installed. Private configuration backup: ${backup}`);
console.log('Review and trust the new Codex hooks using /hooks. Hook trust is not bypassed. Start new provider sessions to load the MCP server.');
