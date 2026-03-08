import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import type { MergedProviderSettings } from '../src/config/service.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  path: '/tmp/demo-project',
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

describe('provider history discovery', () => {
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
});
