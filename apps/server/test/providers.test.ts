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
