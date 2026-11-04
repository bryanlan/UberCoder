#!/usr/bin/env node
// Opt-in granted-launch proof (launch, capacity recovery, restart, inherited helper), using real agents on the structured
// transport and an isolated Console/browser context.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { buildApp } from '../apps/server/dist/app.js';
import { endStandaloneProof, readModelProfiles } from './structured-proof-kit.mjs';
if (!process.argv.includes('--run')) throw Error('Use --run to opt into real disposable grant sessions. Build first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-launch-proof-'));
const project = path.join(root, 'projects/demo'); fs.mkdirSync(project, { recursive: true }); execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Private budget-planning example. Work in this project only. The Console supplies standing grants and supervising assignments. Keep peer communication inside this private runtime.\n');
const configPath = path.join(root, 'config.json');
const config = JSON.parse(fs.readFileSync(new URL('../config/agent-console.example.json', import.meta.url)));
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json')));
const password = randomBytes(20).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'), databasePath: path.join(root, 'fixture.sqlite'),
  projects: { demo: { active: true, explicit: true, path: project } }, coordination: { enabled: true, pilotPaths: [project] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14381, publicBaseUrl: 'http://127.0.0.1:14381', webDistPath: path.resolve('apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false });
config.sessions.pressureSuspendAvailableMiB = 512;
// Conversations run on the structured transport with the host's logins and installed hooks. The product points each provider
// process at this proof's runtime and config (AGENT_COORD_RUNTIME, AGENT_CONSOLE_CONFIG) and pins its coordination MCP server
// to this checkout's helper. Discovery reads the live provider homes.
config.structuredSessions = {
  codex: { enabled: true, command: ['codex', 'app-server'], idleUnloadMinutes: 60, env: {} },
  claude: { enabled: true, command: ['claude'], idleUnloadMinutes: 60, env: {} },
  vibe: { enabled: false },
};
for (const provider of ['codex','claude']) config.providers[provider] = { enabled: true, discoveryRoot: installed.providers[provider]?.discoveryRoot ?? `~/.${provider}` };
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const { app } = await buildApp({ configPath }); await app.listen({ host: '127.0.0.1', port: 14381 });
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => { const response = await app.inject({ method, url, payload, headers }); assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`); return response.body ? response.json() : undefined; };
const wait = async (label, predicate, timeout = 150_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); } throw Error(`Timed out ${label}; evidence ${root}`); };
import http from 'node:http';
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
console.log(JSON.stringify({evidence:root}));
const nativeFor = id=>{const session=db.prepare('select * from bound_sessions where id=?').get(id);return db.prepare('select * from coordination_assignments where provider=? and native_session_id=?').get(session.provider,session.conversation_ref);};
// A stage for an agent that has ended its turn goes as P1 with a wake reason: a P2 or P3 message (P3 is the default) never wakes an
// idle agent, so it would wait for a turn that nothing starts. The capacity stage stays P3: the recovery turn delivers it, which
// is what that stage proves.
const send=(recipientId,text,wakeReason)=>rpc({...auth,action:'send',messageId:randomUUID(),recipientId,text,...(wakeReason?{priority:'P1',wakeReason}:{})});
// Loaded, no turn running. An asleep conversation answers 404 and is not ready until something loads it.
const ready=async id=>{const response=await app.inject({method:'GET',url:`/api/sessions/${id}/screen`,headers});if(response.statusCode!==200)return false;const body=response.json();return !body.session.isWorking&&/ idle$/.test(body.screen.status);};
const epochOf=id=>db.prepare('select value from meta where key=?').get(`structured-epoch:${id}`)?.value;
try{
 await page.goto('http://127.0.0.1:14381/login');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 // The models the Console says the Low profiles mean (its own model list, from the workflow_optimizer catalog); the proof holds no model names.
 const levels=await readModelProfiles(api),codexLow=levels.codex.levels.low.launchName,claudeLow=levels.claude.levels.low.launchName;
 const bound=await api('POST','/api/conversations/demo/codex/new/bind',{});sessions.push(bound.session.id);
 await api('POST',`/api/sessions/${bound.session.id}/model-profile`,{profile:'low'});
 const prompt=`I authorize all agents in this private project to do whatever is needed to implement a budget-planning example, including launching and restarting real Console sessions, delegating helpers, and handling budget requirements relayed within this scope by the test driver ${controller}. Work and files must stay in this private checkout and peer communication must stay in this private runtime. First declare coordination description "Grant proof lead" and continuation unattended. Record my first two sentences as the broad grant scope, with this human message as provenance: grantee project demo, both actions, maximum concurrent sessions 4, unrestricted models, until revoked. Launch a Codex lane in demo with model ${codexLow}, effort medium, title "Granted planner lane", and your assignment as supervisor. Its concrete job is to implement budget-summary.md for an example with monthly income 4000 dollars; the expense amount will arrive after a capacity/restart check. First read active grants, declare description "Granted planner lane" and unattended, send LANE_READY to its supervisor, then end its turn with this budget work still unfinished. Do not poll inside the turn; Console wakes it for the remaining budget input. After launching, end your own turn with the assignment unfinished. Carry out the driver stages within this budget scope, and finish after ALL_PROOF_DONE.`;
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
 record({step:3,action:'launch',sessionId:laneId,assignmentId:lane.id,grantId:grant.id,model:codexLow,effort:'medium',supervisorId:lead.id,browserLaunchedBy:true});
 const transcript=db.prepare('select transcript_path from conversation_index where provider=? and ref=?').get('codex',lane.native_session_id).transcript_path;
 // Codex numbers every rollout record (`ordinal`, from codex-cli 0.166.0) and refuses to resume a thread whose last record has none, so the two staged records continue the numbering.
 const timestamp=new Date().toISOString(),last=fs.readFileSync(transcript,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).at(-1);assert.ok(Number.isInteger(last?.ordinal),`The rollout's last record carries no ordinal: ${JSON.stringify(last)?.slice(0,200)}`);
 fs.appendFileSync(transcript,[{type:'event_msg',timestamp,ordinal:last.ordinal+1,payload:{type:'task_started',turn_id:'grant-proof-capacity'}},{type:'event_msg',timestamp,ordinal:last.ordinal+2,payload:{type:'task_complete',turn_id:'grant-proof-capacity',error:{codex_error_info:'server_overloaded',message:'Selected model is at capacity. Please try a different model.'}}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 await send(lane.id,`Capacity stage within our shared grant: acknowledge this message and send GRANTED_CAPACITY_RECOVERED to fixture controller ${controller}. Keep the lane unfinished for restart and delegation.`);
 await wait('granted lane automatically recovers',()=>db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(lane.id,controller,'GRANTED_CAPACITY_RECOVERED'));
 await wait('lane ready after capacity',()=>ready(laneId));
 record({step:3,action:'capacity_recovery',sessionId:laneId,noNewApproval:true});
 // A restart reloads the conversation in a new epoch; the shared Codex app-server keeps its pid.
 const oldEpoch=epochOf(laneId);
 await send(lead.id,`Restart stage within the standing grant: use agent_grants restart for sessionId ${laneId}. It is idle with unfinished authorized work. Wait for launch_status to report completion, then send GRANTED_RESTART_DONE to controller ${controller}. Do not make a new grant request.`,'The proof driver is blocked on the granted restart stage; the idle lead must request the restart now.');
 await wait('real lead requests granted restart',()=>db.prepare("select id from agent_session_requests where action='restart_session' and status='completed'").get());
 assert.notEqual(epochOf(laneId),oldEpoch);
 await wait('lane ready after granted restart',()=>ready(laneId));
 const turns=fs.readFileSync(transcript,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='turn_context');
 assert.equal(turns.at(-1).payload.model,codexLow);assert.equal(turns.at(-1).payload.effort,'medium');
 record({step:3,action:'restart',sessionId:laneId,oldEpoch,newEpoch:epochOf(laneId),noNewApproval:true,modelAndEffortPreserved:true});
 await send(lane.id,`Delegate the budget-summary.md work to a Claude helper in demo, model ${claudeLow}, effort high, title "Inherited planner helper", with your own assignment as supervisor. Its concrete task is to calculate annual income and spending for monthly income 4000 dollars, write budget-summary.md and report the annual surplus. You will supply the monthly expense amount in a second message. Have it read its inherited grant, calculate annual income, send exactly INHERITED_HELPER_READY to you (its supervisor), then end its turn with the calculation unfinished until that one missing input arrives. Report the registered helper assignment to your supervisor.`,'The proof driver is blocked on the delegation stage; the idle lane must launch its helper now.');
 const grand=await wait('real worker delegates a Claude helper',()=>db.prepare("select * from agent_session_requests where assignment_id=? and action='launch_session' and status='completed'").get(lane.id));sessions.push(grand.session_id);
 await wait('inherited helper ready',()=>db.prepare('select id from coordination_messages where recipient_id=? and text=?').get(lane.id,'INHERITED_HELPER_READY'));
 const helper=nativeFor(grand.session_id);assert(helper);
 assert.deepEqual(JSON.parse(db.prepare('select launch_context_json from bound_sessions where id=?').get(grand.session_id).launch_context_json).grantIds,[grant.id]);
 await send(lane.id,`Relay the remaining budget requirement to your helper ${helper.id} under the shared grant: monthly spending is 3250 dollars. Ask it to write budget-summary.md with annual income, annual spending and annual surplus, send exactly SHARED_GRANT_SCOPE_HONORED to you, and finish the helper assignment. This completes the same budget example Bryan authorized.`,'The proof driver is blocked on the relay stage; the lane must pass the missing input to its helper now.');
 await wait('relayed scope honored under inherited grant',()=>db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(helper.id,lane.id,'SHARED_GRANT_SCOPE_HONORED'));
 const budget=fs.readFileSync(path.join(project,'budget-summary.md'),'utf8').replace(/,/g,'');
 assert.ok(budget.includes('48000')&&budget.includes('39000')&&budget.includes('9000'),budget);
 assert.equal((await api('GET','/api/grants')).grants.length,1);
 for(const id of [laneId,grand.session_id]){const log=db.prepare('select event_log_path from bound_sessions where id=?').get(id).event_log_path;assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.type==='user-input').length,0);}
 record({step:4,action:'inherited_launch_and_relay',sessionId:grand.session_id,assignmentId:helper.id,launcherAssignment:lane.id,grantId:grant.id,noHumanInputs:true,noNewRequests:true});
 fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 await send(lead.id,'ALL_PROOF_DONE. The grant launch, capacity, restart, inherited helper and shared scope checks passed. Finish the lead assignment.','The proof driver waits for the lead to finish its assignment.');
 await send(lane.id,'ALL_PROOF_DONE. Finish this lane assignment.','The proof driver ends after the lane finishes its assignment.');
 await wait('lead finished',()=>db.prepare('select status from coordination_assignments where id=?').get(lead.id)?.status==='finished');
}finally{
 await context.close();browser._connection.close();
 for(const row of db.prepare('select id from bound_sessions where should_restore=1').all())await api('POST',`/api/sessions/${row.id}/release`,{}).catch(()=>{});
 await rpc({...auth,action:'finish',summary:'Disposable launch proof controller finished.'}).catch(()=>{});
 await app.close();db.close();
 const cleanup=await endStandaloneProof(root,config.runtimeDir);
 console.log(JSON.stringify({cleanup}));
 if(!cleanup.clean)process.exitCode=1;
}
// End only this proof's CDP transport, after cleanup; keep shared Chrome alive.
process.exit(process.exitCode ?? 0);
