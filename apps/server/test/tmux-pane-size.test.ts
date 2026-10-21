import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { CONSOLE_PANE_COLUMNS, CONSOLE_PANE_ROWS } from '../src/sessions/tmux-client.js';
import { FakeTmux, project, provider, providerSettings } from './helpers/session-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

class SizingTmux extends FakeTmux {
  sizes: Array<{ sessionName: string; columns: number; rows: number }> = [];
  override async ensureMinimumWindowSize(sessionName: string, columns: number, rows: number): Promise<boolean> {
    this.sizes.push({ sessionName, columns, rows });
    return true;
  }
}

describe('hidden tmux pane size', () => {
  it('gives each native process a composer-sized pane once, without repeated resize repaint', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-pane-size-'));
    const db = new AppDatabase(path.join(directory, 'console.sqlite'));
    const tmux = new SizingTmux();
    tmux.paneText = 'OpenAI Codex\n\n› \n  gpt-6.1-sol xhigh · 65% left · ~/demo';
    const manager = new SessionManager(db, tmux, path.join(directory, 'runtime'), new RealtimeEventBus());
    cleanups.push(async () => { await manager.stop(); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: 'pane-size', title: 'Size', kind: 'history' });
    await manager.reconcileSessions();
    await manager.reconcileSessions();
    expect(tmux.sizes).toEqual([{ sessionName: session.tmuxSessionName, columns: CONSOLE_PANE_COLUMNS, rows: CONSOLE_PANE_ROWS }]);
    expect(CONSOLE_PANE_ROWS).toBeGreaterThanOrEqual(48);
  });
});
