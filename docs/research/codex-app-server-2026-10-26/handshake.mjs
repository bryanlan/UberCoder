// Throwaway codex app-server handshake probe. No thread/start, no turn/start, no thread/resume.
// Usage: node handshake.mjs > handshake.out.txt
import { spawn } from "node:child_process";

const t0 = Date.now();
const log = (dir, obj) => {
  const ts = String(Date.now() - t0).padStart(6, " ");
  process.stdout.write(`${ts}ms ${dir} ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
};

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
log("SPAWN", { pid: child.pid, argv: ["codex", "app-server"] });

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("<<RAW", line); continue; }
    // Redact: config/read (may hold MCP env secrets) and large results are reduced to key lists; emails masked.
    // config/read (id 8) is reduced to its key list; other large lines are truncated to 3000 chars.
    const scrub = (t) => t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>");
    if (msg.id === 8 && msg.result) {
      log("<<", { id: 8, result: `[${line.length} bytes elided; keys=${Object.keys(msg.result).join(",")}]` });
    } else if (line.length > 3000) {
      log("<<", scrub(line.slice(0, 3000)) + ` ...[truncated; ${line.length} bytes total]`);
    } else {
      log("<<", JSON.parse(scrub(JSON.stringify(msg))));
    }
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (c) => log("STDERR", c.toString("utf8").trimEnd()));
child.on("exit", (code, signal) => log("EXIT", { code, signal }));

const send = (msg) => { log(">>", msg); child.stdin.write(JSON.stringify(msg) + "\n"); };
const request = (id, method, params, timeoutMs = 15000) => new Promise((resolve) => {
  const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  send(params === undefined ? { id, method } : { id, method, params });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Request before initialize (expect rejection).
await request(0, "model/list", {});
// 2. initialize
const init = await request(1, "initialize", {
  clientInfo: { name: "agent_console_probe", title: "Agent Console probe", version: "0.0.1" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
// 3. any notifications that arrive before `initialized`
await wait(1000);
// 4. duplicate initialize (expect rejection)
await request(2, "initialize", {
  clientInfo: { name: "agent_console_probe", title: null, version: "0.0.1" },
  capabilities: null,
});
// 5. initialized notification
send({ method: "initialized" });
await wait(1500);
// 6. read-only calls (no model calls, no thread load)
await request(3, "model/list", { limit: 3 });
await request(4, "account/read", {});
const list = await request(5, "thread/list", { limit: 10, useStateDbOnly: true });
await request(6, "thread/loaded/list", {});
await request(7, "hooks/list", { cwds: ["/home/bryan/code/UberCoder/agent-console-mvp/agent-console"] });
await request(8, "config/read", { includeLayers: false, cwd: "/home/bryan/code/UberCoder/agent-console-mvp/agent-console" });
await request(9, "turn/steer", { threadId: "00000000-0000-0000-0000-000000000000", input: [{ type: "text", text: "x", text_elements: [] }], expectedTurnId: "nope" });
await request(10, "thread/read", { threadId: "00000000-0000-0000-0000-000000000000", includeTurns: false });
await request(11, "no/such/method", {});
// Read-only history reads on an idle stored thread (no resume, no load).
const nowSec = Date.now() / 1000;
const idle = (list.result?.data ?? []).find((t) => t.status?.type === "notLoaded" && nowSec - t.updatedAt > 7200);
if (idle) {
  log("NOTE", `idle thread picked for read-only history calls: ${idle.id}`);
  await request(13, "thread/read", { threadId: idle.id, includeTurns: false });
  await request(14, "thread/turns/list", { threadId: idle.id, limit: 1, sortDirection: "desc", itemsView: "summary" });
  await request(15, "thread/items/list", { threadId: idle.id, limit: 2, sortDirection: "desc" });
  await request(17, "thread/loaded/list", {});
}
await request(16, "account/rateLimits/read", { excludeResetCreditDetails: true });
await wait(500);
// 7. close stdin and see whether the process exits on its own
log("CLOSE_STDIN", "");
child.stdin.end();
const exited = await Promise.race([
  new Promise((r) => child.once("exit", () => r(true))),
  wait(5000).then(() => false),
]);
if (!exited) { log("KILL", "SIGTERM after 5s with stdin closed"); child.kill("SIGTERM"); await wait(1000); }
process.exit(0);
