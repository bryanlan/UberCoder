#!/usr/bin/env node
// A stand-in for the npm `codex` launcher (`@openai/codex/bin/codex.js`): a Node process that runs the real server
// as its child with inherited stdio, forwards SIGINT/SIGTERM/SIGHUP to it and exits when the child exits. A signal
// sent to this process alone therefore does not end a child that ignores the forwarded SIGTERM.
//
//   node fake-launcher.mjs <fake-app-server.mjs> <scenario.json>
import { spawn } from 'node:child_process';

const [server, scenario] = process.argv.slice(2);
const child = spawn(process.execPath, [server, scenario], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
