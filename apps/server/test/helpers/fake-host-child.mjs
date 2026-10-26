#!/usr/bin/env node
// A scriptable provider child for the session host tests: reads one JSON command per line from stdin and answers on
// stdout.
//
//   node fake-host-child.mjs <log-file> [--ignore-eof] [--ignore-term] [--chatty <ms>] [--grandchild] [--banner]
//
//   --grandchild   start a `sleep 300` in the child's process group (an MCP server or background shell) and log its pid
//   --banner       write {"banner":"hello"} on stdout right at start, before any client could have written
//
//   {"cmd":"echo","text":"x"}              writes {"echo":"x"}
//   {"cmd":"burst","count":n,"bytes":m}    writes n lines of m bytes: {"burst":i,"pad":"xxxx"}
//   {"cmd":"big","bytes":m}                writes ONE line of about m bytes
//   {"cmd":"env"}                          writes {"env":{...},"cwd":...,"pid":...,"ppid":...}
//   {"cmd":"stderr","text":"x"}            writes x to stderr
//   {"cmd":"exit","code":n}                exits with that code
//   {"cmd":"signal","name":"SIGKILL"}      kills itself with that signal
// Events are appended to the log file as JSON: start (pid, ppid), stdin-eof, sigterm, command.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const [logFile, ...flags] = process.argv.slice(2);
const log = (entry) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
const ignoreEof = flags.includes('--ignore-eof');
const ignoreTerm = flags.includes('--ignore-term');
const grandchild = flags.includes('--grandchild');
const banner = flags.includes('--banner');
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.on('SIGTERM', () => {
  log({ event: 'sigterm' });
  if (!ignoreTerm) process.exit(143);
});
if (ignoreEof || ignoreTerm) setInterval(() => undefined, 1_000);
if (grandchild) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  child.unref();
  log({ event: 'grandchild', pid: child.pid });
}
if (banner) write({ banner: 'hello' });
// Logged last: once `start` is in the log, the SIGTERM handler above is in place.
log({ event: 'start', pid: process.pid, ppid: process.ppid });

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  log({ event: 'command', cmd: command.cmd });
  switch (command.cmd) {
    case 'echo': write({ echo: command.text }); break;
    case 'burst':
      for (let index = 0; index < command.count; index += 1) write({ burst: index, pad: 'x'.repeat(command.bytes ?? 0) });
      break;
    case 'big': write({ big: 'y'.repeat(command.bytes) }); break;
    case 'env': write({ env: process.env, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2) }); break;
    case 'stderr': process.stderr.write(command.text); break;
    case 'exit': process.stdout.write('', () => process.exit(command.code ?? 0)); break;
    case 'signal': process.kill(process.pid, command.name); break;
    default: write({ unknown: command.cmd });
  }
});
process.stdin.on('end', () => {
  log({ event: 'stdin-eof' });
  if (!ignoreEof) process.exit(0);
});
