#!/usr/bin/env node
// Opt-in standing-grant proof, using real agents and an isolated Console/browser context.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { buildApp } from '../apps/server/dist/app.js';
if (!process.argv.includes('--run')) throw Error('Use --run to opt into real disposable grant sessions. Build first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-grants-proof-'));
const project = path.join(root, 'projects/demo'); fs.mkdirSync(project, { recursive: true }); execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Disposable Console grant demo. Work only on its test messages. Do not edit files or contact anyone outside its private Console runtime.\n');
const configPath = path.join(root, 'config.json'), socket = `console-grants-${randomUUID().slice(0, 8)}`;
const config = JSON.parse(fs.readFileSync(new URL('../config/agent-console.example.json', import.meta.url)));
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json')));
const password = randomBytes(20).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'), databasePath: path.join(root, 'fixture.sqlite'),
  projects: { demo: { active: true, explicit: true, path: project } }, coordination: { enabled: true, pilotPaths: [project] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14381, publicBaseUrl: 'http://127.0.0.1:14381', webDistPath: path.resolve('apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false });
config.sessions.pressureSuspendAvailableMiB = 512;
for (const provider of ['codex','claude']) {
  config.providers[provider] = structuredClone(installed.providers[provider]);
  config.providers[provider].commands.env = { ...config.providers[provider].commands.env, AGENT_CONSOLE_CONFIG: configPath, AGENT_COORD_RUNTIME: config.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: socket };
}
for (const key of ['newCommand','resumeCommand','continueCommand']) config.providers.codex.commands[key].push('--dangerously-bypass-hook-trust', '-c',
  `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(config.runtimeDir)}`, '-c',
  `mcp_servers.agent_console_coordination.args=${JSON.stringify([path.resolve('scripts/agent-coord.mjs'), 'mcp'])}`);
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); process.env.AGENT_CONSOLE_TMUX_SOCKET = socket;
const { app } = await buildApp({ configPath }); await app.listen({ host: '127.0.0.1', port: 14381 });
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => { const response = await app.inject({ method, url, payload, headers }); assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`); return response.body ? response.json() : undefined; };
const wait = async (label, predicate, timeout = 150_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); } throw Error(`Timed out ${label}; evidence ${root}`); };
const sessions = [], evidence = [];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'), context = await browser.newContext(), page = await context.newPage();
console.log(JSON.stringify({ evidence: root, socket }));
try {
  await page.goto('http://127.0.0.1:14381/login'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  for (const flow of (process.env.PROOF_GRANT_FLOWS ?? 'record,request').split(',')) {
    const bound = await api('POST', '/api/conversations/demo/codex/new/bind', {}); sessions.push(bound.session.id);
    await wait('native folder startup', () => {
      const screen = execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-S', '-60', '-t', bound.session.tmuxSessionName], { encoding: 'utf8' });
      if (screen.includes('Folder access') && screen.includes(project) && screen.includes('1. Trust and continue') && screen.includes('2. Quit')) { execFileSync('tmux', ['-L', socket, 'send-keys', '-t', bound.session.tmuxSessionName, 'Enter']); return true; }
      return /gpt-\d/i.test(screen);
    }, 30_000);
    await api('POST', `/api/sessions/${bound.session.id}/model-profile`, { profile: 'low' });
    const prompt = flow === 'record'
      ? 'I authorize you to do whatever is needed for this disposable planner demo, including launching and restarting real Console helpers. Do not edit files. Record this broad standing grant immediately with agent_grants record, referencing this Console human message ID from agent_grants list. Set its grantee to your own assignment, actions launch_session and restart_session, maximum concurrent sessions 2, unrestricted models, and expiry until revoked. Preserve my whole scope. For this phase, report GRANT_RECORDED after the grant is active, then finish the fixture assignment. Do not launch a helper in this phase.'
      : 'Please test the agent permission request flow. With agent_grants request, ask for one broad grant to launch and restart helpers for this disposable planner demo, grantee your own assignment, maximum concurrent sessions 2, unrestricted models, until revoked. Give the reason that helpers are needed to finish the demo. This message asks you to request authority, not to record direct authorization. Set continuation waiting_for_input, report GRANT_REQUEST_PENDING, then end the turn without finishing the assignment. When the Console wakes you after my approval, use agent_grants list to verify the grant is active, report GRANT_APPROVED_WITHOUT_NEW_INPUT, and finish.';
    const submitted = await api('POST', `/api/sessions/${bound.session.id}/input`, { text: prompt }), id = submitted.session.id; sessions.push(id);
    let grant;
    await wait('real agent grant submission', async () => {
      await api('GET', `/api/conversations/demo/codex/${encodeURIComponent(bound.conversationRef)}/messages?limit=0`);
      grant = (await api('GET','/api/grants')).grants.find(item => flow === 'record' ? item.status === 'active' : item.status === 'pending'); return grant;
    });
    await page.goto(`http://127.0.0.1:14381/grants?request=${grant.id}`); const card = page.locator(`#grant-${grant.id}`); await card.waitFor();
    if (flow === 'record') {
      assert.equal(grant.provenance.kind, 'human_message'); assert.ok(grant.scope.includes('whatever is needed')); assert.equal(grant.provenance.quote, prompt);
      assert.equal(await card.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
      await card.getByRole('button',{name:'Revoke',exact:true}).click();
      await wait('real one-click revoke', async () => (await api('GET','/api/grants')).grants.find(g => g.id === grant.id)?.status === 'revoked');
    } else {
      await wait('agent waiting for approval', () => db.prepare('select status from coordination_assignments where id=?').get(grant.createdByAssignmentId)?.status === 'waiting');
      await card.getByRole('button',{name:'Edit',exact:true}).click();
      const editedScope = 'Launch and restart helpers as needed to complete the disposable planner demo.';
      await card.getByLabel('Scope',{exact:true}).fill(editedScope);
      await card.getByRole('button',{name:'Approve edited grant',exact:true}).click();
      await wait('automatic approved response', () => {
        const state = db.prepare('select * from bound_sessions where id=?').get(id), transcript = db.prepare('select transcript_path from conversation_index where provider=\'codex\' and ref=?').get(state.conversation_ref)?.transcript_path;
        return transcript && fs.readFileSync(transcript,'utf8').includes('GRANT_APPROVED_WITHOUT_NEW_INPUT')
          && db.prepare('select status from coordination_assignments where id=?').get(grant.createdByAssignmentId)?.status === 'finished';
      });
      const state = db.prepare('select event_log_path from bound_sessions where id=?').get(id);
      assert.equal(fs.readFileSync(state.event_log_path,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'user-input').length, 1);
      assert.equal((await api('GET','/api/grants')).grants.find(g => g.id === grant.id).scope, editedScope);
    }
    evidence.push({ flow, grantId: grant.id, assignmentId: grant.createdByAssignmentId, realSessionId: id, browserVerified: true, noSecondHumanInput: true });
    fs.writeFileSync(path.join(root,'proof.json'), JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence.at(-1)));
    await api('POST',`/api/sessions/${id}/release`,{});
  }
} finally {
  for (const id of sessions) if (db.prepare('select should_restore from bound_sessions where id=?').get(id)?.should_restore) await api('POST',`/api/sessions/${id}/release`,{}).catch(()=>{});
  await context.close(); browser._connection.close();
  await app.close(); db.close(); try {execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore'});} catch {}
}
