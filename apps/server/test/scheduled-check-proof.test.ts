// Opt-in: two real account-authenticated checker runs; the lead is a scripted structured session.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fastify from 'fastify';
import { expect, it } from 'vitest';
import type { NormalizedMessage } from '@agent-console/shared';
import { registerPersonMessageRoutes } from '../src/routes/person-message.js';
import { LiveOutputReader } from '../src/sessions/live-output/reader.js';
import { CoordinationService } from '../src/coordination/service.js';
import { structuredSessionFixture, settle } from './helpers/structured-session-fixture.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';

it.skipIf(process.env.LEAD_CHECK_REAL_PROOF !== '1')('runs low and real checkers against an isolated throwaway lead', async () => {
  const checkout = path.resolve('../..');
  const evidence = process.env.LEAD_CHECK_EVIDENCE!;
  if (!evidence || !path.isAbsolute(evidence)) throw new Error('Set LEAD_CHECK_EVIDENCE to a private absolute path.');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const messages: NormalizedMessage[] = [];
  const adapter = { ...provider, getConversation: async () => ({ summary: { ref: 'proof' }, messages }) };
  const f = structuredSessionFixture({ provider: adapter as never });
  const app = fastify({ logger: false });
  const delivered: string[] = [];
  try {
    const { session } = await f.bindNew();
    const coordination = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    const assignment = coordination.register({ provider: 'codex', nativeSessionId: session.conversationRef,
      token: randomUUID(), pid: process.pid, cwd: checkout }).assignmentId!;
    coordination.update(assignment, { description: 'Milestone work is progressing. The shared page is ready for review.' });
    fs.writeFileSync(path.join(f.root, 'person-message.key'), randomBytes(32).toString('hex'), { mode: 0o600 });
    registerPersonMessageRoutes(app, f.root, f.manager,
      { getProjectBySlug: async () => project, getMergedProviderSettings: () => providerSettings } as never,
      { get: () => adapter } as never, new LiveOutputReader(), f.db);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const thread = f.thread(session.conversationRef);
    const original = thread.sendTurn.bind(thread);
    const accept = (text: string) => {
      delivered.push(text);
      messages.push({ id: randomUUID(), provider: 'codex', conversationRef: session.conversationRef,
        role: 'user', text, timestamp: new Date().toISOString(), lifecycle: 'durable', source: 'history-file' });
      setTimeout(() => {
        const reply = text.includes('milestones') || text.includes('progress')
          ? 'I am tracking the agreed milestones and making forward progress. I am not spending time on minor validation. The shared household page can be opened now; it last changed today. No approval is needed. I will keep going on the agreed milestones.'
          : 'I will keep moving on the agreed milestones and show the next usable page. No need to log this.';
        messages.push({ id: randomUUID(), provider: 'codex', conversationRef: session.conversationRef,
          role: 'assistant', text: reply, timestamp: new Date().toISOString(), lifecycle: 'durable', source: 'history-file' });
        if (thread.activeTurnId) thread.completeTurn();
      }, 50);
    };
    thread.sendTurn = async input => { const value = await original(input); accept(input.text); return value; };
    const steer = thread.steer.bind(thread);
    thread.steer = async (turnId, input) => { await steer(turnId, input); accept(input.text); };
    // Begin with a running turn, proving the check does not take its existing text as the answer.
    await original({ text: 'A turn already in progress' });
    messages.push({ id: randomUUID(), provider: 'codex', conversationRef: session.conversationRef,
      role: 'assistant', text: 'Earlier text from the existing turn.', timestamp: new Date().toISOString(), lifecycle: 'durable', source: 'history-file' });
    await settle();
    const results: unknown[] = [];
    for (const mode of ['low', 'real']) {
      const cfg = JSON.parse(fs.readFileSync(path.join(checkout, 'config/lead-check.example.json'), 'utf8'));
      Object.assign(cfg, { console_url: address, console_db: path.join(f.root, 'state.sqlite'), lead_session: session.id,
        lead_assignment: assignment, credential_file: path.join(f.root, 'person-message.key'), records: path.join(evidence, mode),
        reply_timeout_sec: 15, poll_sec: 0.1, checker_timeout_sec: 600 });
      const cfgPath = path.join(evidence, mode + '.json');
      fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
      const args = [path.join(checkout, 'scripts/lead-check-runner.py'), '--config', cfgPath, '--execute', ...(mode === 'low' ? ['--plumbing'] : [])];
      const invoke = () => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn('/usr/bin/python3', args, { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout: stdout + (stderr ? '\n[stderr retained]' : '') }));
      });
      const before = delivered.length;
      const result = await invoke();
      results.push({ mode, ...result });
      fs.writeFileSync(path.join(evidence, 'proof-result.json'), JSON.stringify({ results, delivered: delivered.length }, null, 2));
      expect(result.code, result.stdout).toBe(0);
      expect(delivered.length - before).toBe(2);
      expect(delivered.slice(before).every(text => text.startsWith('Bryan: '))).toBe(true);
      const entries = fs.readdirSync(cfg.records).filter((name: string) => name.endsWith('.json'));
      const record = JSON.parse(fs.readFileSync(path.join(cfg.records, entries[0]!), 'utf8'));
      expect(record.status).toBe('updated'); expect(record.pack_bytes).toBeLessThanOrEqual(8000);
      const rounds = JSON.parse(fs.readFileSync(path.join(record.evidence, 'exchange.json'), 'utf8'));
      expect(rounds.every((round: { reply: string }) => round.reply && round.reply !== 'no answer')).toBe(true);
      expect(rounds[0].reply).not.toBe('Earlier text from the existing turn.');
      expect(fs.readFileSync(path.join(cfg.records, 'LINES.md'), 'utf8')).toContain(record.line);
      const skipped = await invoke();
      expect(skipped.stdout).toContain('no new lead turn');
    }
  } finally { await app.close(); await f.cleanup(); }
}, 1500000);
