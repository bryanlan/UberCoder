import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, NormalizedMessage } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import {
  buildCodexSummaryChildEnv,
  buildCodexSummaryCommandArgs,
  SessionSummaryService,
  type SessionSummaryModelInput,
} from '../src/summaries/session-summary-service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/tmp/demo',
  path: '/tmp/demo',
  matchPaths: ['/tmp/demo'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: true, path: '/tmp/demo', displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const providerSettings: MergedProviderSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/tmp/codex',
  commands: {
    newCommand: ['codex'],
    resumeCommand: ['codex', 'resume', '{{conversationId}}'],
    continueCommand: ['codex', 'resume', '--last'],
    env: { CODEX_HOME: '/tmp/codex' },
  },
};

function message(input: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'role' | 'text' | 'timestamp'>): NormalizedMessage {
  return {
    id: `${input.role}:${input.timestamp}:${input.text}`,
    provider: 'codex',
    conversationRef: 'conversation-1',
    lifecycle: 'durable',
    source: 'history-file',
    ...input,
  };
}

describe('SessionSummaryService', () => {
  it('builds the Codex exec command with the requested model, medium reasoning, and read-only sandbox', () => {
    expect(buildCodexSummaryCommandArgs({
      projectPath: '/tmp/project',
      schemaPath: '/tmp/schema.json',
      outputPath: '/tmp/output.json',
    })).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-m',
      'gpt-5.3-codex-spark',
      '-c',
      'model_reasoning_effort="medium"',
      '-s',
      'read-only',
      '-C',
      '/tmp/project',
      '--output-schema',
      '/tmp/schema.json',
      '-o',
      '/tmp/output.json',
      '-',
    ]);
  });

  it('keeps the service PATH when project Codex env overrides PATH', () => {
    const childEnv = buildCodexSummaryChildEnv(
      { CODEX_HOME: '/tmp/codex', PATH: '/project/bin' },
      { HOME: '/home/bryan', PATH: '/service/node/bin:/usr/bin' },
    );

    expect(childEnv).toMatchObject({
      CODEX_HOME: '/tmp/codex',
      HOME: '/home/bryan',
      PATH: '/project/bin:/service/node/bin:/usr/bin',
    });
  });

  it('summarizes each active session with sanitized user and assistant prose only', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const eventBus = new RealtimeEventBus();
    const session = {
      id: 'session-1',
      provider: 'codex' as const,
      projectSlug: 'demo',
      conversationRef: 'conversation-1',
      resumeConversationRef: 'conversation-1',
      tmuxSessionName: 'ac-codex-demo',
      status: 'bound' as const,
      shouldRestore: true,
      title: 'New Codex conversation',
      startedAt: '2026-06-17T18:00:00.000Z',
      updatedAt: '2026-06-17T18:05:00.000Z',
      lastActivityAt: '2026-06-17T18:30:00.000Z',
      lastCompletedAt: '2026-06-17T18:31:00.000Z',
      eventLogPath: path.join(tempDir, 'events.jsonl'),
    };
    await fs.writeFile(session.eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Restored bound session.', timestamp: '2026-06-17T18:00:01.000Z' }),
      JSON.stringify({ type: 'user-input', text: 'Can you tighten the CIO workflow without showing code?', timestamp: '2026-06-17T18:30:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'The workflow summary is now focused on review status and next actions.', timestamp: '2026-06-17T18:31:00.000Z' }),
    ].join('\n'), 'utf8');
    db.upsertBoundSession(session);

    const conversationSummary: ConversationSummary = {
      ref: 'conversation-1',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      updatedAt: '2026-06-17T18:31:00.000Z',
      isBound: true,
      degraded: false,
    };
    const transcriptMessages = [
      message({
        role: 'assistant',
        timestamp: '2026-06-17T17:20:00.000Z',
        text: 'This older dashboard detail should stay in the full chat summary only.',
      }),
      message({
        role: 'user',
        timestamp: '2026-06-17T18:10:00.000Z',
        text: 'Please summarize the CIO dashboard work.\n- preserve the onboarding checklist\n+ keep allocation notes clear\n- keep risk notes visible\n```ts\nconst shouldNeverAppear = true;\n```',
      }),
      message({
        role: 'tool',
        timestamp: '2026-06-17T18:11:00.000Z',
        text: 'raw command output should not be passed through',
      }),
      message({
        role: 'assistant',
        timestamp: '2026-06-17T18:20:00.000Z',
        text: 'The discussion is about making the CIO dashboard easier to review and track.',
      }),
    ];
    const runner = vi.fn(async (input: SessionSummaryModelInput) => {
      expect(input.messages.map((item) => item.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
      expect(input.windowStartAt).toBe('2026-06-17T17:30:00.000Z');
      expect(input.windowEndAt).toBe('2026-06-17T18:30:00.000Z');
      expect(input.messages.map((item) => item.text).join('\n')).not.toContain('shouldNeverAppear');
      expect(input.messages.map((item) => item.text).join('\n')).toContain('preserve the onboarding checklist');
      expect(input.messages.map((item) => item.text).join('\n')).toContain('keep allocation notes clear');
      expect(input.messages.map((item) => item.text).join('\n')).toContain('keep risk notes visible');
      expect(input.messages.map((item) => item.text).join('\n')).not.toContain('raw command output');
      expect(input.messages.map((item) => item.text).join('\n')).not.toContain('workflow summary is now focused');
      expect(input.recentMessages.length).toBeGreaterThan(0);
      expect(input.recentMessages.map((item) => item.text).join('\n')).not.toContain('older dashboard detail');
      expect(input.canSuggestTitle).toBe(true);
      return {
        chatSummary: 'This chat covers CIO dashboard review workflow and clearer session status. It should stay brief.\n```js\nconsole.log("hidden")\n```\nThis third sentence should be dropped.',
        recentChangesSummary: 'The last hour focused on narrowing the hover summary to transcript-only user and agent prose. It also made the tooltip easier to scan. This third sentence should be dropped.',
        title: 'CIO dashboard workflow status refinement extra',
      };
    });
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => ({
            summary: conversationSummary,
            messages: transcriptMessages,
          }),
        }),
      } as never,
      tempDir,
      eventBus,
      runner,
    );

    await service.runOnce({ bootstrap: true, referenceTime: new Date('2026-06-17T18:35:00.000Z') });

    expect(runner).toHaveBeenCalledTimes(1);
    const stored = db.getSessionInteractionSummary('session-1');
    expect(stored).toMatchObject({
      sessionId: 'session-1',
      status: 'ready',
      lastInteractionAt: '2026-06-17T18:30:00.000Z',
      windowStartAt: '2026-06-17T17:30:00.000Z',
      windowEndAt: '2026-06-17T18:30:00.000Z',
      recentChangesSummary: 'The last hour focused on narrowing the hover summary to transcript-only user and agent prose. It also made the tooltip easier to scan.',
      titleSuggestion: 'CIO dashboard workflow status refinement extra',
    });
    expect(stored?.chatSummary).toBe('This chat covers CIO dashboard review workflow and clearer session status. It should stay brief.');
    expect(db.getConversationTitleOverride('demo', 'codex', 'conversation-1')?.title).toBe('CIO dashboard workflow status refinement extra');
    expect(db.getBoundSessionById('session-1')?.title).toBe('CIO dashboard workflow status refinement extra');
    db.close();
  });

  it('does not overwrite a user title override created while a summary is running', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-title-race-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-title-race',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-title-race',
      resumeConversationRef: 'conversation-title-race',
      tmuxSessionName: 'ac-codex-demo-title-race',
      status: 'bound',
      shouldRestore: true,
      title: 'New Codex conversation',
      startedAt: '2026-06-17T18:00:00.000Z',
      updatedAt: '2026-06-17T18:05:00.000Z',
      lastActivityAt: '2026-06-17T18:30:00.000Z',
    });
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => ({
            summary: {
              ref: 'conversation-title-race',
              kind: 'history',
              projectSlug: 'demo',
              provider: 'codex',
              title: 'New Codex conversation',
              updatedAt: '2026-06-17T18:30:00.000Z',
              isBound: true,
              degraded: false,
            },
            messages: [
              message({
                role: 'user',
                conversationRef: 'conversation-title-race',
                timestamp: '2026-06-17T18:30:00.000Z',
                text: 'Summarize this session.',
              }),
            ],
          }),
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      async () => {
        const renamedAt = '2026-06-17T18:34:00.000Z';
        db.setConversationTitleOverride('demo', 'codex', 'conversation-title-race', 'User chosen title', renamedAt);
        const latestSession = db.getBoundSessionById('session-title-race');
        if (latestSession) {
          db.upsertBoundSession({
            ...latestSession,
            title: 'User chosen title',
            updatedAt: renamedAt,
          });
        }
        return {
          chatSummary: 'This chat covers the title race behavior.',
          recentChangesSummary: 'The latest activity validates title override handling.',
          title: 'Model generated title',
        };
      },
    );

    await service.runOnce({ bootstrap: true, referenceTime: new Date('2026-06-17T18:35:00.000Z') });

    expect(db.getConversationTitleOverride('demo', 'codex', 'conversation-title-race')?.title).toBe('User chosen title');
    expect(db.getBoundSessionById('session-title-race')?.title).toBe('User chosen title');
    expect(db.getSessionInteractionSummary('session-title-race')?.titleSuggestion).toBeUndefined();
    db.close();
  });

  it('aborts an in-flight summary during stop without storing a failure', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-abort-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-abort',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-abort',
      resumeConversationRef: 'conversation-abort',
      tmuxSessionName: 'ac-codex-demo-abort',
      status: 'bound',
      shouldRestore: true,
      title: 'Abort conversation',
      startedAt: '2026-06-17T18:00:00.000Z',
      updatedAt: '2026-06-17T18:05:00.000Z',
      lastActivityAt: '2026-06-17T18:30:00.000Z',
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let abortObserved = false;
    const runner = vi.fn((_input: SessionSummaryModelInput, signal?: AbortSignal) => (
      new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => {
          abortObserved = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        resolveStarted();
        if (signal?.aborted) {
          rejectAbort();
          return;
        }
        signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    ));
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => ({
            summary: {
              ref: 'conversation-abort',
              kind: 'history',
              projectSlug: 'demo',
              provider: 'codex',
              title: 'Abort conversation',
              updatedAt: '2026-06-17T18:30:00.000Z',
              isBound: true,
              degraded: false,
            },
            messages: [
              message({
                role: 'user',
                conversationRef: 'conversation-abort',
                timestamp: '2026-06-17T18:30:00.000Z',
                text: 'Keep running until the service stops.',
              }),
            ],
          }),
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      runner,
    );

    const runPromise = service.runOnce({ bootstrap: true, referenceTime: new Date('2026-06-17T18:35:00.000Z') });
    await started;
    await service.stop();
    await runPromise;

    expect(abortObserved).toBe(true);
    expect(db.getSessionInteractionSummary('session-abort')).toBeUndefined();
    db.close();
  });

  it('stores model failures without exposing diagnostic text through tree summaries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-failure-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-failed',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-failed',
      tmuxSessionName: 'ac-codex-demo-failed',
      status: 'bound',
      shouldRestore: true,
      title: 'Failing conversation',
      startedAt: '2026-06-17T18:00:00.000Z',
      updatedAt: '2026-06-17T18:05:00.000Z',
      lastActivityAt: '2026-06-17T18:30:00.000Z',
    });
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => ({
            summary: {
              ref: 'conversation-failed',
              kind: 'history',
              projectSlug: 'demo',
              provider: 'codex',
              title: 'Failing conversation',
              updatedAt: '2026-06-17T18:30:00.000Z',
              isBound: true,
              degraded: false,
            },
            messages: [
              message({
                role: 'user',
                conversationRef: 'conversation-failed',
                timestamp: '2026-06-17T18:30:00.000Z',
                text: 'Summarize this.',
              }),
            ],
          }),
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      async () => {
        throw new Error('sensitive /tmp/path const leaked = true;');
      },
    );

    await service.runOnce({ bootstrap: true, referenceTime: new Date('2026-06-17T18:35:00.000Z') });

    expect(db.getSessionInteractionSummary('session-failed')?.lastError).toContain('sensitive');
    const exposed = db.listSessionInteractionSummariesBySessionIds(['session-failed']).get('session-failed');
    expect(exposed).toEqual(expect.objectContaining({
      sessionId: 'session-failed',
      status: 'failed',
      chatSummary: undefined,
      recentChangesSummary: undefined,
    }));
    expect(exposed).not.toHaveProperty('lastError');
    db.close();
  });

  it('force-runs summaries for existing ready sessions and anchors the window to latest chat prose', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-force-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-force',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-force',
      resumeConversationRef: 'conversation-force',
      tmuxSessionName: 'ac-codex-demo-force',
      status: 'bound',
      shouldRestore: true,
      title: 'Force conversation',
      startedAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:05:00.000Z',
      lastActivityAt: '2026-06-10T10:30:00.000Z',
      lastCompletedAt: '2026-06-10T10:31:00.000Z',
    });
    db.upsertSessionInteractionSummary({
      sessionId: 'session-force',
      projectSlug: 'demo',
      provider: 'codex',
      conversationRef: 'conversation-force',
      status: 'ready',
      generatedAt: '2026-06-10T10:35:00.000Z',
      windowStartAt: '2026-06-10T09:35:00.000Z',
      windowEndAt: '2026-06-10T10:35:00.000Z',
      lastInteractionAt: '2026-06-10T10:31:00.000Z',
      chatSummary: 'Old summary.',
      recentChangesSummary: 'Old recent summary.',
    });
    const runner = vi.fn(async (input: SessionSummaryModelInput) => {
      expect(input.windowStartAt).toBe('2026-06-10T09:31:00.000Z');
      expect(input.windowEndAt).toBe('2026-06-10T10:31:00.000Z');
      expect(input.lastInteractionAt).toBe('2026-06-10T10:31:00.000Z');
      return {
        chatSummary: 'Forced summary covers the older active session.',
        recentChangesSummary: 'The most recent chat hour ended with force-run validation.',
        title: null,
      };
    });
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => ({
            summary: {
              ref: 'conversation-force',
              kind: 'history',
              projectSlug: 'demo',
              provider: 'codex',
              title: 'Force conversation',
              updatedAt: '2026-06-10T10:31:00.000Z',
              isBound: true,
              degraded: false,
            },
            messages: [
              message({
                role: 'user',
                conversationRef: 'conversation-force',
                timestamp: '2026-06-10T10:30:00.000Z',
                text: 'Please force backfill this old conversation.',
              }),
              message({
                role: 'assistant',
                conversationRef: 'conversation-force',
                timestamp: '2026-06-10T10:31:00.000Z',
                text: 'The force backfill should use this latest chat hour.',
              }),
            ],
          }),
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      runner,
    );

    await service.runOnce({ force: true, referenceTime: new Date('2026-06-19T18:00:00.000Z') });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(db.getSessionInteractionSummary('session-force')).toMatchObject({
      windowStartAt: '2026-06-10T09:31:00.000Z',
      windowEndAt: '2026-06-10T10:31:00.000Z',
      recentChangesSummary: 'The most recent chat hour ended with force-run validation.',
    });
    db.close();
  });

  it('force-runs only requested session ids when scoped', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-scoped-force-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-target',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-target',
      resumeConversationRef: 'conversation-target',
      tmuxSessionName: 'ac-codex-demo-target',
      status: 'bound',
      shouldRestore: true,
      title: 'Target conversation',
      startedAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:05:00.000Z',
      lastActivityAt: '2026-06-10T10:30:00.000Z',
    });
    db.upsertBoundSession({
      id: 'session-keep',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-keep',
      resumeConversationRef: 'conversation-keep',
      tmuxSessionName: 'ac-codex-demo-keep',
      status: 'bound',
      shouldRestore: true,
      title: 'Keep conversation',
      startedAt: '2026-06-10T11:00:00.000Z',
      updatedAt: '2026-06-10T11:05:00.000Z',
      lastActivityAt: '2026-06-10T11:30:00.000Z',
    });
    db.upsertSessionInteractionSummary({
      sessionId: 'session-keep',
      projectSlug: 'demo',
      provider: 'codex',
      conversationRef: 'conversation-keep',
      status: 'ready',
      generatedAt: '2026-06-10T11:35:00.000Z',
      windowStartAt: '2026-06-10T10:30:00.000Z',
      windowEndAt: '2026-06-10T11:30:00.000Z',
      lastInteractionAt: '2026-06-10T11:30:00.000Z',
      chatSummary: 'Existing summary.',
      recentChangesSummary: 'Existing recent summary.',
    });
    const runner = vi.fn(async (input: SessionSummaryModelInput) => {
      expect(input.session.id).toBe('session-target');
      return {
        chatSummary: 'Scoped force summary.',
        recentChangesSummary: 'Scoped force recent summary.',
        title: null,
      };
    });
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async (_project: ActiveProject, conversationRef: string) => ({
            summary: {
              ref: conversationRef,
              kind: 'history',
              projectSlug: 'demo',
              provider: 'codex',
              title: conversationRef === 'conversation-target' ? 'Target conversation' : 'Keep conversation',
              updatedAt: '2026-06-10T11:30:00.000Z',
              isBound: true,
              degraded: false,
            },
            messages: [
              message({
                role: 'user',
                conversationRef,
                timestamp: '2026-06-10T11:30:00.000Z',
                text: `Summarize ${conversationRef}.`,
              }),
            ],
          }),
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      runner,
    );

    await service.runOnce({
      force: true,
      sessionIds: ['session-target'],
      referenceTime: new Date('2026-06-19T18:00:00.000Z'),
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(db.getSessionInteractionSummary('session-target')?.chatSummary).toBe('Scoped force summary.');
    expect(db.getSessionInteractionSummary('session-keep')?.chatSummary).toBe('Existing summary.');
    db.close();
  });

  it('skips system invocation conversations during forced summary runs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-summary-system-skip-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.upsertBoundSession({
      id: 'session-system',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'conversation-system',
      tmuxSessionName: 'ac-codex-demo-system',
      status: 'bound',
      shouldRestore: true,
      title: '### CLI invocation',
      startedAt: '2026-06-17T18:00:00.000Z',
      updatedAt: '2026-06-17T18:05:00.000Z',
      lastActivityAt: '2026-06-17T18:30:00.000Z',
    });
    const runner = vi.fn(async () => ({
      chatSummary: 'Should not run.',
      recentChangesSummary: 'Should not run.',
      title: null,
    }));
    const service = new SessionSummaryService(
      db,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: () => providerSettings,
      } as never,
      {
        get: () => ({
          getConversation: async () => undefined,
        }),
      } as never,
      tempDir,
      new RealtimeEventBus(),
      runner,
    );

    await service.runOnce({ force: true, referenceTime: new Date('2026-06-17T18:35:00.000Z') });

    expect(runner).not.toHaveBeenCalled();
    expect(db.getSessionInteractionSummary('session-system')).toBeUndefined();
    db.close();
  });
});
