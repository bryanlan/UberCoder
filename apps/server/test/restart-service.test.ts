import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { RestartService } from '../src/runtime/restart-service.js';
import { buildApp } from '../src/app.js';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
});

function mockProcess() {
  vi.useFakeTimers();
  vi.stubEnv('SYSTEMD_EXEC_PID', '');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, error };
}

it('waits for complete shutdown before spawning a manual replacement and exiting', async () => {
  const { exit } = mockProcess();
  let close!: () => void;
  const closing = new Promise<void>((resolve) => { close = resolve; });
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const restart = new RestartService(() => closing);
  expect(restart.scheduleRestart()).toBe(true);
  expect(restart.scheduleRestart()).toBe(false);
  await vi.advanceTimersByTimeAsync(150);
  expect(spawn).not.toHaveBeenCalled();
  close(); await Promise.resolve();
  expect(spawn).toHaveBeenCalledWith(process.execPath, [...process.execArgv, ...process.argv.slice(1)], expect.objectContaining({ detached: true }));
  expect(exit).not.toHaveBeenCalled();
  child.emit('spawn'); await Promise.resolve();
  expect(child.unref).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(0);
});

it('lets systemd restart its main process without creating a competing child', async () => {
  const { exit } = mockProcess();
  vi.stubEnv('SYSTEMD_EXEC_PID', String(process.pid));
  const close = vi.fn().mockResolvedValue(undefined);
  new RestartService(close).scheduleRestart();
  await vi.advanceTimersByTimeAsync(150);
  expect(close).toHaveBeenCalledOnce();
  expect(spawn).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(0);
});

it('reports an asynchronous spawn failure instead of claiming a successful restart', async () => {
  const { exit, error } = mockProcess();
  vi.stubEnv('SYSTEMD_EXEC_PID', String(process.pid + 1));
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
  new RestartService(async () => {}).scheduleRestart();
  await vi.advanceTimersByTimeAsync(150);
  child.emit('error', new Error('spawn failed')); await Promise.resolve();
  expect(error).toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(1);
});

it('does not start a replacement when shutdown fails', async () => {
  const { exit } = mockProcess();
  new RestartService(async () => { throw new Error('close failed'); }).scheduleRestart();
  await vi.advanceTimersByTimeAsync(150);
  expect(spawn).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(1);
});

it('closes a real browser event stream and releases the coordination socket for replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-restart-test-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, 'projects'); fs.mkdirSync(projectsRoot);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projectsRoot, runtimeDir: root, databasePath: path.join(root, 'state.sqlite'),
    server: { webDistPath: path.join(root, 'no-web-assets') },
    coordination: { enabled: true, pilotPaths: [] },
    security: { passwordHash: 'unused', sessionSecret: 's'.repeat(64), trustTailscaleHeaders: true, tailscaleAllowedUserLogin: 'review@example.invalid' },
    providers: Object.fromEntries(['codex', 'claude'].map((provider) => [provider, {
      enabled: false, discoveryRoot: path.join(root, provider), commands: { newCommand: ['false'], resumeCommand: ['false'] },
    }])),
    projects: {},
  }));
  const { app } = await buildApp({ configPath });
  cleanups.push(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const before = await app.inject('/api/health');
  expect(before.headers['access-control-allow-origin']).toBe('*');
  expect(before.headers['cache-control']).toBe('no-store');
  expect(before.json().instanceId).toBeTypeOf('string');
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(`${address}/api/events`, { headers: { 'tailscale-user-login': 'review@example.invalid' } }, resolve);
    request.on('error', reject);
  });
  cleanups.push(() => { response.destroy(); });
  expect(response.statusCode).toBe(200);
  await once(response, 'data');
  const closed = new Promise<void>((resolve) => response.once('close', resolve));
  await app.close();
  await closed;
  const replacement = await buildApp({ configPath });
  cleanups.push(() => replacement.app.close());
  await replacement.app.listen({ host: '127.0.0.1', port: 0 });
  const after = await replacement.app.inject('/api/health');
  expect(after.json().instanceId).not.toBe(before.json().instanceId);
  expect(replacement.app.server.listening).toBe(true);
});
