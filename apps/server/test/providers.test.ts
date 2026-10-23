import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';
import { claudeOpeningUserText, parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { mergeTimelineMessages } from '../src/sessions/timeline-merge.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/tmp/demo-project',
  path: '/tmp/demo-project',
  matchPaths: ['/tmp/demo-project'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

describe('provider history discovery', () => {
  it.each(['codex', 'claude'] as const)('preserves custom %s model, effort, flags and Console identity on launch and resume', (id) => {
    const provider = id === 'codex' ? new CodexProvider() : new ClaudeProvider();
    const settings = { id, enabled: true, discoveryRoot: '/tmp/provider', commands: {
      newCommand: [id, '--model', 'configured-model'],
      resumeCommand: id === 'codex' ? [id, 'resume', '{{conversationId}}', '--model', 'configured-model'] : [id, '--resume', '{{conversationId}}', '--model', 'configured-model'],
      continueCommand: [id], env: {},
    } } satisfies MergedProviderSettings;
    for (const ref of [null, 'native-history']) {
      const argv = provider.getLaunchCommand(project, ref, settings, { model: 'custom-model', effort: 'high', flags: ['--add-dir', '/tmp/helper'],
        initialPrompt: 'Complete the delegated task.', authorityContext: 'Console supplied standing human grant.', consoleIdentity: { sessionId: 'console-session', runtimeDir: '/tmp/runtime', helperPath: '/tmp/agent-coord.mjs' } }).argv;
      expect(argv).toContain('custom-model'); expect(argv).not.toContain('configured-model');
      expect(argv).toContain('--add-dir'); expect(argv.join(' ')).toContain('/tmp/agent-coord.mjs');
      expect(argv.join(' ')).toContain('AGENT_CONSOLE_SESSION_ID'); expect(argv.join(' ')).toContain('console-session');
      if (id === 'claude') expect(argv.slice(-2)).toEqual(['--', 'Complete the delegated task.']);
      if (id === 'claude') expect(argv).toContain('--append-system-prompt');
      if (ref) expect(argv).toContain(ref);
      if (id === 'codex' && ref) expect(argv.indexOf('resume')).toBeLessThan(argv.indexOf('--model'));
    }
  });

  it.each([null, 'history-ref'])('disables startup update prompts for Codex launch %s', (conversationRef) => {
    const provider = new CodexProvider();
    const settings = {
      id: 'codex', enabled: true, discoveryRoot: '/tmp/codex',
      commands: {
        newCommand: ['codex', '-c', 'check_for_update_on_startup=true'],
        resumeCommand: ['codex', '-c', 'check_for_update_on_startup=true', 'resume', '{{conversationId}}'],
        continueCommand: ['codex', 'resume', '--last'], env: {},
      },
    } satisfies MergedProviderSettings;
    const launch = provider.getLaunchCommand(project, conversationRef, settings, { codexProfile: 'medium' });
    expect(launch.argv.slice(-2)).toEqual(['-c', 'check_for_update_on_startup=false']);
    expect(launch.argv).toContain('--model');
    expect(launch.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    if (conversationRef) expect(launch.argv).toContain(conversationRef);
  });

  it('passes an initial prompt through Codex resume launches', async () => {
    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: path.resolve('test/fixtures/codex'),
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const launch = provider.getLaunchCommand(project, 'history-ref', settings, {
      initialPrompt: 'resume with this prompt',
    });

    expect(launch.argv).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'history-ref',
      '-c',
      'check_for_update_on_startup=false',
      'resume with this prompt',
    ]);
  });

  it('discovers Codex transcripts for the selected project', async () => {
    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: path.resolve('test/fixtures/codex'),
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;
    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('Plan the auth flow');
  });

  it('streams Codex transcript records instead of buffering the entire file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-stream-'));
    const transcriptPath = path.join(tempDir, 'rollout-streamed-transcript.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'streamed-transcript', cwd: '/tmp/demo-project' },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Parse this without a whole-file read.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', output: 'x'.repeat(2 * 1024 * 1024) },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'The streamed parse completed.' }],
        },
      }),
    ].join('\n'));

    const wholeFileRead = vi.spyOn(fs, 'readFile');
    try {
      const parsed = await parseCodexConversationFile({
        filePath: transcriptPath,
        provider: 'codex',
        projectSlug: 'demo',
        conversationRef: 'streamed-transcript',
      });

      expect(wholeFileRead).not.toHaveBeenCalled();
      expect(parsed.displayMessages.map((message) => message.text)).toEqual([
        'Parse this without a whole-file read.',
        'The streamed parse completed.',
      ]);
    } finally {
      wholeFileRead.mockRestore();
    }
  });

  it('finds pending Codex adoption candidates by parsed user hash when prompts contain escaped text', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-pending-hash-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const conversationRef = '11111111-2222-4333-8444-555555555555';
    const transcriptPath = path.join(sessionsDir, `rollout-2026-03-07T10-00-00-${conversationRef}.jsonl`);
    const prompt = 'Create the "must-hit" plan.\nKeep C:\\research\\inputs intact.';
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T15:00:00.000Z',
        type: 'session_meta',
        payload: { id: conversationRef, cwd: '/tmp/demo-project' },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T15:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;
    const pending = {
      ref: 'pending:quoted-prompt',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-07T15:00:00.000Z',
      updatedAt: '2026-03-07T15:00:01.000Z',
      isBound: true,
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: stableTextHash(normalizeComparableText(prompt)),
        lastUserInputPreview: 'Create the "must-hit" plan. Keep C:\\research\\inputs intact.',
        lastUserInputAt: '2026-03-07T15:00:01.000Z',
      },
    } as const;

    const candidates = await provider.listPendingAdoptionCandidates(project, pending, settings);

    expect(candidates.map((candidate) => candidate.ref)).toEqual([conversationRef]);
  });

  it('finds a pending Codex prompt between large instruction and output records', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-pending-middle-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '08', '14');
    await fs.mkdir(sessionsDir, { recursive: true });
    const conversationRef = '22222222-3333-4444-8555-666666666666';
    const transcriptPath = path.join(sessionsDir, `rollout-2026-08-14T10-40-41-${conversationRef}.jsonl`);
    const prompt = 'how was last nights run';
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-08-14T14:40:43.000Z',
        type: 'session_meta',
        payload: { id: conversationRef, cwd: '/tmp/demo-project' },
      }),
      JSON.stringify({
        timestamp: '2026-08-14T14:40:44.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'x'.repeat(80_000) }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-14T14:40:46.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-14T14:44:27.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: 'y'.repeat(1_100_000),
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;
    const pending = {
      ref: 'pending:prompt-in-middle',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-08-14T14:40:41.000Z',
      updatedAt: '2026-08-14T14:40:41.000Z',
      isBound: true,
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: stableTextHash(normalizeComparableText(prompt)),
        lastUserInputPreview: prompt,
        lastUserInputAt: '2026-08-14T14:40:41.000Z',
      },
    } as const;

    const candidates = await provider.listPendingAdoptionCandidates(project, pending, settings);

    expect(candidates.map((candidate) => candidate.ref)).toEqual([conversationRef]);
  });

  it('discovers Claude transcripts from encoded project storage', async () => {
    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: path.resolve('test/fixtures/claude'),
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;
    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('Refactor the tmux manager');
  });

  it('uses Claude aiTitle metadata instead of a continuation wrapper as the conversation title', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-title-'));
    const transcriptPath = path.join(tempDir, 'review-business-plan.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'ai-title',
        aiTitle: 'Review Waltium business plan',
        sessionId: 'review-business-plan',
      }),
      JSON.stringify({
        uuid: 'user-1',
        parentUuid: null,
        timestamp: '2026-08-03T20:00:00.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation.',
        },
      }),
    ].join('\n'));

    const parsed = await parseClaudeConversationFile({
      filePath: transcriptPath,
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'review-business-plan',
    });

    expect(parsed.summary.title).toBe('Review Waltium business plan');
  });

  it('keeps only the latest Claude parent-linked branch in the visible transcript', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-branch-'));
    const transcriptPath = path.join(tempDir, 'branched-claude-transcript.jsonl');
    await fs.writeFile(transcriptPath, [
      {
        uuid: 'root-user',
        parentUuid: null,
        timestamp: '2026-03-07T00:00:00.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: { role: 'user', content: 'Shared root prompt' },
      },
      {
        uuid: 'root-assistant',
        parentUuid: 'root-user',
        timestamp: '2026-03-07T00:00:01.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: { role: 'assistant', content: 'Shared root reply' },
      },
      {
        uuid: 'branch-b-user',
        parentUuid: 'root-assistant',
        timestamp: '2026-03-07T00:00:02.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: { role: 'user', content: 'Sibling branch B prompt' },
      },
      {
        uuid: 'branch-b-assistant',
        parentUuid: 'branch-b-user',
        timestamp: '2026-03-07T00:00:03.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: { role: 'assistant', content: 'Sibling branch B reply' },
      },
      {
        uuid: 'branch-a-user',
        parentUuid: 'root-assistant',
        timestamp: '2026-03-07T00:00:04.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: { role: 'user', content: 'Latest branch A prompt' },
      },
      {
        uuid: 'branch-a-assistant',
        parentUuid: 'branch-a-user',
        timestamp: '2026-03-07T00:00:05.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: { role: 'assistant', content: 'Latest branch A reply' },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));

    const parsed = await parseClaudeConversationFile({
      filePath: transcriptPath,
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'branched-claude-transcript',
    });

    expect(parsed.displayMessages.map((message) => message.text)).toEqual([
      'Shared root prompt',
      'Shared root reply',
      'Latest branch A prompt',
      'Latest branch A reply',
    ]);
    expect(parsed.summary.updatedAt).toBe('2026-03-07T00:00:05.000Z');
  });

  it('keeps delivered Claude mid-turn human questions after the assistant replies', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-midturn-'));
    const filePath = path.join(tempDir, 'midturn.jsonl');
    const prompt = 'Which strategies do you compare?\nHow do you reuse their simulations?';
    const timestamp = '2026-10-23T13:44:51.955Z';
    const delivered = {
      type: 'attachment', uuid: 'midturn-human', parentUuid: 'working', timestamp,
      attachment: { type: 'queued_command', prompt: `<pasted_content id="paste">\n${prompt}\n</pasted_content id="paste">`,
        origin: { kind: 'human' }, commandMode: 'prompt', humanTurn: true },
      renderedRole: 'system', rendered: [{ content: `<system-reminder>The user sent a new message: ${prompt}</system-reminder>` }],
    };
    try {
      await fs.writeFile(filePath, [
        { type: 'user', uuid: 'opening', parentUuid: null, timestamp: '2026-10-23T13:43:00.000Z',
          message: { role: 'user', content: 'Explain the strategy search.' } },
        { type: 'assistant', uuid: 'working', parentUuid: 'opening', timestamp: '2026-10-23T13:44:00.000Z',
          message: { role: 'assistant', content: 'I am reading the search code.' } },
        { type: 'queue-operation', operation: 'enqueue', timestamp, content: prompt },
        { type: 'queue-operation', operation: 'remove', timestamp: '2026-10-23T13:45:13.295Z',
          reason: 'absorbed_mid_turn', content: prompt },
        delivered,
        { type: 'assistant', uuid: 'answer', parentUuid: 'midturn-human', timestamp: '2026-10-23T13:45:50.851Z',
          message: { role: 'assistant', content: 'Fair criticism. Here is the concrete strategy list.' } },
        { type: 'api-request-blob', message: { role: 'user', content: prompt } },
      ].map((record) => JSON.stringify(record)).join('\n'));
      const parsed = await parseClaudeConversationFile({ filePath, provider: 'claude', projectSlug: 'demo', conversationRef: 'midturn' });
      expect(parsed.displayMessages.map((message) => [message.role, message.text])).toEqual([
        ['user', 'Explain the strategy search.'], ['assistant', 'I am reading the search code.'],
        ['user', prompt], ['assistant', 'Fair criticism. Here is the concrete strategy list.'],
      ]);
      expect(parsed.displayMessages[2]).toMatchObject({ timestamp, source: 'history-file', lifecycle: 'durable' });
      expect(parsed.summary.rawMetadata).toMatchObject({ lastUserAt: timestamp, lastUserTextHash: stableTextHash(normalizeComparableText(prompt)) });
      expect(claudeOpeningUserText(delivered)).toBe(prompt);
      const merged = mergeTimelineMessages({ allMessages: parsed.messages, visibleMessages: parsed.displayMessages,
        liveMessages: [{ id: 'live-question', provider: 'claude', role: 'user', text: prompt,
          timestamp: '2026-10-23T13:44:52.013Z', conversationRef: 'midturn', source: 'user-input', lifecycle: 'pending' }] });
      expect(merged.mergedMessages.filter((message) => message.text === prompt)).toEqual([parsed.displayMessages[2]]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('selects a Claude branch ending in a delivered human question without reviving sibling questions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-midturn-branch-'));
    const filePath = path.join(tempDir, 'branches.jsonl');
    const question = (uuid: string, parentUuid: string, prompt: string, timestamp: string) => ({
      type: 'attachment', uuid, parentUuid, timestamp,
      attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt', prompt },
    });
    try {
      await fs.writeFile(filePath, [
        { type: 'user', uuid: 'opening', parentUuid: null, timestamp: '2026-10-23T13:43:00.000Z', message: { role: 'user', content: 'Opening question' } },
        question('sibling', 'opening', 'Abandoned question', '2026-10-23T13:44:00.000Z'),
        { type: 'assistant', uuid: 'old-answer', parentUuid: 'sibling', timestamp: '2026-10-23T13:45:00.000Z', message: { role: 'assistant', content: 'Abandoned answer' } },
        question('selected', 'opening', 'Current question', '2026-10-23T13:46:00.000Z'),
      ].map((record) => JSON.stringify(record)).join('\n'));
      const parsed = await parseClaudeConversationFile({ filePath, provider: 'claude', projectSlug: 'demo', conversationRef: 'branches' });
      expect(parsed.displayMessages.map((message) => message.text)).toEqual(['Opening question', 'Current question']);
      expect(parsed.summary.excerpt).toBe('Current question');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not promote Claude queue operations or automated attachments into human history', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-queued-internal-'));
    const filePath = path.join(tempDir, 'internal.jsonl');
    const attachments = [
      { type: 'queued_command', prompt: 'Task result', origin: { kind: 'task-notification' }, commandMode: 'task-notification' },
      { type: 'queued_command', prompt: 'Automation', origin: { kind: 'automation' }, commandMode: 'prompt', humanTurn: true },
      { type: 'queued_command', prompt: 'No human marker', origin: { kind: 'human' }, commandMode: 'prompt' },
      { type: 'queued_command', prompt: 'Not a human turn', origin: { kind: 'human' }, commandMode: 'prompt', humanTurn: false },
      { type: 'queued_command', prompt: 'No origin', commandMode: 'prompt', humanTurn: true },
      { type: 'hook_additional_context', prompt: 'Hook prose', origin: { kind: 'human' }, commandMode: 'prompt', humanTurn: true },
    ];
    try {
      await fs.writeFile(filePath, [
        { type: 'user', uuid: 'opening', parentUuid: null, timestamp: '2026-10-23T13:43:00.000Z', message: { role: 'user', content: 'Real question' } },
        ...attachments.map((attachment, index) => ({ type: 'attachment', uuid: `internal-${index}`,
          parentUuid: index ? `internal-${index - 1}` : 'opening', timestamp: '2026-10-23T13:44:00.000Z', attachment })),
        { type: 'assistant', uuid: 'answer', parentUuid: `internal-${attachments.length - 1}`, timestamp: '2026-10-23T13:45:00.000Z', message: { role: 'assistant', content: 'Real answer' } },
        { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-23T13:46:00.000Z', content: 'Unsent question' },
      ].map((record) => JSON.stringify(record)).join('\n'));
      const parsed = await parseClaudeConversationFile({ filePath, provider: 'claude', projectSlug: 'demo', conversationRef: 'internal' });
      expect(parsed.messages.map((message) => message.text)).toEqual(['Real question', 'Real answer']);
      expect(parsed.summary.updatedAt).toBe('2026-10-23T13:45:00.000Z');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('ignores Claude API request copies without changing the active branch (copy UUIDs: %s)', async (copyUuids) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-request-copies-'));
    const transcriptPath = path.join(tempDir, 'request-copies.jsonl');
    const prompt = 'Tell me the progress.';
    const answer = 'The preview is ready. Two fixes remain.';
    const requestCopies = [
      { role: 'user', content: '<system-reminder>Injected instructions</system-reminder>' },
      { role: 'assistant', content: [{ type: 'text', text: 'An old answer copied into the API request.' }] },
      { role: 'user', content: prompt },
    ].map((message, index) => ({
      type: 'api-request-blob', sessionId: 'request-copies', hash: `copy-${index}`, message,
      ...(copyUuids ? { uuid: `copy-${index}`, parentUuid: null } : {}),
    }));
    try {
      await fs.writeFile(transcriptPath, [
        requestCopies[0],
        { type: 'user', uuid: 'user', parentUuid: null, timestamp: '2026-10-15T11:58:00.000Z',
          message: { role: 'user', content: prompt } },
        { type: 'assistant', uuid: 'assistant', parentUuid: 'user', timestamp: '2026-10-15T12:02:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } },
        ...requestCopies.slice(1),
      ].map((record) => JSON.stringify(record)).join('\n'));
      await fs.utimes(transcriptPath, new Date('2026-10-15T12:03:00.000Z'), new Date('2026-10-15T12:03:00.000Z'));
      const parsed = await parseClaudeConversationFile({
        filePath: transcriptPath, provider: 'claude', projectSlug: 'demo', conversationRef: 'request-copies',
      });
      expect(parsed.displayMessages.map((message) => message.text)).toEqual([prompt, answer]);
      expect(parsed.messages.map((message) => message.text)).toEqual([prompt, answer]);
      expect(parsed.summary).toMatchObject({
        title: prompt, excerpt: answer, updatedAt: '2026-10-15T12:02:00.000Z',
        rawMetadata: { firstUserTextHash: stableTextHash(normalizeComparableText(prompt)), lastUserTextHash: stableTextHash(normalizeComparableText(prompt)),
          lastUserAt: '2026-10-15T11:58:00.000Z' },
      });
      expect(claudeOpeningUserText(requestCopies[0]!)).toBeUndefined();
      expect(claudeOpeningUserText(requestCopies[2]!)).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses complete large Claude transcripts instead of splicing head and tail windows', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-large-'));
    const transcriptPath = path.join(tempDir, 'large-claude-transcript.jsonl');
    const largeHeadAssistantText = `large head ${'x'.repeat(2_100_000)}`;
    const largeTailAssistantText = `large tail ${'y'.repeat(2_100_000)}`;
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: {
          role: 'user',
          content: 'Start the large transcript',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: largeHeadAssistantText,
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:10.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: {
          role: 'user',
          content: 'Middle marker that used to disappear from a large transcript',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:15.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: largeTailAssistantText,
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:20.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'End marker',
        },
      }),
    ].join('\n'));

    const parsed = await parseClaudeConversationFile({
      filePath: transcriptPath,
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'large-claude-transcript',
    });

    expect(parsed.displayMessages).toHaveLength(5);
    expect(parsed.displayMessages.map((message) => message.text.length)).toEqual([
      'Start the large transcript'.length,
      largeHeadAssistantText.length,
      'Middle marker that used to disappear from a large transcript'.length,
      largeTailAssistantText.length,
      'End marker'.length,
    ]);
    expect(parsed.displayMessages[2]?.text).toBe('Middle marker that used to disappear from a large transcript');
  });

  it('hides Claude task notifications from display transcripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-notification-'));
    const transcriptPath = path.join(tempDir, 'task-notification.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: {
          role: 'user',
          content: 'Run the review',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:00.000Z',
        cwd: '/tmp/demo-project',
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<status>failed</status>\n</task-notification>',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:01.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'No response requested.',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:05.000Z',
        cwd: '/tmp/demo-project',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'The review failed with exit code 144.',
        },
      }),
    ].join('\n'));

    const parsed = await parseClaudeConversationFile({
      filePath: transcriptPath,
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'task-notification',
    });

    expect(parsed.displayMessages.map((message) => message.text)).toEqual([
      'Run the review',
      'The review failed with exit code 144.',
    ]);
  });

  it('extracts Codex project context from harness environment messages when session metadata is absent', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-env-context.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<environment_context>\n  <cwd>/tmp/demo-project</cwd>\n</environment_context>',
            },
          ],
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'Repeatable prompt',
        timestamp: '2026-03-07T00:00:00.000Z',
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.degraded).toBe(false);
  });

  it('deduplicates Codex event and response message pairs in display transcripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-duplicate-message-pairs.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Plan the auth flow',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.005Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Plan the auth flow' }],
          metadata: { turn_id: 'turn-user' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Use a server-owned session and cookie flow.',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.006Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Use a server-owned session and cookie flow.' }],
          metadata: { turn_id: 'turn-assistant' },
        },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'duplicate-message-pairs',
    });

    expect(parsed.displayMessages.map((message) => ({
      role: message.role,
      text: message.text,
      rawType: message.rawMetadata?.type,
    }))).toEqual([
      {
        role: 'user',
        text: 'Plan the auth flow',
        rawType: 'response_item',
      },
      {
        role: 'assistant',
        text: 'Use a server-owned session and cookie flow.',
        rawType: 'response_item',
      },
    ]);
    expect(parsed.messages).toHaveLength(2);
  });

  it('deduplicates Codex final-answer pairs after removing internal memory citations wherever they occur', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-memory-citation-duplicates.jsonl');
    const citation = '<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[context]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>';
    const structuredAnswer = '{"reasoning":"Validated the repair.\\n","status":"changed"}';
    const annotatedStructuredAnswer = structuredAnswer.replace('\\n"', `\\n${citation}"`);
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Finish the transcript fix.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', phase: 'final_answer', message: 'Fixed and verified.' },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.005Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: `Fixed and verified.\n\n${citation}` }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Return the structured result.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:05.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', phase: 'final_answer', message: structuredAnswer },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:05.005Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: annotatedStructuredAnswer }],
        },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'memory-citation-duplicates',
    });

    expect(parsed.displayMessages.map((message) => message.text)).toEqual([
      'Finish the transcript fix.',
      'Fixed and verified.',
      'Return the structured result.',
      structuredAnswer,
    ]);
    expect(parsed.displayMessages.some((message) => message.text.includes('<oai-mem-citation>'))).toBe(false);
    expect(parsed.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(parsed.messages.filter((message) => message.role === 'assistant')
      .every((message) => message.rawMetadata?.type === 'response_item')).toBe(true);
  });

  it('keeps Codex event and response messages separate outside the duplicate window and for same-kind repeats', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-non-duplicate-messages.jsonl');
    await fs.writeFile(transcriptPath, [
      // Same text but 5s apart: outside the 1s duplicate window, both kept.
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Working on the auth flow now.' },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Working on the auth flow now.' }],
        },
      }),
      // Same text, same kind, within 1s: kinds do not pair, both kept.
      JSON.stringify({
        timestamp: '2026-03-07T00:01:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Retrying the flaky step.' },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:01:00.500Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Retrying the flaky step.' },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'non-duplicate-messages',
    });

    expect(parsed.messages).toHaveLength(4);
  });

  it('prefers the Codex response_item version when it arrives before the event_msg duplicate', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-response-first-duplicate.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Server-owned sessions are the safer default.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.400Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Server-owned sessions are the safer default.' },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'response-first-duplicate',
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.rawMetadata?.type).toBe('response_item');
  });

  it('shows Codex commentary-phase assistant progress messages while the latest turn is unfinished', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-commentary-progress.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix the transcript UI.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I am checking the current build.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'The build is still running.' }],
        },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'commentary-progress',
    });

    expect(parsed.displayMessages.map((message) => ({
      role: message.role,
      lifecycle: message.lifecycle,
      text: message.text,
    }))).toEqual([
      {
        role: 'user',
        lifecycle: 'durable',
        text: 'Fix the transcript UI.',
      },
      {
        role: 'assistant',
        lifecycle: 'pending',
        text: 'I am checking the current build.',
      },
      {
        role: 'assistant',
        lifecycle: 'pending',
        text: 'The build is still running.',
      },
    ]);
    expect(parsed.messages.map((message) => message.text)).toContain('I am checking the current build.');
  });

  it('hides Codex commentary-phase assistant progress once the latest turn has a final answer', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'rollout-commentary-final-answer.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix the transcript UI.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I am checking the current build.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Fixed and verified.' }],
        },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'commentary-final-answer',
    });

    expect(parsed.displayMessages.map((message) => message.text)).toEqual([
      'Fix the transcript UI.',
      'Fixed and verified.',
    ]);
    expect(parsed.messages.map((message) => message.text)).toContain('I am checking the current build.');
  });

  it('hides Codex internal continuation and rejected-submit records from display transcripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const transcriptPath = path.join(tempDir, 'internal-continuation-records.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-03-07T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Run the readable transcript checks.\n✻ Cogitated for 23s\nLive input bridge\nExpand to type directly into the live session.',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Live session did not accept the typed text into its input buffer. The draft was not submitted' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<permissions instructions>\nFilesystem sandboxing is disabled.\n</permissions instructions>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '✻ Cogitated for 23s' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-07T00:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Transcript checks are readable now.' }],
        },
      }),
    ].join('\n'));

    const parsed = await parseCodexConversationFile({
      filePath: transcriptPath,
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'internal-continuation-records',
    });

    expect(parsed.displayMessages.map((message) => message.text)).toEqual([
      'Run the readable transcript checks.',
      'Transcript checks are readable now.',
    ]);
    expect(parsed.messages).toHaveLength(7);
  });

  it('extracts Codex project context from "Current working directory" text in older transcripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-old-env-context.jsonl');
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\nCurrent working directory: /tmp/demo-project\nApproval policy: never\n</environment_context>' }],
      timestamp: '2026-03-07T00:00:00.000Z',
    })}\n`);

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.rawMetadata?.projectPaths).toContain('/tmp/demo-project');
  });

  it('keeps older Codex transcripts attached when the saved project now resolves to a nested git repo', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-retroactive-parent-path.jsonl');
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd: '/tmp/demo-project',
        id: 'retroactive-parent-path',
      },
    })}\n`);

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const nestedRepoProject: ActiveProject = {
      ...project,
      rootPath: '/tmp/demo-project',
      path: '/tmp/demo-project/apps/web',
      matchPaths: ['/tmp/demo-project/apps/web', '/tmp/demo-project'],
    };

    const conversations = await provider.listConversations(nestedRepoProject, settings);
    expect(conversations).toHaveLength(1);
  });

  it('keeps older Claude transcripts attached when history points at the pre-repo parent folder', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const legacyProjectDir = path.join(tempDir, 'projects', '-tmp-demo-project-');
    await fs.mkdir(legacyProjectDir, { recursive: true });
    await fs.writeFile(path.join(legacyProjectDir, 'retroactive-parent-path.jsonl'), [
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'Legacy project path conversation',
        },
      }),
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'history.jsonl'), `${JSON.stringify({
      cwd: '/tmp/demo-project',
      transcript_path: path.join(legacyProjectDir, 'retroactive-parent-path.jsonl'),
    })}\n`);

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const nestedRepoProject: ActiveProject = {
      ...project,
      rootPath: '/tmp/demo-project',
      path: '/tmp/demo-project/apps/web',
      matchPaths: ['/tmp/demo-project/apps/web', '/tmp/demo-project'],
    };

    const conversations = await provider.listConversations(nestedRepoProject, settings);
    expect(conversations).toHaveLength(1);
  });

  it('indexes Codex and Claude transcripts for explicit markerless project folders', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-markerless-project-'));
    const markerlessProjectPath = path.join(tempDir, 'workspace');
    await fs.mkdir(markerlessProjectPath, { recursive: true });

    const codexSessionsDir = path.join(tempDir, 'codex-home', 'sessions', '2026', '04', '04');
    await fs.mkdir(codexSessionsDir, { recursive: true });
    await fs.writeFile(path.join(codexSessionsDir, 'rollout-markerless.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: markerlessProjectPath,
          id: 'markerless-codex',
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'Markerless Codex prompt',
        timestamp: '2026-04-04T00:00:00.000Z',
      }),
    ].join('\n'));

    const claudeProjectDir = path.join(tempDir, 'claude-home', 'projects', '-tmp-agent-console-markerless-project--workspace-');
    await fs.mkdir(claudeProjectDir, { recursive: true });
    const claudeTranscriptPath = path.join(claudeProjectDir, 'markerless-claude.jsonl');
    await fs.writeFile(claudeTranscriptPath, [
      JSON.stringify({
        cwd: markerlessProjectPath,
        timestamp: '2026-04-04T00:01:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'Markerless Claude prompt',
        },
      }),
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'claude-home', 'history.jsonl'), `${JSON.stringify({
      cwd: markerlessProjectPath,
      transcript_path: claudeTranscriptPath,
    })}\n`);

    const markerlessProject: ActiveProject = {
      ...project,
      slug: 'workspace',
      directoryName: 'workspace',
      displayName: 'workspace',
      rootPath: markerlessProjectPath,
      path: markerlessProjectPath,
      matchPaths: [markerlessProjectPath],
      config: { active: true, explicit: true, allowedLocalhostPorts: [], tags: [], providers: {} },
    };

    const codexProvider = new CodexProvider();
    const codexConversations = await codexProvider.listConversations(markerlessProject, {
      id: 'codex',
      enabled: true,
      discoveryRoot: path.join(tempDir, 'codex-home'),
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings);
    expect(codexConversations).toHaveLength(1);
    expect(codexConversations[0]?.title).toContain('Markerless Codex prompt');

    const claudeProvider = new ClaudeProvider();
    const claudeConversations = await claudeProvider.listConversations(markerlessProject, {
      id: 'claude',
      enabled: true,
      discoveryRoot: path.join(tempDir, 'claude-home'),
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings);
    expect(claudeConversations).toHaveLength(1);
    expect(claudeConversations[0]?.title).toContain('Markerless Claude prompt');
  });

  it('does not attach parent Claude history to an explicit nested child project', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const parentProjectPath = path.join(tempDir, 'waltium');
    const childProjectPath = path.join(parentProjectPath, 'agent', 'cio');
    await fs.mkdir(childProjectPath, { recursive: true });

    const encodedParentDir = path.join(
      tempDir,
      'claude-home',
      'projects',
      encodeClaudeProjectDir(parentProjectPath),
    );
    const encodedChildDir = path.join(
      tempDir,
      'claude-home',
      'projects',
      encodeClaudeProjectDir(childProjectPath),
    );
    await fs.mkdir(encodedParentDir, { recursive: true });
    await fs.mkdir(encodedChildDir, { recursive: true });

    const parentTranscriptPath = path.join(encodedParentDir, 'waltium-parent.jsonl');
    const childTranscriptPath = path.join(encodedChildDir, 'cio-child.jsonl');
    await fs.writeFile(parentTranscriptPath, `${JSON.stringify({
      cwd: parentProjectPath,
      timestamp: '2026-04-20T00:00:00.000Z',
      type: 'user',
      message: {
        role: 'user',
        content: 'Waltium parent chat',
      },
    })}\n`);
    await fs.writeFile(childTranscriptPath, `${JSON.stringify({
      cwd: childProjectPath,
      timestamp: '2026-04-20T00:01:00.000Z',
      type: 'user',
      message: {
        role: 'user',
        content: 'CIO child chat',
      },
    })}\n`);
    await fs.mkdir(path.join(tempDir, 'claude-home'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'claude-home', 'history.jsonl'), [
      JSON.stringify({
        cwd: parentProjectPath,
        transcript_path: parentTranscriptPath,
      }),
      JSON.stringify({
        cwd: childProjectPath,
        transcript_path: childTranscriptPath,
      }),
    ].join('\n'));

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: path.join(tempDir, 'claude-home'),
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const explicitChildProject: ActiveProject = {
      ...project,
      slug: 'cio',
      directoryName: 'cio',
      displayName: 'cio',
      rootPath: parentProjectPath,
      path: childProjectPath,
      matchPaths: [childProjectPath],
      config: { active: true, explicit: true, allowedLocalhostPorts: [], tags: [], providers: {} },
    };

    const conversations = await provider.listConversations(explicitChildProject, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('CIO child chat');
  });

  it('does not attach parent Codex history to an explicit nested child project', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const parentProjectPath = path.join(tempDir, 'waltium');
    const childProjectPath = path.join(parentProjectPath, 'agent', 'cio');
    await fs.mkdir(childProjectPath, { recursive: true });

    const sessionsDir = path.join(tempDir, 'codex-home', 'sessions', '2026', '04', '20');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 'rollout-parent.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: parentProjectPath,
          id: 'parent',
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'Waltium parent codex chat',
        timestamp: '2026-04-20T00:00:00.000Z',
      }),
    ].join('\n'));
    await fs.writeFile(path.join(sessionsDir, 'rollout-child.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: childProjectPath,
          id: 'child',
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'CIO child codex chat',
        timestamp: '2026-04-20T00:01:00.000Z',
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: path.join(tempDir, 'codex-home'),
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const explicitChildProject: ActiveProject = {
      ...project,
      slug: 'cio',
      directoryName: 'cio',
      displayName: 'cio',
      rootPath: parentProjectPath,
      path: childProjectPath,
      matchPaths: [childProjectPath],
      config: { active: true, explicit: true, allowedLocalhostPorts: [], tags: [], providers: {} },
    };

    const conversations = await provider.listConversations(explicitChildProject, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('CIO child codex chat');
  });

  it('skips Codex transcripts that provide no project signal at all', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-missing-project.jsonl');
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      role: 'user',
      text: 'Repeatable prompt',
      timestamp: '2026-03-07T00:00:00.000Z',
    })}\n`);

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toEqual([]);
  });

  it('ignores Codex transcripts whose real session cwd is for a different project even if nested output mentions this project', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '07');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-other-project.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/another-project',
          id: 'real-session',
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'Unrelated prompt',
        timestamp: '2026-03-07T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: {
            cwd: '/tmp/demo-project',
          },
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toEqual([]);
  });

  it('parses modern Codex response_item payload messages into user and assistant history', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '08');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-modern-response-item.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/demo-project',
          id: 'modern-response-item',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-08T00:01:39.494Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with exactly: smoke-token' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-08T00:01:45.439Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'smoke-token' }],
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('Reply with exactly: smoke-token');
    expect(conversations[0]?.rawMetadata?.lastUserTextHash).toBeTruthy();

    const conversation = await provider.getConversation(project, conversations[0]!.ref, settings);
    expect(conversation?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation?.allMessages?.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('keeps internal transcript events out of the visible history while preserving them in allMessages', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '10');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-visible-history.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/demo-project',
          id: 'visible-history',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:00.000Z',
        role: 'system',
        text: 'Harness context',
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:01.000Z',
        role: 'user',
        text: 'Show only what I visibly typed and saw',
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:02.000Z',
        role: 'tool',
        text: 'Read file foo.ts',
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:03.000Z',
        role: 'assistant',
        text: 'Visible assistant reply',
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:04.000Z',
        role: 'status',
        text: 'Internal completion event',
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversation = await provider.getConversation(project, 'visible-history', settings);
    expect(conversation?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation?.allMessages?.map((message) => message.role)).toEqual(['system', 'user', 'tool', 'assistant', 'status']);
    expect(conversation?.summary.excerpt).toBe('Visible assistant reply');
  });

  it('captures Codex exec session metadata for spawned conversations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '10');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 'rollout-codex-exec.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/demo-project',
          id: 'codex-exec',
          originator: 'codex_exec',
          source: 'exec',
          thread_source: 'user',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Programmatic prompt' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Programmatic reply' }],
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);

    expect(conversations[0]?.rawMetadata?.originator).toBe('codex_exec');
    expect(conversations[0]?.rawMetadata?.source).toBe('exec');
    expect(conversations[0]?.rawMetadata?.threadSource).toBe('user');
  });

  it('hides Codex harness instruction and environment wrapper messages from visible history', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-'));
    const sessionsDir = path.join(tempDir, 'sessions', '2026', '03', '10');
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, 'rollout-codex-wrapper-filter.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/demo-project',
          id: 'codex-wrapper-filter',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '# AGENTS.md instructions for /tmp/demo-project\n\n<INSTRUCTIONS>\nDo the thing\n</INSTRUCTIONS>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/tmp/demo-project</cwd>\n</environment_context>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Real user prompt',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-10T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Real assistant reply',
          }],
        },
      }),
    ].join('\n'));

    const provider = new CodexProvider();
    const settings = {
      id: 'codex',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
    } satisfies MergedProviderSettings;

    const conversation = await provider.getConversation(project, 'codex-wrapper-filter', settings);
    expect(conversation?.messages.map((message) => message.text)).toEqual([
      'Real user prompt',
      'Real assistant reply',
    ]);
    expect(conversation?.allMessages?.map((message) => message.text)).toContain('# AGENTS.md instructions for /tmp/demo-project\n\n<INSTRUCTIONS>\nDo the thing\n</INSTRUCTIONS>');
    expect(conversation?.allMessages?.map((message) => message.text)).toContain('<environment_context>\n  <cwd>/tmp/demo-project</cwd>\n</environment_context>');
  });

  it('filters Claude transcripts that explicitly belong to a different project', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const projectDir = path.join(tempDir, 'projects', '-tmp-demo-project-');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'other-project.jsonl'), `${JSON.stringify({
      role: 'user',
      text: 'Wrong project',
      cwd: '/tmp/another-project',
      timestamp: '2026-03-07T00:00:00.000Z',
    })}\n`);

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toEqual([]);
  });

  it('ignores Claude subagent transcripts when listing top-level conversations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const projectDir = path.join(tempDir, 'projects', '-tmp-demo-project-');
    await fs.mkdir(path.join(projectDir, '63c6c469-4df1-4c13-9fe4-253c8e24525c', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '63c6c469-4df1-4c13-9fe4-253c8e24525c.jsonl'), `${JSON.stringify({
      role: 'user',
      text: 'Top-level transcript',
      cwd: '/tmp/demo-project',
      timestamp: '2026-03-07T00:00:00.000Z',
    })}\n`);
    await fs.writeFile(path.join(projectDir, '63c6c469-4df1-4c13-9fe4-253c8e24525c', 'subagents', 'agent-acompact-c07e2c60c9406993.jsonl'), `${JSON.stringify({
      role: 'user',
      text: 'Subagent transcript',
      cwd: '/tmp/demo-project',
      timestamp: '2026-03-07T00:01:00.000Z',
    })}\n`);

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const conversations = await provider.listConversations(project, settings);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toContain('Top-level transcript');
  });

  it('extracts only visible Claude text from nested progress envelopes and drops metadata fields', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const projectDir = path.join(tempDir, 'projects', '-tmp-demo-project-');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'metadata-leak.jsonl'), [
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'Help me review this transcript parser',
        },
      }),
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:01.000Z',
        type: 'progress',
        data: {
          message: {
            type: 'assistant',
            message: {
              model: 'claude-haiku-4-5-20251001',
              id: 'msg_01G6Zj8HzQRWjKxmuRmDwFsU',
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'text', text: 'Visible assistant reply only.' },
              ],
            },
          },
        },
      }),
    ].join('\n'));

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const conversation = await provider.getConversation(project, 'metadata-leak', settings);
    expect(conversation?.messages.map((message) => message.text)).toEqual([
      'Help me review this transcript parser',
      'Visible assistant reply only.',
    ]);
    expect(conversation?.allMessages?.some((message) => message.text.includes('claude-haiku-4-5-20251001'))).toBe(false);
    expect(conversation?.allMessages?.some((message) => message.text.includes('msg_01G6Zj8HzQRWjKxmuRmDwFsU'))).toBe(false);
  });

  it('hides Claude local-command wrapper messages from the visible transcript but keeps them in allMessages', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-claude-'));
    const projectDir = path.join(tempDir, 'projects', '-tmp-demo-project-');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'local-command-filter.jsonl'), [
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/model</command-name>',
        },
      }),
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:01.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'Real visible user text',
        },
      }),
      JSON.stringify({
        cwd: '/tmp/demo-project',
        timestamp: '2026-03-10T00:00:02.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Real visible assistant text' }],
        },
      }),
    ].join('\n'));

    const provider = new ClaudeProvider();
    const settings = {
      id: 'claude',
      enabled: true,
      discoveryRoot: tempDir,
      commands: { newCommand: ['claude'], resumeCommand: ['claude', '--resume', '{{conversationId}}'], continueCommand: ['claude', '--continue'], env: {} },
    } satisfies MergedProviderSettings;

    const conversation = await provider.getConversation(project, 'local-command-filter', settings);
    expect(conversation?.messages.map((message) => message.text)).toEqual([
      'Real visible user text',
      'Real visible assistant text',
    ]);
    expect(conversation?.allMessages?.map((message) => message.text)).toContain('<command-name>/model</command-name>');
  });
});
