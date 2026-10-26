// Usage: node probe.mjs <outfile> <stepsJSON> -- <claude args...>
// Steps: {"write":obj} | {"waitFor":{"type":..,"subtype":..}, "timeoutMs":n} | {"sleep":ms} | {"end":true} | {"signal":"SIGTERM"}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [outfile, stepsJson, sep, ...args] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const t0 = Date.now();
const log = [];
const rec = (kind, data) => log.push({ t: Date.now() - t0, kind, data });
const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_|AGENT_)/.test(k) && k !== 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS') delete env[k];
if (process.env.PROBE_ACS) env.AGENT_CONSOLE_SESSION_ID = process.env.PROBE_ACS;
if (process.env.PROBE_EXTRA_ENV) Object.assign(env, JSON.parse(process.env.PROBE_EXTRA_ENV));
const child = spawn('/home/bryan/.local/bin/claude', args, { cwd: process.env.PROBE_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
rec('spawn', { pid: child.pid, args });
let buf = ''; const msgs = []; const waiters = [];
let maxRss = 0;
const rssTimer = setInterval(() => { try { const s = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8'); const m = s.match(/VmRSS:\s+(\d+)/); if (m) maxRss = Math.max(maxRss, +m[1]); } catch {} }, 100);
child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { rec('stdout-nonjson', line); continue; } rec('out', o); msgs.push(o); for (const w of [...waiters]) if (w.match(o)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(o); } } });
let stderr = ''; child.stderr.on('data', d => { stderr += d; });
child.stdin.on('error', e => rec('stdin-error', String(e.code || e.message)));
const exited = new Promise(r => child.on('exit', (code, signal) => { rec('exit', { code, signal }); r(); }));
const matches = (pat) => (o) => Object.entries(pat).every(([k, v]) => k === 'request_subtype' ? o?.request?.subtype === v : k === 'response_subtype' ? o?.response?.subtype === v : o?.[k] === v);
for (const s of steps) {
  if (s.write) { rec('in', s.write); child.stdin.write(JSON.stringify(s.write) + '\n'); }
  else if (s.waitFor) { const m = matches(s.waitFor); const hit = msgs.find(m); if (!hit) await Promise.race([new Promise(r => waiters.push({ match: m, resolve: r })), new Promise(r => setTimeout(() => { rec('timeout', s.waitFor); r(); }, s.timeoutMs ?? 20000)), exited]); }
  else if (s.sleep) await new Promise(r => setTimeout(r, s.sleep));
  else if (s.end) { rec('stdin-end', null); child.stdin.end(); }
  else if (s.signal) { rec('signal', s.signal); child.kill(s.signal); }
  else if (s.ls) { const walk = (d) => { let out = []; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = d + '/' + e.name; if (e.isDirectory()) out = out.concat(walk(f)); else out.push(f.slice(s.ls.length) + ' ' + fs.statSync(f).size); } } catch {} return out; }; rec('ls', walk(s.ls)); }
  else if (s.cat) { try { rec('cat', fs.readFileSync(s.cat, 'utf8').slice(0, 20000)); } catch (e) { rec('cat-error', String(e)); } }
}
await Promise.race([exited, new Promise(r => setTimeout(() => { rec('still-running-kill', null); child.kill('SIGKILL'); r(); }, 15000))]);
await exited; clearInterval(rssTimer);
rec('stderr', stderr.slice(-4000)); rec('maxRssKb', maxRss);
fs.writeFileSync(outfile, log.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log(`wrote ${outfile}: ${log.length} records, exit ${JSON.stringify(log.find(x=>x.kind==='exit')?.data)}, maxRssKb ${maxRss}`);
