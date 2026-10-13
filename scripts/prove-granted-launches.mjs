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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-launch-proof-'));
const project = path.join(root, 'projects/demo'); fs.mkdirSync(project, { recursive: true }); execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Private budget-planning example. Work in this project only. The Console supplies standing grants and supervising assignments. Keep peer communication inside this private runtime.\n');
const configPath = path.join(root, 'config.json'), socket = `console-launch-${randomUUID().slice(0, 8)}`;
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
// The operational checkout still runs the preceding release while this proof
// tests the new helper. Supply that helper to the disposable native hooks too.
const hooks = Object.fromEntries(['SessionStart','UserPromptSubmit','PostToolUse','PostToolUseFailure','Stop','SessionEnd'].map(event =>
  [event, [{ hooks: [{ type: 'command', command: `node '${path.resolve('scripts/agent-coord.mjs')}' hook claude`, timeout: 5 }] }]]));
for (const key of ['newCommand','resumeCommand','continueCommand']) config.providers.claude.commands[key].push('--settings', JSON.stringify({ hooks }));
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); process.env.AGENT_CONSOLE_TMUX_SOCKET = socket;
const { app } = await buildApp({ configPath }); await app.listen({ host: '127.0.0.1', port: 14381 });
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => { const response = await app.inject({ method, url, payload, headers }); assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`); return response.body ? response.json() : undefined; };
const wait = async (label, predicate, timeout = 150_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); } throw Error(`Timed out ${label}; evidence ${root}`); };
import http from 'node:http';
import { CODEX_COST_PROFILES, CLAUDE_COST_PROFILES } from '@agent-console/shared';
const rpc = (payload, endpoint='/rpc') => new Promise((resolve,reject)=>{
 const request=http.request({socketPath:path.join(config.runtimeDir,'coordination/agent.sock'),path:endpoint,method:'POST',headers:{'content-type':'application/json'}},response=>{
  let body='';response.on('data',data=>{body+=data;});response.on('end',()=>response.statusCode===200?resolve(JSON.parse(body)):reject(Error(body)));
 });request.on('error',reject);request.end(JSON.stringify(payload));
});
const token=randomBytes(32).toString('hex'), controller=(await rpc({action:'register',provider:'codex',nativeSessionId:randomUUID(),token,pid:process.pid,cwd:project})).assignmentId;
const auth={assignmentId:controller,token};
const sessions=[],evidence=[];
const record = entry => { evidence.push(entry); fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(entry)); };
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'),context=await browser.newContext(),page=await context.newPage();
console.log(JSON.stringify({evidence:root,socket}));
const nativeFor = id=>{const session=db.prepare('select * from bound_sessions where id=?').get(id);return db.prepare('select * from coordination_assignments where provider=? and native_session_id=?').get(session.provider,session.conversation_ref);};
const send=(recipientId,text)=>rpc({...auth,action:'send',messageId:randomUUID(),recipientId,text});
const ready=async id=>{const response=await api('GET',`/api/sessions/${id}/screen?lines=120`);return response.screen?.inputActive&&!response.session.isWorking&&!response.screen.inputText.trim();};
try{
 await page.goto('http://127.0.0.1:14381/login');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 const bound=await api('POST','/api/conversations/demo/codex/new/bind',{});sessions.push(bound.session.id);
 await wait('native parent startup',()=>{const screen=execFileSync('tmux',['-L',socket,'capture-pane','-p','-S','-60','-t',bound.session.tmuxSessionName],{encoding:'utf8'});if(screen.includes('Folder access')&&screen.includes(project)&&screen.includes('1. Trust and continue')){execFileSync('tmux',['-L',socket,'send-keys','-t',bound.session.tmuxSessionName,'Enter']);return true;}return /gpt-\d/i.test(screen);},30000);
 await api('POST',`/api/sessions/${bound.session.id}/model-profile`,{profile:'low'});
 const prompt=`I authorize all agents in this private project to do whatever is needed to implement a budget-planning example, including launching and restarting real Console sessions, delegating helpers, and handling budget requirements relayed within this scope by the test driver ${controller}. Work and files must stay in this private checkout and peer communication must stay in this private runtime. First declare coordination description "Grant proof lead" and continuation unattended. Record my first two sentences as the broad grant scope, with this human message as provenance: grantee project demo, both actions, maximum concurrent sessions 4, unrestricted models, until revoked. Launch a Codex lane in demo with model ${CODEX_COST_PROFILES.low.model}, effort medium, flags ["--add-dir",${JSON.stringify(project)}], title "Granted planner lane", and your assignment as supervisor. Its concrete job is to implement budget-summary.md for an example with monthly income 4000 dollars; the expense amount will arrive after a capacity/restart check. First read active grants, declare description "Granted planner lane" and unattended, send LANE_READY to its supervisor, then end its turn with this budget work still unfinished. Do not poll inside the turn; Console wakes it for the remaining budget input. After launching, end your own turn with the assignment unfinished. Carry out the driver stages within this budget scope, and finish after ALL_PROOF_DONE.`;
 const submitted=await api('POST',`/api/sessions/${bound.session.id}/input`,{text:prompt}),leadId=submitted.session.id;sessions.push(leadId);
 let grant;
 await wait('real lead grant and lane launch',async()=>{await api('GET',`/api/conversations/demo/codex/${encodeURIComponent(bound.conversationRef)}/messages?limit=0`);grant=(await api('GET','/api/grants')).grants.find(g=>g.status==='active');return grant&&db.prepare("select session_id from agent_session_requests where action='launch_session' and status='completed'").get();});
 const laneId=db.prepare("select session_id from agent_session_requests where action='launch_session' and status='completed'").get().session_id;sessions.push(laneId);
 await wait('registered lane and native ready',async()=>nativeFor(laneId)&&await ready(laneId));
 const lane=nativeFor(laneId),lead=nativeFor(leadId),laneState=db.prepare('select * from bound_sessions where id=?').get(laneId);
 assert.equal(JSON.parse(laneState.launch_context_json).supervisorId,lead.id);
 assert.equal(JSON.parse(db.prepare('select value from meta where key=?').get(`assignment-continuation:${lane.id}`).value).continuation,'unattended');
 assert.deepEqual(JSON.parse(laneState.launch_context_json).grantIds,[grant.id]);
 await api('POST','/api/projects/refresh',{projectSlug:'demo',providerId:'codex'});
 await page.goto(`http://127.0.0.1:14381/projects/demo/codex/${lane.native_session_id}`);await page.getByText('Launched by Grant proof lead',{exact:true}).waitFor();
 record({step:3,action:'launch',sessionId:laneId,assignmentId:lane.id,grantId:grant.id,model:CODEX_COST_PROFILES.low.model,effort:'medium',supervisorId:lead.id,browserLaunchedBy:true});
 const transcript=db.prepare('select transcript_path from conversation_index where provider=? and ref=?').get('codex',lane.native_session_id).transcript_path;
 const timestamp=new Date().toISOString();fs.appendFileSync(transcript,[{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'grant-proof-capacity'}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'grant-proof-capacity',error:{codex_error_info:'server_overloaded',message:'Selected model is at capacity. Please try a different model.'}}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 await send(lane.id,`Capacity stage within our shared grant: acknowledge this message and send GRANTED_CAPACITY_RECOVERED to fixture controller ${controller}. Keep the lane unfinished for restart and delegation.`);
 await wait('granted lane automatically recovers',()=>db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(lane.id,controller,'GRANTED_CAPACITY_RECOVERED'));
 await wait('lane ready after capacity',()=>ready(laneId));
 record({step:3,action:'capacity_recovery',sessionId:laneId,noNewApproval:true});
 const oldPid=db.prepare('select pid from bound_sessions where id=?').get(laneId).pid;
 await send(lead.id,`Restart stage within the standing grant: use agent_grants restart for sessionId ${laneId}. It is idle with unfinished authorized work. Wait for launch_status to report completion, then send GRANTED_RESTART_DONE to controller ${controller}. Do not make a new grant request.`);
 await wait('real lead requests granted restart',()=>db.prepare("select id from agent_session_requests where action='restart_session' and status='completed'").get());
 assert.notEqual(db.prepare('select pid from bound_sessions where id=?').get(laneId).pid,oldPid);
 await wait('lane ready after granted restart',()=>ready(laneId));
 const turns=fs.readFileSync(transcript,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='turn_context');
 assert.equal(turns.at(-1).payload.model,CODEX_COST_PROFILES.low.model);assert.equal(turns.at(-1).payload.effort,'medium');
 record({step:3,action:'restart',sessionId:laneId,oldPid,newPid:db.prepare('select pid from bound_sessions where id=?').get(laneId).pid,noNewApproval:true,modelAndEffortPreserved:true});
 await send(lane.id,`Delegate the budget-summary.md work to a Claude helper in demo, model ${CLAUDE_COST_PROFILES.low.model}, effort high, title "Inherited planner helper", with your own assignment as supervisor. Its concrete task is to calculate annual income and spending for monthly income 4000 dollars, write budget-summary.md and report the annual surplus. You will supply the monthly expense amount in a second message. Have it read its inherited grant, calculate annual income, send exactly INHERITED_HELPER_READY to you (its supervisor), then end its turn with the calculation unfinished until that one missing input arrives. Report the registered helper assignment to your supervisor.`);
 const grand=await wait('real worker delegates a Claude helper',()=>db.prepare("select * from agent_session_requests where assignment_id=? and action='launch_session' and status='completed'").get(lane.id));sessions.push(grand.session_id);
 await wait('inherited helper ready',()=>db.prepare('select id from coordination_messages where recipient_id=? and text=?').get(lane.id,'INHERITED_HELPER_READY'));
 const helper=nativeFor(grand.session_id);assert(helper);
 assert.deepEqual(JSON.parse(db.prepare('select launch_context_json from bound_sessions where id=?').get(grand.session_id).launch_context_json).grantIds,[grant.id]);
 await send(lane.id,`Relay the remaining budget requirement to your helper ${helper.id} under the shared grant: monthly spending is 3250 dollars. Ask it to write budget-summary.md with annual income, annual spending and annual surplus, send exactly SHARED_GRANT_SCOPE_HONORED to you, and finish the helper assignment. This completes the same budget example Bryan authorized.`);
 await wait('relayed scope honored under inherited grant',()=>db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(helper.id,lane.id,'SHARED_GRANT_SCOPE_HONORED'));
 const budget=fs.readFileSync(path.join(project,'budget-summary.md'),'utf8').replace(/,/g,'');
 assert.ok(budget.includes('48000')&&budget.includes('39000')&&budget.includes('9000'),budget);
 assert.equal((await api('GET','/api/grants')).grants.length,1);
 for(const id of [laneId,grand.session_id]){const log=db.prepare('select event_log_path from bound_sessions where id=?').get(id).event_log_path;assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.type==='user-input').length,0);}
 record({step:4,action:'inherited_launch_and_relay',sessionId:grand.session_id,assignmentId:helper.id,launcherAssignment:lane.id,grantId:grant.id,noHumanInputs:true,noNewRequests:true});
 fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 await send(lead.id,'ALL_PROOF_DONE. The grant launch, capacity, restart, inherited helper and shared scope checks passed. Finish the lead assignment.');
 await send(lane.id,'ALL_PROOF_DONE. Finish this lane assignment.');
 await wait('lead finished',()=>db.prepare('select status from coordination_assignments where id=?').get(lead.id)?.status==='finished');
}finally{
 await context.close();browser._connection.close();
 for(const row of db.prepare('select id from bound_sessions where should_restore=1').all())await api('POST',`/api/sessions/${row.id}/release`,{}).catch(()=>{});
 await rpc({...auth,action:'finish',summary:'Disposable launch proof controller finished.'}).catch(()=>{});
 await app.close();db.close();try{execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore'});}catch{}
}
// End only this proof's CDP transport, after cleanup; keep shared Chrome alive.
process.exit(0);
