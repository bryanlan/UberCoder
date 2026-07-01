import { RealtimeEventBus } from '../../src/realtime/event-bus.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import type { TmuxClient } from '../../src/sessions/tmux-client.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import type { ActiveProject } from '../../src/projects/project-service.js';
import type { MergedProviderSettings } from '../../src/config/service.js';
import { AppDatabase } from '../../src/db/database.js';

export class FakeTmux implements TmuxClient {
  created: string[] = [];
  createdCommands: string[] = [];
  sent: string[] = [];
  pasted: string[] = [];
  sentKeys: string[][] = [];
  alive = new Set<string>();
  failPipePane = false;
  failKill = false;
  paneText = '';
  captureSequence: string[] = [];
  captureStartLines: Array<number | undefined> = [];
  options: Array<{ sessionName: string; name: string; value: string }> = [];
  hasSessionResults: Array<boolean | Error> = [];

  async newDetachedSession(sessionName: string, _cwd: string, shellCommand: string): Promise<void> {
    this.created.push(sessionName);
    this.createdCommands.push(shellCommand);
    this.alive.add(sessionName);
  }
  async pipePaneToFile(): Promise<void> {
    if (this.failPipePane) {
      throw new Error('pipe-pane failed');
    }
  }
  async sendLiteralText(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
  async pasteText(_sessionName: string, text: string): Promise<void> {
    this.pasted.push(text);
    this.sent.push(text);
  }
  async sendKeys(_sessionName: string, keys: string[]): Promise<void> { this.sentKeys.push(keys); }
  async capturePane(_sessionName?: string, startLine?: number): Promise<string> {
    this.captureStartLines.push(startLine);
    if (this.captureSequence.length > 0) {
      const next = this.captureSequence.shift();
      if (next !== undefined) {
        this.paneText = next;
      }
    }
    return this.paneText;
  }
  async interrupt(): Promise<void> {}
  async killSession(sessionName: string): Promise<void> {
    if (this.failKill) {
      throw new Error('kill failed');
    }
    this.alive.delete(sessionName);
  }
  async hasSession(sessionName: string): Promise<boolean> {
    const next = this.hasSessionResults.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next !== undefined) {
      return next;
    }
    return this.alive.has(sessionName);
  }
  async getPanePid(): Promise<number | undefined> { return 4242; }
  async setOption(sessionName: string, name: string, value: string): Promise<void> {
    this.options.push({ sessionName, name, value });
  }
}

export const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/srv/demo',
  path: '/srv/demo',
  matchPaths: ['/srv/demo'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

export const provider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return []; },
  async getConversation() { return null; },
  getLaunchCommand(_project, _conversationRef, _settings, options) {
    return {
      cwd: '/srv/demo',
      argv: ['codex', ...(options?.initialPrompt ? [options.initialPrompt] : [])],
      env: {},
    };
  },
};

export const claudeProvider: ProviderAdapter = {
  ...provider,
  id: 'claude',
};

export const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/home/user/.codex',
  commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
} satisfies MergedProviderSettings;

export function createRecoveryManager(
  db: AppDatabase,
  tmux: TmuxClient,
  runtimeDir: string,
  eventBus = new RealtimeEventBus(),
  recoveryProvider: ProviderAdapter = provider,
  recoveryProviderSettings: MergedProviderSettings = providerSettings,
): SessionManager {
  return new SessionManager(db, tmux, runtimeDir, eventBus, {
    projectService: {
      getProjectBySlug: async (slug: string) => slug === project.slug ? project : undefined,
      getMergedProviderSettings: () => recoveryProviderSettings,
    },
    providerRegistry: {
      get: () => recoveryProvider,
    },
  });
}
