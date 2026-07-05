import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { LiveOutputReader } from '../src/sessions/live-output/reader.js';

const liveOutputReader = new LiveOutputReader();
const readLiveMessages = liveOutputReader.readLiveMessages.bind(liveOutputReader);

describe('readLiveMessages', () => {
  it('keeps live message ids stable when the event-log tail window shifts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const rows = [
      JSON.stringify({ type: 'user-input', text: 'summarize the result', timestamp: '2026-07-01T02:00:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'The result is stable.', timestamp: '2026-07-01T02:00:01.000Z' }),
      JSON.stringify({ type: 'status', text: 'Bound codex session in Demo.', timestamp: '2026-07-01T02:00:02.000Z' }),
    ];
    await fs.writeFile(eventLogPath, `${rows.join('\n')}\n`);
    const targetOffset = Buffer.byteLength(`${rows[0]}\n`, 'utf8');

    const session: BoundSession = {
      id: 'session-stable-offset',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:stable-offset',
      tmuxSessionName: 'ac-codex-demo-stable-offset',
      status: 'bound',
      startedAt: '2026-07-01T02:00:00.000Z',
      updatedAt: '2026-07-01T02:00:02.000Z',
      eventLogPath,
    };

    const fullMessages = await readLiveMessages(session);
    const tailMessages = await readLiveMessages(session, {
      maxBytesFromEnd: Buffer.byteLength(`${rows[1]}\n${rows[2]}\n`, 'utf8') + 4,
    });
    const fullAssistant = fullMessages.find((message) => message.text === 'The result is stable.');
    const tailAssistant = tailMessages.find((message) => message.text === 'The result is stable.');

    expect(fullAssistant?.id).toBe(`live:${session.id}:${targetOffset}`);
    expect(tailAssistant?.id).toBe(fullAssistant?.id);
  });

  it('strips ansi noise and suppresses echoed user input from live chunks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Bound codex session in Demo.', timestamp: '2026-03-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'user-input', text: 'Reply with exactly PONG and nothing else.', timestamp: '2026-03-07T00:00:01.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[?2026h\u001b[1;1H\u001b[J\u001b[3;1H› Reply with exactly PONG and nothing else.\u001b[6;1Hgpt-5.4 xhigh · 100% left · ~/code/demo\u001b[?2026l', timestamp: '2026-03-07T00:00:02.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[32mPONG\u001b[39m', timestamp: '2026-03-07T00:00:03.000Z' }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-1',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test',
      tmuxSessionName: 'ac-codex-demo',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:03.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => message.role)).toEqual(['status', 'user', 'assistant']);
    expect(messages[2]?.text).toBe('PONG');
    expect(messages.some((message) => message.text.includes('\u001b'))).toBe(false);
  });

  it('keeps startup chrome in status and drops repaint fragments', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Bound codex session in Demo.', timestamp: '2026-03-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'user-input', text: 'Run the startup smoke check.', timestamp: '2026-03-07T00:00:00.500Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[2mTip:\u001b[22m When the composer is empty, press Esc to step back and edit your last', timestamp: '2026-03-07T00:00:01.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'message; Enter confirms. Starting MCP servers (0/3): chrome-devtools, codex_apps, playwright (0s esc to interrupt)', timestamp: '2026-03-07T00:00:02.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'St\nta\nart\nti\nSin\nng\nMCP\nsers', timestamp: '2026-03-07T00:00:03.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[32msmoke-ok\u001b[39m', timestamp: '2026-03-07T00:00:04.000Z' }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-2',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-2',
      tmuxSessionName: 'ac-codex-demo-2',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:04.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['smoke-ok']);
    expect(messages.some((message) => /Tip:|Starting MCP servers/.test(message.text) && message.role !== 'status')).toBe(false);
  });

  it('drops Claude compaction progress repaints after a submitted prompt', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'what was result', timestamp: '2026-07-01T19:20:45.128Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Again, sorry for the earlier misreport -- the death at 15:15 and "still running" readings were me matching unrelated processes.',
          '● Background command "Background waiter keyed on this run\'s exit file" completed (exit code 0)',
          '❯ /compact',
          '* Compacting conversation...',
          '▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 1%',
          '❯ what was result',
          'Press up to edit queued messages',
        ].join('\n'),
        timestamp: '2026-07-01T19:20:45.184Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '✶Co',
          'm',
          '✻Cp',
          'omac',
          'pt',
          '✽ai',
          'cn',
          'tig ',
          '1',
          'nc',
          'go',
          ' cnv',
          '✻oe',
          'nr',
          'vs',
          '✶erat',
          'si',
          '*ao',
          'tin...',
          '▰2',
        ].join('\n'),
        timestamp: '2026-07-01T19:20:55.304Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'The review result was clear: no blocking findings remain.',
        timestamp: '2026-07-01T19:21:30.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-compact-progress',
      provider: 'claude',
      projectSlug: 'waltiumweb',
      conversationRef: 'f2390870-ad17-4408-9b19-6f78eef6513a',
      tmuxSessionName: 'ac-claude-waltiumweb-compact-progress',
      status: 'bound',
      startedAt: '2026-07-01T19:20:45.000Z',
      updatedAt: '2026-07-01T19:21:30.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'what was result' },
      {
        role: 'assistant',
        source: 'live-output',
        text: 'The review result was clear: no blocking findings remain.',
      },
    ]);
  });

  it('keeps assistant prose that shares a raw chunk with compact progress', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'summarize result', timestamp: '2026-07-01T19:25:00.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'The check completed successfully.',
          '❯ /compact',
          '* Compacting conversation...',
          '▱▱▱▱▱▱▱▱▱▱ 1%',
        ].join('\n'),
        timestamp: '2026-07-01T19:25:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-compact-progress-with-prose',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'compact-progress-with-prose',
      tmuxSessionName: 'ac-claude-demo-compact-progress-with-prose',
      status: 'bound',
      startedAt: '2026-07-01T19:25:00.000Z',
      updatedAt: '2026-07-01T19:25:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'summarize result' },
      {
        role: 'assistant',
        source: 'live-output',
        text: 'The check completed successfully.',
      },
    ]);
  });

  it('keeps short assistant replies before compact progress and drops later progress repaint lines', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'answer with the number only', timestamp: '2026-07-01T19:27:00.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '42',
          '❯ /compact',
          '* Compacting conversation...',
          '▱▱▱▱▱▱▱▱▱▱ 1%',
        ].join('\n'),
        timestamp: '2026-07-01T19:27:01.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: '▰▱▱ 2%',
        timestamp: '2026-07-01T19:27:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-compact-progress-with-short-reply',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'compact-progress-with-short-reply',
      tmuxSessionName: 'ac-claude-demo-compact-progress-with-short-reply',
      status: 'bound',
      startedAt: '2026-07-01T19:27:00.000Z',
      updatedAt: '2026-07-01T19:27:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'answer with the number only' },
      { role: 'assistant', source: 'live-output', text: '42' },
    ]);
  });

  it('keeps percentage assistant replies when compact progress has not started', async () => {
    for (const reply of ['50%', '50%\nThe deployment is halfway done.']) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
      const eventLogPath = path.join(tempDir, 'events.jsonl');
      await fs.writeFile(eventLogPath, [
        JSON.stringify({ type: 'user-input', text: 'What percent is complete?', timestamp: '2026-07-01T19:28:00.000Z' }),
        JSON.stringify({
          type: 'raw-output',
          text: reply,
          timestamp: '2026-07-01T19:28:01.000Z',
        }),
      ].join('\n'));

      const session: BoundSession = {
        id: `session-percent-reply-${reply.length}`,
        provider: 'claude',
        projectSlug: 'demo',
        conversationRef: 'percent-reply',
        tmuxSessionName: 'ac-claude-demo-percent-reply',
        status: 'bound',
        startedAt: '2026-07-01T19:28:00.000Z',
        updatedAt: '2026-07-01T19:28:01.000Z',
        eventLogPath,
      };

      const messages = await readLiveMessages(session);
      expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
        { role: 'user', source: 'user-input', text: 'What percent is complete?' },
        { role: 'assistant', source: 'live-output', text: reply },
      ]);
    }
  });

  it('keeps assistant prose that mentions compact commands', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'How do I reduce context?', timestamp: '2026-07-01T19:30:00.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Use /compact when you want to reduce the active context.',
        timestamp: '2026-07-01T19:30:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-compact-prose',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'compact-prose',
      tmuxSessionName: 'ac-claude-demo-compact-prose',
      status: 'bound',
      startedAt: '2026-07-01T19:30:00.000Z',
      updatedAt: '2026-07-01T19:30:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'How do I reduce context?' },
      {
        role: 'assistant',
        source: 'live-output',
        text: 'Use /compact when you want to reduce the active context.',
      },
    ]);
  });

  it('keeps short assistant replies after compact progress when a new prompt starts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'summarize first', timestamp: '2026-07-01T19:40:00.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '❯ /compact',
          '* Compacting conversation...',
          '▱▱▱▱▱▱▱▱▱▱ 1%',
        ].join('\n'),
        timestamp: '2026-07-01T19:40:01.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '✶Co',
          'm',
          '✻Cp',
          'omac',
          'pt',
          '✽ai',
          'cn',
          'tig ',
        ].join('\n'),
        timestamp: '2026-07-01T19:40:02.000Z',
      }),
      JSON.stringify({ type: 'user-input', text: 'status', timestamp: '2026-07-01T19:41:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'Done.', timestamp: '2026-07-01T19:41:01.000Z' }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-compact-short-reply',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'compact-short-reply',
      tmuxSessionName: 'ac-claude-demo-compact-short-reply',
      status: 'bound',
      startedAt: '2026-07-01T19:40:00.000Z',
      updatedAt: '2026-07-01T19:41:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'summarize first' },
      { role: 'user', source: 'user-input', text: 'status' },
      { role: 'assistant', source: 'live-output', text: 'Done.' },
    ]);
  });

  it('suppresses restored terminal repaint output before a tracked user turn exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Bound codex session in Waltiumweb.', timestamp: '2026-07-01T12:32:15.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '› recap where we left things',
          'We left the usage-tracking work implemented and committed.',
          'Ran git status --short && git log -3 --oneline --decorate',
          'g 10s esc to interupt)',
          'kiin ng',
          'Woorrk',
        ].join('\n'),
        timestamp: '2026-07-01T12:32:28.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-restored-repaint',
      provider: 'codex',
      projectSlug: 'waltiumweb',
      conversationRef: '019f19aa-433d-72c3-a42c-a9a01d659377',
      tmuxSessionName: 'ac-codex-waltiumweb-restored',
      status: 'bound',
      startedAt: '2026-07-01T12:32:15.000Z',
      updatedAt: '2026-07-01T12:32:28.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => message.role)).toEqual(['status']);
    expect(messages.some((message) => /recap where we left things|usage-tracking|Ran git status|kiin|Woorrk/.test(message.text))).toBe(false);
  });

  it('keeps prefixed Claude terminal status lines out of assistant messages', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Give me the actual result only.', timestamp: '2026-06-30T19:14:01.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '\u273b Baked for 12m 40s',
          '',
          '\u25cf Background command "Proof-gated Codex review of ingest layer" failed with exit',
          'code 144',
          '',
          '\u273d Gusting...',
          '  tmux focus-events off \u00b7 add \'set -g focus-events on\' to ~/.tmux.conf and rea\u2026',
          '',
          'Actual assistant prose that should remain.',
        ].join('\n'),
        timestamp: '2026-06-30T19:14:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-status',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'claude-status',
      tmuxSessionName: 'ac-claude-demo-status',
      status: 'bound',
      startedAt: '2026-06-30T19:00:00.000Z',
      updatedAt: '2026-06-30T19:14:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    const assistantTexts = messages.filter((message) => message.role === 'assistant').map((message) => message.text);
    expect(assistantTexts).toEqual(['Actual assistant prose that should remain.']);
    expect(assistantTexts.some((text) => /Baked|Background command|code 144|Gusting|tmux focus-events/.test(text))).toBe(false);
  });

  it('keeps assistant prose that mentions tokens or short complete replies', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Explain token counting briefly.', timestamp: '2026-07-01T03:19:59.000Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Tokens are counted after normalization.',
          'Done',
        ].join('\n'),
        timestamp: '2026-07-01T03:20:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-token-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:token-prose',
      tmuxSessionName: 'ac-codex-demo-token-prose',
      status: 'bound',
      startedAt: '2026-07-01T03:20:00.000Z',
      updatedAt: '2026-07-01T03:20:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'Tokens are counted after normalization.\nDone',
    ]);
  });

  it('keeps numeric-only assistant replies outside picker chunks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply with the answer number only.',
        timestamp: '2026-07-01T03:20:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: '42',
        timestamp: '2026-07-01T03:21:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-numeric-reply',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:numeric-reply',
      tmuxSessionName: 'ac-codex-demo-numeric-reply',
      status: 'bound',
      startedAt: '2026-07-01T03:21:00.000Z',
      updatedAt: '2026-07-01T03:21:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['42']);
  });

  it('does not remove prior assistant text from a later sentence that extends it', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'What command should I run?',
        timestamp: '2026-07-01T03:24:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Run npm test',
        timestamp: '2026-07-01T03:25:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Run npm test after the build finishes.',
        timestamp: '2026-07-01T03:25:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-repeated-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:repeated-prose',
      tmuxSessionName: 'ac-codex-demo-repeated-prose',
      status: 'bound',
      startedAt: '2026-07-01T03:25:00.000Z',
      updatedAt: '2026-07-01T03:25:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'Run npm test\nRun npm test after the build finishes.',
    ]);
  });

  it('keeps repeated assistant answers across separate user turns', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'First check',
        timestamp: '2026-07-01T03:25:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'No findings.',
        timestamp: '2026-07-01T03:25:01.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Second check',
        timestamp: '2026-07-01T03:25:10.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'No findings.',
        timestamp: '2026-07-01T03:25:11.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-repeated-answer',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:repeated-answer',
      tmuxSessionName: 'ac-codex-demo-repeated-answer',
      status: 'bound',
      startedAt: '2026-07-01T03:25:00.000Z',
      updatedAt: '2026-07-01T03:25:11.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'First check' },
      { role: 'assistant', source: 'live-output', text: 'No findings.' },
      { role: 'user', source: 'user-input', text: 'Second check' },
      { role: 'assistant', source: 'live-output', text: 'No findings.' },
    ]);
  });

  it('keeps assistant prose that contains status-like words', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'What changed?',
        timestamp: '2026-07-01T03:25:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'I worked on the parser.',
        timestamp: '2026-07-01T03:25:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-status-like-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:status-like-prose',
      tmuxSessionName: 'ac-codex-demo-status-like-prose',
      status: 'bound',
      startedAt: '2026-07-01T03:25:00.000Z',
      updatedAt: '2026-07-01T03:25:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'What changed?' },
      { role: 'assistant', source: 'live-output', text: 'I worked on the parser.' },
    ]);
  });

  it('does not suppress earlier assistant output that a later user input repeats', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Suggest the test command.',
        timestamp: '2026-07-01T03:25:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Run npm test',
        timestamp: '2026-07-01T03:26:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Run npm test',
        timestamp: '2026-07-01T03:26:10.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Test run started.',
        timestamp: '2026-07-01T03:26:11.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-future-user-echo',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:future-user-echo',
      tmuxSessionName: 'ac-codex-demo-future-user-echo',
      status: 'bound',
      startedAt: '2026-07-01T03:26:00.000Z',
      updatedAt: '2026-07-01T03:26:11.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Suggest the test command.' },
      { role: 'assistant', source: 'live-output', text: 'Run npm test' },
      { role: 'user', source: 'user-input', text: 'Run npm test' },
      { role: 'assistant', source: 'live-output', text: 'Test run started.' },
    ]);
  });

  it('keeps only the final Claude live answer when the prompt echo is logged before submit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: '\u001b(B\nReply exactly CLAUDE_SINGLE_OK',
        timestamp: '2026-07-01T01:53:20.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_SINGLE_OK',
        timestamp: '2026-07-01T01:53:21.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '\u001b(B',
          'D',
          '*2',
          'D',
          'Gallivanting…',
          'Scmp',
          'pein',
          'i…',
          '\u2736n',
          'g…',
          '\u2736rg',
          '(1s · thinking)',
          '·enthinking',
          '*aliv',
          'CLAUDE_SINGLE_OK',
          'Cogitated for 1s',
          'Churned for 1s',
          '← for agents',
        ].join('\n'),
        timestamp: '2026-07-01T01:53:24.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-live-answer',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-live-answer',
      tmuxSessionName: 'ac-claude-demo-live-answer',
      status: 'bound',
      startedAt: '2026-07-01T01:53:00.000Z',
      updatedAt: '2026-07-01T01:53:24.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_SINGLE_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_SINGLE_OK' },
    ]);
  });

  it('drops provider command menus and keeps only actual prompt and answer text', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: [
          '/waltium-portfolio-data Use for deterministic Waltium portfolio records and portfolio data configuration: a…',
          'Switch between Claude models. Your pick becomes the default for new',
          'sessions. For other/previous model names, specify with --model.',
          '3. SonnetSonnet 5 · Efficient for routine tasks',
          '5. Fable (disabled)Claude Fable 5 is currently unavailable. Learn',
          'more: https://www.anthropic.com/news/fable-mythos-access',
          '○ Effort not supported for Haiku',
          'Enter to set as default · s to use this session only · Esc to cancel',
          '⚠ 2 MCP servers need authentication · run /mcp',
          '/code-review Review the current diff for correctness bugs',
          'and reuse/simplification/efficiency cleanup…',
          'Effort',
          'Faster Smarter',
          'lowmediumhighxhighmax',
          '←/→ to adjust · Enter to confirm · Esc to cancel',
          'Queued follow-up inputs',
          '↳ 3',
          'shift + ← edit last queued message',
          'permissions: YOLO mode',
        ].join('\n'),
        timestamp: '2026-07-01T02:12:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLEAN_MENU_OK',
        timestamp: '2026-07-01T02:12:01.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          '⎿ Cancelled',
          'tmux detected · scroll with PgUp/PgDn · or add set -g mouse on',
          'CLEAN_MENU_OK',
          'Churned for 3s',
        ].join('\n'),
        timestamp: '2026-07-01T02:12:04.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-menu-noise',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:menu-noise',
      tmuxSessionName: 'ac-claude-demo-menu-noise',
      status: 'bound',
      startedAt: '2026-07-01T02:12:00.000Z',
      updatedAt: '2026-07-01T02:12:04.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLEAN_MENU_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLEAN_MENU_OK' },
    ]);
  });

  it('keeps assistant prose that mentions portfolio data configuration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'What did you fix?',
        timestamp: '2026-07-01T02:16:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'I fixed the portfolio data configuration bug.',
        timestamp: '2026-07-01T02:17:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-portfolio-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:portfolio-prose',
      tmuxSessionName: 'ac-codex-demo-portfolio-prose',
      status: 'bound',
      startedAt: '2026-07-01T02:17:00.000Z',
      updatedAt: '2026-07-01T02:17:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'What did you fix?' },
      { role: 'assistant', source: 'live-output', text: 'I fixed the portfolio data configuration bug.' },
    ]);
  });

  it('keeps assistant prose that mentions Codex starter prompt text', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'How should I start?',
        timestamp: '2026-07-01T02:17:29.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'I can explain this codebase by walking through the server.',
          'Use Write tests for @filename as an example prompt.',
        ].join('\n'),
        timestamp: '2026-07-01T02:17:30.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-starter-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:starter-prose',
      tmuxSessionName: 'ac-codex-demo-starter-prose',
      status: 'bound',
      startedAt: '2026-07-01T02:17:30.000Z',
      updatedAt: '2026-07-01T02:17:30.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'How should I start?' },
      {
        role: 'assistant',
        source: 'live-output',
        text: [
          'I can explain this codebase by walking through the server.',
          'Use Write tests for @filename as an example prompt.',
        ].join('\n'),
      },
    ]);
  });

  it('does not collapse non-exact prose that contains the requested exact reply', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly OK',
        timestamp: '2026-07-01T02:18:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'The answer is OK, plus context.',
        timestamp: '2026-07-01T02:18:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-non-exact-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:non-exact-prose',
      tmuxSessionName: 'ac-codex-demo-non-exact-prose',
      status: 'bound',
      startedAt: '2026-07-01T02:18:00.000Z',
      updatedAt: '2026-07-01T02:18:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly OK' },
      { role: 'assistant', source: 'live-output', text: 'The answer is OK, plus context.' },
    ]);
  });

  it('strips Codex startup repaint text glued to a live answer marker', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CODEX_CLEAN_OK',
        timestamp: '2026-07-01T02:27:25.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
          text: [
          'Youhave3usagelimitresetsavailable.Run/usagetouseone.CODEX_CLEAN_OK›Write tests for @filenamegpt-5.4-mini medium · ~/code/UberCoder/agent-console-mvp/agent-console',
          'You have 3 usage limit resets available. Run /usage to use one.›Write tests for @filenamegpt-5.4-mini medium · ~/code/UberCoder/agent-console-mvp/agent-console',
          'Starting MCP servers (0/4): chrome-devtools, codex_apps, openaiDeveloperDocs,…›Write tests for @filenamegpt-5.4-mini medium · ~/code/UberCoder/agent-console-mvp/agent-console',
          'SttarrtiSinStang art MCart MC1playwright (0s ecar MrtiMCPinP ng seng se2playwright',
          'Working (1s sc tointerrupt)ngg 2 WWoorrkkiinWng 3Wogorrkkiinngg 4 WWoorrk kiinWng5Wog',
          'CODEX_CLEAN_OK›Write tests for @filenamegpt-5.4-mini medium · ~/code/UberCoder/agent-console-mvp/agent-console',
        ].join('\n'),
        timestamp: '2026-07-01T02:27:30.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-codex-startup-repaint',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:codex-startup-repaint',
      tmuxSessionName: 'ac-codex-demo-startup-repaint',
      status: 'bound',
      startedAt: '2026-07-01T02:27:00.000Z',
      updatedAt: '2026-07-01T02:27:30.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CODEX_CLEAN_OK' },
      { role: 'assistant', source: 'live-output', text: 'CODEX_CLEAN_OK' },
    ]);
  });

  it('drops interleaved Codex MCP startup repaint text before live assistant updates', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'research held away asset billing',
        timestamp: '2026-07-05T15:21:20.259Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Tip: Use /compact when the conversation gets long to summarize history and',
          'free up context.',
          'research held away asset billing',
          'Starting MCP servers (0/4): chrome-devtools, codex_apps, openaiDeveloperDocs,...1playwright (0s * ecSStaarrtiti2playwright (0s * esc o interrup',
          'StinStngtag ar MrtiMCPinP ng sg se MCervCPveP er sers er (rv(2ve2/er/4rs 4):rvers (3/4): (0s * esc o interrupt)rv(3ver3/4rs4)1s ): (: (3 c3/ch',
          'rkkiin◦ngg•6',
          '• I will use the advisor-web-research skill because this is current RIA/practice research.',
          'Explored',
          'Ran pwd && rg --files',
          'Searched the web for RIA held away billing',
          'W◦WoorrkkiinWng7Wogor•rkkiin',
          'ngg',
          '• The local wrapper delegates to the global web-research skill and requires source links plus an audit handle.',
        ].join('\n'),
        timestamp: '2026-07-05T15:21:31.566Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-codex-interleaved-mcp-repaint',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:codex-interleaved-mcp-repaint',
      tmuxSessionName: 'ac-codex-demo-interleaved-mcp-repaint',
      status: 'bound',
      startedAt: '2026-07-05T15:21:20.000Z',
      updatedAt: '2026-07-05T15:21:31.000Z',
      eventLogPath,
    };

    const messages = (await readLiveMessages(session))
      .filter((message) => message.role === 'user' || message.role === 'assistant');
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'research held away asset billing' },
      {
        role: 'assistant',
        source: 'live-output',
        text: 'I will use the advisor-web-research skill because this is current RIA/practice research.',
      },
      {
        role: 'assistant',
        source: 'live-output',
        text: 'The local wrapper delegates to the global web-research skill and requires source links plus an audit handle.',
      },
    ]);
  });

  it('does not render Claude slash-command screens as assistant transcript content', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Claude Code v2.1.197',
          'Haiku 4.5 · Claude Max',
          '/model Set the AI model for Claude Code (currently Haiku 4.5)',
          '❯ /model',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n'),
        timestamp: '2026-07-01T02:44:19.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_CLEAN_OK',
        timestamp: '2026-07-01T02:45:56.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Press up to edit queued messages · esc to interrupt · ← for agents',
          "I'm not sure what you're asking for with /model/model. Could you clarify what you'd like to do?",
          'A few possibilities:',
          'Check the current model? You are running on Claude Haiku 4.5',
          'Switch to a faster mode? Use /fast to toggle to Opus with faster output',
          'Invoke a skill? Skills use the format /skill-name',
          'ReplyexactlyCLAUDE_CLEAN_OK',
          'CLAUDE_CLEAN_OK',
          'Crunched for 3s',
        ].join('\n'),
        timestamp: '2026-07-01T02:46:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-slash-command',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-slash-command',
      tmuxSessionName: 'ac-claude-demo-slash-command',
      status: 'bound',
      startedAt: '2026-07-01T02:44:00.000Z',
      updatedAt: '2026-07-01T02:46:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_CLEAN_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_CLEAN_OK' },
    ]);
  });

  it('drops stale provider model selection user-input rows from existing logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Claude Code',
          'Select model',
          '1. Default',
          '2. Opus',
          '3. Sonnet',
          '4. Haiku',
          'Enter to set as default · s to use this session only · Esc to cancel',
        ].join('\n'),
        timestamp: '2026-07-01T02:50:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: '4',
        timestamp: '2026-07-01T02:50:01.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Set model to Haiku 4.5 and saved as your default for new sessions',
        timestamp: '2026-07-01T02:50:02.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly AFTER_MODEL_OK',
        timestamp: '2026-07-01T02:51:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'AFTER_MODEL_OK',
        timestamp: '2026-07-01T02:51:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-stale-model-selection',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:stale-model-selection',
      tmuxSessionName: 'ac-claude-demo-stale-model-selection',
      status: 'bound',
      startedAt: '2026-07-01T02:50:00.000Z',
      updatedAt: '2026-07-01T02:51:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly AFTER_MODEL_OK' },
      { role: 'assistant', source: 'live-output', text: 'AFTER_MODEL_OK' },
    ]);
  });

  it('keeps numeric user replies outside provider command menus', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Give me numbered options.',
        timestamp: '2026-07-01T02:54:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Choose the next step:',
          '1. Run the targeted tests',
          '2. Inspect the debug logs',
        ].join('\n'),
        timestamp: '2026-07-01T02:55:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: '2',
        timestamp: '2026-07-01T02:55:01.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'I will inspect the debug logs.',
        timestamp: '2026-07-01T02:55:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-numeric-reply',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:numeric-reply',
      tmuxSessionName: 'ac-codex-demo-numeric-reply',
      status: 'bound',
      startedAt: '2026-07-01T02:55:00.000Z',
      updatedAt: '2026-07-01T02:55:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Give me numbered options.' },
      { role: 'assistant', source: 'live-output', text: 'Choose the next step:\n1. Run the targeted tests\n2. Inspect the debug logs' },
      { role: 'user', source: 'user-input', text: '2' },
      { role: 'assistant', source: 'live-output', text: 'I will inspect the debug logs.' },
    ]);
  });

  it('keeps only new Claude output when the terminal repaints prior turns', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_FIRST_OK',
        timestamp: '2026-07-01T03:00:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'CLAUDE_FIRST_OK\nWorked for 2s',
        timestamp: '2026-07-01T03:00:02.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_SECOND_OK',
        timestamp: '2026-07-01T03:01:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Reply exactly CLAUDE_FIRST_OK',
          'CLAUDE_FIRST_OK',
          'Churned for 1s',
          'Reply exactly CLAUDE_SECOND_OK',
          'CLAUDE_SECOND_OKSautéedfor2s',
        ].join('\n'),
        timestamp: '2026-07-01T03:01:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-repaint-prior-turns',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-repaint-prior-turns',
      tmuxSessionName: 'ac-claude-demo-repaint-prior-turns',
      status: 'bound',
      startedAt: '2026-07-01T03:00:00.000Z',
      updatedAt: '2026-07-01T03:01:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_FIRST_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_FIRST_OK' },
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_SECOND_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_SECOND_OK' },
    ]);
  });

  it('drops provider model-menu repaint chunks after an exact assistant reply', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_MODEL_MENU_OK',
        timestamp: '2026-07-01T03:10:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'CLAUDE_MODEL_MENU_OK',
        timestamp: '2026-07-01T03:10:02.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Reply exactly CLAUDE_MODEL_MENU_OK',
          'CLAUDE_MODEL_MENU_OK',
          'Select model',
          '1. Default(recommended)Opus 4.8 with 1M context · Best for everyday,',
          '2. OpusOpus 4.8 with 1M context · Best for everyday,',
          '4. Haiku ✔ Haiku 4.5 · Fastest for quick answers',
          'Use /fast to turn on Fast mode (Opus 4.8).',
        ].join('\n'),
        timestamp: '2026-07-01T03:11:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-model-menu-repaint',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-model-menu-repaint',
      tmuxSessionName: 'ac-claude-demo-model-menu-repaint',
      status: 'bound',
      startedAt: '2026-07-01T03:10:00.000Z',
      updatedAt: '2026-07-01T03:11:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_MODEL_MENU_OK' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_MODEL_MENU_OK' },
    ]);
  });

  it('keeps exact replies when stale Claude status repaint lines precede the answer', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_REAL_FILL_1782876390000',
        timestamp: '2026-07-01T03:25:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'CLAUDE_REAL_FILL_1782876390000',
        timestamp: '2026-07-01T03:25:02.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_RESTART_CLEAN_1782876900000',
        timestamp: '2026-07-01T03:26:35.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Reply exactly CLAUDE_REAL_FILL_1782876390000',
          'CLAUDE_REAL_FILL_1782876390000',
          'START_CLEAN_18287690000',
          'SetmodeltoHaiku 4.5andsavedasyourdefaultfornewsessions',
          'Tip: Connect Claude to your IDE · /ide',
        ].join('\n'),
        timestamp: '2026-07-01T03:26:36.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: ['M', '*o', 's', 'Me', 'osyi', 'en', 'Mosyin'].join('\n'),
        timestamp: '2026-07-01T03:26:37.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Reply exactly CLAUDE_RESTART_CLEAN_1782876900000',
          'CLAUDE_RESTART_CLEAN_1782876900000',
          'Brewed for 2s',
        ].join('\n'),
        timestamp: '2026-07-01T03:26:38.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-stale-status-before-answer',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-stale-status-before-answer',
      tmuxSessionName: 'ac-claude-demo-stale-status-before-answer',
      status: 'bound',
      startedAt: '2026-07-01T03:26:00.000Z',
      updatedAt: '2026-07-01T03:26:38.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_REAL_FILL_1782876390000' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_REAL_FILL_1782876390000' },
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_RESTART_CLEAN_1782876900000' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_RESTART_CLEAN_1782876900000' },
    ]);
  });

  it('drops Claude animated-status character fragments after an exact reply', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Reply exactly CLAUDE_RESTART_INPUT_OK_1782877501580',
        timestamp: '2026-07-01T03:45:06.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'CLAUDE_RESTART_INPUT_OK_1782877501580',
        timestamp: '2026-07-01T03:45:07.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: ['Ti', 'n', 'Tk', 'iner', 'ki', 'en', 'rg', 'in…', '*g', '…'].join('\n'),
        timestamp: '2026-07-01T03:45:08.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'Reply exactly CLAUDE_RESTART_INPUT_OK_1782877501580',
          'CLAUDE_RESTART_INPUT_OK_1782877501580',
          'Tinkering…',
          'Baked for 1s',
        ].join('\n'),
        timestamp: '2026-07-01T03:45:09.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-exact-reply-status-fragments',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:claude-exact-reply-status-fragments',
      tmuxSessionName: 'ac-claude-demo-exact-reply-status-fragments',
      status: 'bound',
      startedAt: '2026-07-01T03:45:00.000Z',
      updatedAt: '2026-07-01T03:45:09.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'Reply exactly CLAUDE_RESTART_INPUT_OK_1782877501580' },
      { role: 'assistant', source: 'live-output', text: 'CLAUDE_RESTART_INPUT_OK_1782877501580' },
    ]);
  });

  it('keeps legitimate assistant prose that contains a short user prompt', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'tokens',
        timestamp: '2026-07-01T03:30:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'Tokens are counted after normalization.',
        timestamp: '2026-07-01T03:30:02.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-short-prompt-legitimate-prose',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:short-prompt-legitimate-prose',
      tmuxSessionName: 'ac-codex-demo-short-prompt-legitimate-prose',
      status: 'bound',
      startedAt: '2026-07-01T03:30:00.000Z',
      updatedAt: '2026-07-01T03:30:02.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
      { role: 'user', source: 'user-input', text: 'tokens' },
      { role: 'assistant', source: 'live-output', text: 'Tokens are counted after normalization.' },
    ]);
  });

  it('reads a bounded event-log tail from the next complete JSONL row', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: `This old live output should be outside the bounded tail. old-tail-needle ${'x'.repeat(4000)}`,
        timestamp: '2026-03-07T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Only the recent complete user row should remain.',
        timestamp: '2026-03-07T00:01:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'recent bounded tail answer',
        timestamp: '2026-03-07T00:01:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-3',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-3',
      tmuxSessionName: 'ac-codex-demo-3',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:01:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session, { maxBytesFromEnd: 512 });
    expect(messages.map((message) => message.text)).toEqual([
      'Only the recent complete user row should remain.',
      'recent bounded tail answer',
    ]);
    expect(messages.some((message) => message.text.includes('old-tail-needle'))).toBe(false);
  });

  it('uses the preceding user input as echo-suppression context for bounded raw-output tails', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const prompt = 'Summarize the live dashboard without echoing this prompt.';
    const answer = 'The dashboard summary is ready.';
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: prompt,
        timestamp: '2026-03-07T00:02:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          `› ${prompt}`,
          `gpt-5.4 xhigh · 100% left · ~/code/demo ${'payloadword '.repeat(120)}`,
          answer,
        ].join('\n'),
        timestamp: '2026-03-07T00:02:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-context-tail',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:context-tail',
      tmuxSessionName: 'ac-codex-demo-context-tail',
      status: 'bound',
      startedAt: '2026-03-07T00:02:00.000Z',
      updatedAt: '2026-03-07T00:02:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session, { maxBytesFromEnd: 512 });
    expect(messages.map((message) => message.text)).toEqual([
      answer,
    ]);
    expect(messages.some((message) => message.text.includes(prompt))).toBe(false);
  });

  it('keeps the latest complete JSONL row when it starts before the bounded tail', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const oversizedRecentText = `recent oversized needle ${'payloadword '.repeat(300)}`;
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'Give me the oversized recent answer.',
        timestamp: '2026-03-07T00:01:59.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: oversizedRecentText,
        timestamp: '2026-03-07T00:02:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-4',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-4',
      tmuxSessionName: 'ac-codex-demo-4',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:02:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session, { maxBytesFromEnd: 512 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain('recent oversized needle');
  });
});
