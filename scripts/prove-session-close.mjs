#!/usr/bin/env node
// Opt-in real-provider proof. Only disposable sessions/transcripts are faulted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';

if (!process.argv.includes('--run')) throw new Error('Use --run to opt into disposable real helper close verification. Run npm run build first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-close-proof-'));
const project = path.join(root, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console close fixture. Do not edit files. Use coordination only when the test prompt requests it; otherwise reply to its marker.\n');
const configPath = path.join(root, 'config.json');
const socket = `console-proof-${randomUUID().slice(0, 8)}`;
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('../config/agent-console.example.json', import.meta.url), 'utf8'));
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'), databasePath: path.join(root, 'fixture.sqlite'),
  projects: { demo: { active: true, explicit: true, path: project } }, coordination: { enabled: true, pilotPaths: [project] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14378, publicBaseUrl: 'http://127.0.0.1:14378', webDistPath: path.resolve('apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false });
config.sessions.pressureSuspendAvailableMiB = 512;
for (const id of ['codex', 'claude']) {
  config.providers[id] = structuredClone(installed.providers[id]);
  config.providers[id].commands.env = { ...config.providers[id].commands.env, AGENT_CONSOLE_CONFIG: configPath, AGENT_COORD_RUNTIME: config.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: socket };
}
for (const key of ['newCommand', 'resumeCommand', 'continueCommand']) {
  config.providers.codex.commands[key].push('--dangerously-bypass-hook-trust', '-c',
    `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(config.runtimeDir)}`);
  config.providers.claude.commands[key].push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
    agent_console_coordination: { command: 'node', args: [path.resolve('scripts/agent-coord.mjs'), 'mcp'], env: { AGENT_COORD_RUNTIME: config.runtimeDir } },
  } }));
}
process.env.AGENT_CONSOLE_TMUX_SOCKET = socket;
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const { app } = await buildApp({ configPath });
await app.ready();
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
assert.equal(login.statusCode, 200);
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => {
  const result = await app.inject({ method, url, payload, headers });
  assert.ok(result.statusCode < 300, `${url}: ${result.statusCode} ${result.body}`);
  return result.body ? result.json() : undefined;
};
const rpc = payload => new Promise((resolve, reject) => {
  const request = http.request({ socketPath: path.join(config.runtimeDir, 'coordination/agent.sock'), path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
      const result = JSON.parse(text); response.statusCode === 200 ? resolve(result) : reject(new Error(text));
    });
  });
  request.on('error', reject); request.end(JSON.stringify(payload));
});
const wait = async (label, predicate, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error(`Timed out: ${label}; evidence ${root}`);
};
const controllerToken = randomBytes(32).toString('hex');
const controller = await rpc({ action: 'register', provider: 'codex', nativeSessionId: randomUUID(), token: controllerToken, pid: process.pid, cwd: project });
const controllerAuth = { assignmentId: controller.assignmentId, token: controllerToken };

const ids = [], evidence = [];
const record = entry => { evidence.push(entry); fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(entry)); };
const grantCall = payload => new Promise((resolve,reject) => {
 const request=http.request({socketPath:path.join(config.runtimeDir,'coordination/agent.sock'),path:'/grants',method:'POST',headers:{'content-type':'application/json'}},response=>{
  let body='';response.on('data',data=>{body+=data;});response.on('end',()=>response.statusCode===200?resolve(JSON.parse(body)):reject(Error(body)));
 });request.on('error',reject);request.end(JSON.stringify({...payload,...controllerAuth}));
});
const row = id => db.prepare('select * from bound_sessions where id=?').get(id);
const transcript = id => db.prepare('select transcript_path from conversation_index where project_slug=? and provider=? and ref=?').get('demo',row(id).provider,row(id).conversation_ref)?.transcript_path;
console.log(JSON.stringify({evidence:root,socket}));
try {
 const lead=await api('POST','/api/conversations/demo/codex/new/bind',{});let leadId=lead.session.id;ids.push(leadId);
 await wait('lead native startup',()=>{
  const text=execFileSync('tmux',['-L',socket,'capture-pane','-p','-t',row(leadId).tmux_session_name],{encoding:'utf8'});
  if(text.includes('Folder access')&&text.includes(project)&&text.includes('1. Trust and continue')&&text.includes('2. Quit')){execFileSync('tmux',['-L',socket,'send-keys','-t',row(leadId).tmux_session_name,'Enter']);return true;}
  return /gpt-\d/i.test(text);
 });
 await api('POST',`/api/sessions/${leadId}/model-profile`,{profile:'low'});
 const scope='This private Console verification authorizes launching, restarting and closing owned helpers in demo with history retained. No files or external actions are needed.';
 const submitted=await api('POST',`/api/sessions/${leadId}/input`,{text:scope+' Reply exactly CONTROL_READY and do not use tools.'});leadId=submitted.session.id;ids.push(leadId);
 assert(submitted.recordedUserInput?.id);
 const {grant}=await grantCall({action:'record',consoleSessionId:leadId,humanMessageId:submitted.recordedUserInput.id,
  definition:{grantee:{kind:'assignment',id:controller.assignmentId},actions:['launch_session','restart_session','close_session'],scope,projectSlugs:['demo'],expiry:{kind:'until_revoked'}}});
 assert.equal(grant.status,'active');
 const {CODEX_COST_PROFILES,CLAUDE_COST_PROFILES}=await import('@agent-console/shared');
 for(const provider of (process.env.PROOF_PROVIDERS??'codex,claude').split(',')) {
   const marker=`CLOSE_${provider}_close_${randomUUID().slice(0,8)}`, profile=provider==='codex'?CODEX_COST_PROFILES.low:CLAUDE_COST_PROFILES.low;
   const prompt=`Reply exactly ${marker}. Do not use tools or edit files.`;
   const request=await grantCall({action:'launch',projectSlug:'demo',provider,model:profile.model,effort:profile.reasoningEffort,prompt,title:marker,grantId:grant.id});
   const requestId=request.requests[0].id,id=request.requests[0].sessionId;ids.push(id);
   await wait('real launched helper and completed marker',async()=>{
    const status=(await grantCall({action:'launch_status',requestId})).requests[0];
    if(status.status==='failed'||status.status==='cancelled')throw Error(status.reason);
    if(status.status!=='completed')return false;
    const session=row(id);await api('GET',`/api/conversations/demo/${provider}/${encodeURIComponent(session.conversation_ref)}/messages?limit=0`);
    const file=transcript(id);if(!file||!row(id).last_response_at)return false;
    const screen=await api('GET',`/api/sessions/${id}/screen?lines=120`);
    return screen.screen?.inputActive&&!screen.screen.inputText.trim()&&!screen.session.isWorking&&fs.readFileSync(file,'utf8').includes(marker);
   });
   const session=row(id),file=transcript(id),before=fs.readFileSync(file,'utf8');
   const closeId=randomUUID();await grantCall({action:'close',sessionId:id,requestId:closeId,grantId:grant.id});
   await wait('owned close completed',async()=>{
    const result=(await grantCall({action:'launch_status',requestId:closeId})).requests[0];
    if(result.status==='failed'||result.status==='cancelled')throw Error(result.reason);
    return result.status==='completed';
   });
   await grantCall({action:'close',sessionId:id,requestId:closeId,grantId:grant.id});
   assert.equal(db.prepare("select count(*) as n from agent_session_requests where action='close_session' and id=?").get(closeId).n,1);
   assert.equal(row(id).should_restore,0);assert.equal(row(id).status,'ended');assert.equal(row(id).pid,null);
   assert.ok(fs.readFileSync(file,'utf8').startsWith(before),'Previous native history must remain intact');
   assert.throws(()=>execFileSync('tmux',['-L',socket,'has-session','-t',session.tmux_session_name],{stdio:'pipe'}));
   record({provider,action:'close',sessionId:id,conversationRef:session.conversation_ref,requestId,historyPreserved:true,ended:true,shouldRestore:false,pid:null,tmuxAbsent:true});
 }
 await new Promise(resolve=>setTimeout(resolve,35000));
 for(const item of evidence){assert.equal(row(item.sessionId).should_restore,0);assert.equal(row(item.sessionId).status,'ended');}
 record({completed:true,noRecoveryAfterReconciliation:true,evidence:root});
}finally{
 for(const id of [...new Set(ids)].reverse())try{if(row(id)?.should_restore)await api('POST',`/api/sessions/${id}/release`,{});}catch{}
 await app.close();db.close();try{execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore'});}catch{}
}
