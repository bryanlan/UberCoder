import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PEER_WAKE_PROMPT, queueCodexPeerWake } from '../src/coordination/wake.js';
import { providerSettings } from './helpers/session-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('queues using the configured Codex executable, working directory and merged environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-wake-transport-'));
  roots.push(root);
  const executable = path.join(root, 'project-codex');
  const log = path.join(root, 'queue.json');
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FIXTURE_LOG_PATH, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.CODEX_HOME,inherited:process.env.FIXTURE_INHERITED}));\n`, { mode: 0o700 });
  // An isolated rejecting executable prevents the old bare command from
  // contacting any real provider while proving the configured one is used.
  fs.writeFileSync(path.join(root, 'codex'), `#!${process.execPath}\nprocess.exit(42);\n`, { mode: 0o700 });
  vi.stubEnv('PATH', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'wrong-home'));
  vi.stubEnv('FIXTURE_INHERITED', 'inherited-value');
  const native = randomUUID();
  const settings = { ...providerSettings, commands: { ...providerSettings.commands,
    resumeCommand: [executable, 'resume', '{{conversationId}}'],
    env: { CODEX_HOME: path.join(root, 'project-home'), FIXTURE_LOG_PATH: log } } };
  await queueCodexPeerWake(native, settings, root);
  expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual({
    argv: ['queue', '--thread', native, '--message', PEER_WAKE_PROMPT], cwd: root,
    home: path.join(root, 'project-home'), inherited: 'inherited-value',
  });
});
