#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolvePath(input) {
  return path.resolve(expandHome(input));
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.AGENT_CONSOLE_BASE_URL ?? 'http://127.0.0.1:4317',
    password: process.env.AGENT_CONSOLE_PASSWORD,
    project: process.env.AGENT_CONSOLE_PROJECT,
    config: process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json',
    timeoutMs: Number(process.env.AGENT_CONSOLE_TIMEOUT_MS ?? 120000),
    pollMs: Number(process.env.AGENT_CONSOLE_POLL_MS ?? 5000),
    keepSession: false,
    prompt: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--base-url':
        options.baseUrl = next;
        index += 1;
        break;
      case '--password':
        options.password = next;
        index += 1;
        break;
      case '--project':
        options.project = next;
        index += 1;
        break;
      case '--config':
        options.config = next;
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(next);
        index += 1;
        break;
      case '--poll-ms':
        options.pollMs = Number(next);
        index += 1;
        break;
      case '--prompt':
        options.prompt = next;
        index += 1;
        break;
      case '--keep-session':
        options.keepSession = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.password) {
    throw new Error('Missing password. Pass --password or set AGENT_CONSOLE_PASSWORD.');
  }
  if (!options.project) {
    throw new Error('Missing project slug. Pass --project or set AGENT_CONSOLE_PROJECT.');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error(`Invalid --poll-ms value: ${options.pollMs}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run smoke:codex -- --project <slug> --password <password> [options]

Required:
  --project <slug>         Active project directory name / slug
  --password <password>    Agent Console login password

Optional:
  --base-url <url>         Backend base URL (default: http://127.0.0.1:4317)
  --config <path>          App config path (default: ~/.config/agent-console/config.json)
  --timeout-ms <ms>        Total adoption timeout (default: 120000)
  --poll-ms <ms>           Refresh/poll interval (default: 5000)
  --prompt <text>          Custom prompt. By default the script generates a unique token prompt.
  --keep-session           Leave the bound tmux session running on failure for debugging

What it validates:
  - a new Codex conversation binds to a hidden detached tmux session
  - the prompt is accepted by the bound session
  - the pending conversation adopts to a real Codex conversation ref
  - the adopted conversation exposes a transcriptPath under the configured Codex sessions root
  - the transcript file contains the unique prompt token
  - release tears down the tmux session cleanly
`);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(resolvePath(filePath), 'utf8'));
  } catch {
    return undefined;
  }
}

function resolveCodexSessionsRoot(config, projectSlug) {
  const projectConfig = config?.projects?.[projectSlug];
  const globalProvider = config?.providers?.codex ?? {};
  const projectProvider = projectConfig?.providers?.codex ?? {};
  const mergedEnv = {
    ...(globalProvider.commands?.env ?? {}),
    ...(projectProvider.commands?.env ?? {}),
  };
  const discoveryRoot =
    mergedEnv.CODEX_HOME
    ?? projectProvider.discoveryRoot
    ?? globalProvider.discoveryRoot
    ?? process.env.CODEX_HOME
    ?? '~/.codex';
  return path.join(resolvePath(discoveryRoot), 'sessions');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(baseUrl, cookie, csrfToken, pathname, init = {}) {
  const headers = {
    ...(init.headers ?? {}),
    cookie,
    'x-csrf-token': csrfToken,
  };
  if (init.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function login(baseUrl, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${text}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const json = text ? JSON.parse(text) : {};
  return {
    cookie,
    csrfToken: json.csrfToken,
  };
}

function tmuxSessionInfo(sessionName) {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_attached}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith(`${sessionName}\t`));
    if (!line) return { exists: false, attached: undefined };
    const [, attached] = line.split('\t');
    return { exists: true, attached: Number(attached) };
  } catch {
    return { exists: false, attached: undefined };
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findTranscriptByRef(sessionsRoot, actualRef) {
  const matches = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl') && fullPath.includes(actualRef)) {
        matches.push(fullPath);
      }
    }
  }

  await walk(sessionsRoot);
  return matches[0];
}

function summarizeConversationNode(projectTree, projectSlug, ref) {
  const project = projectTree.projects.find((entry) => entry.slug === projectSlug);
  if (!project) return undefined;
  return project.providers.codex.conversations.find((conversation) => conversation.ref === ref);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readJsonIfExists(options.config);
  const sessionsRoot = resolveCodexSessionsRoot(config, options.project);
  const uniqueToken = `codex-smoke-${Date.now()}`;
  const prompt = options.prompt ?? `Reply with exactly: ${uniqueToken}`;
  const promptNeedle = options.prompt ?? uniqueToken;

  const diagnostics = {
    baseUrl: options.baseUrl,
    project: options.project,
    sessionsRoot,
    prompt,
    pendingRef: undefined,
    actualRef: undefined,
    tmuxSessionName: undefined,
    transcriptPath: undefined,
    released: false,
  };

  const { cookie, csrfToken } = await login(options.baseUrl, options.password);

  let sessionId;
  try {
    const refresh = await api(options.baseUrl, cookie, csrfToken, '/api/projects/refresh', { method: 'POST' });
    assert(refresh.response.ok, `Initial refresh failed: ${refresh.response.status} ${refresh.text}`);

    const beforeProject = refresh.json?.projects?.find((project) => project.slug === options.project);
    assert(beforeProject, `Project ${options.project} not found in /api/projects/refresh.`);
    assert(beforeProject.providers?.codex, `Project ${options.project} does not expose a Codex provider node.`);

    console.log(`Starting new Codex session for project ${options.project} against ${options.baseUrl}`);
    const bind = await api(options.baseUrl, cookie, csrfToken, `/api/conversations/${encodeURIComponent(options.project)}/codex/new/bind`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert(bind.response.ok, `Bind failed: ${bind.response.status} ${bind.text}`);

    sessionId = bind.json?.session?.id;
    diagnostics.pendingRef = bind.json?.conversationRef;
    diagnostics.tmuxSessionName = bind.json?.session?.tmuxSessionName;

    assert(sessionId, 'Bind response did not include session.id.');
    assert(diagnostics.pendingRef?.startsWith('pending:'), `Expected pending ref, got ${diagnostics.pendingRef ?? 'undefined'}.`);
    assert(diagnostics.tmuxSessionName, 'Bind response did not include tmuxSessionName.');

    const tmuxInfo = tmuxSessionInfo(diagnostics.tmuxSessionName);
    assert(tmuxInfo.exists, `tmux session ${diagnostics.tmuxSessionName} was not created.`);
    assert(tmuxInfo.attached === 0, `tmux session ${diagnostics.tmuxSessionName} is attached; expected hidden detached session.`);

    console.log(`tmux session ${diagnostics.tmuxSessionName} created in detached mode`);
    const send = await api(options.baseUrl, cookie, csrfToken, `/api/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: prompt }),
    });
    assert(send.response.ok, `Send failed: ${send.response.status} ${send.text}`);
    console.log(`Prompt sent: ${prompt}`);

    const deadline = Date.now() + options.timeoutMs;
    let finalTimeline;
    let finalTree;
    while (Date.now() < deadline) {
      await sleep(options.pollMs);
      finalTree = await api(options.baseUrl, cookie, csrfToken, '/api/projects/refresh', { method: 'POST' });
      assert(finalTree.response.ok, `Refresh failed during polling: ${finalTree.response.status} ${finalTree.text}`);

      finalTimeline = await api(
        options.baseUrl,
        cookie,
        csrfToken,
        `/api/conversations/${encodeURIComponent(options.project)}/codex/${encodeURIComponent(diagnostics.pendingRef)}/messages`,
      );
      assert(finalTimeline.response.ok, `Timeline fetch failed: ${finalTimeline.response.status} ${finalTimeline.text}`);

      diagnostics.actualRef = finalTimeline.json?.conversation?.ref;
      diagnostics.transcriptPath = finalTimeline.json?.conversation?.transcriptPath;

      const userMessages = (finalTimeline.json?.messages ?? []).filter((message) => message.role === 'user');
      const sawPrompt = userMessages.some((message) => typeof message.text === 'string' && message.text.includes(promptNeedle));
      const adopted = diagnostics.actualRef && diagnostics.actualRef !== diagnostics.pendingRef && !diagnostics.actualRef.startsWith('pending:');

      if (adopted && sawPrompt) {
        break;
      }
    }

    assert(finalTimeline, 'Polling finished without a timeline response.');
    assert(diagnostics.actualRef, 'No conversation ref was returned from the timeline route.');
    assert(diagnostics.actualRef !== diagnostics.pendingRef, `Pending ref was not adopted within ${options.timeoutMs}ms.`);

    const transcriptPath = diagnostics.transcriptPath
      ? resolvePath(diagnostics.transcriptPath)
      : await findTranscriptByRef(sessionsRoot, diagnostics.actualRef);
    assert(transcriptPath, `Could not find a Codex transcript file for adopted ref ${diagnostics.actualRef}.`);
    diagnostics.transcriptPath = transcriptPath;

    assert(transcriptPath.startsWith(sessionsRoot), `Transcript path ${transcriptPath} is not under expected sessions root ${sessionsRoot}.`);
    assert(await fileExists(transcriptPath), `Transcript path does not exist: ${transcriptPath}`);

    const transcriptText = await fs.readFile(transcriptPath, 'utf8');
    assert(transcriptText.includes(promptNeedle), `Transcript file ${transcriptPath} does not contain the expected prompt text.`);

    const treeProject = finalTree.json.projects.find((project) => project.slug === options.project);
    assert(treeProject, `Project ${options.project} missing from final tree response.`);
    assert(!summarizeConversationNode(finalTree.json, options.project, diagnostics.pendingRef), 'Pending placeholder still appears in the Codex tree after adoption.');

    const adoptedNode = summarizeConversationNode(finalTree.json, options.project, diagnostics.actualRef);
    assert(adoptedNode, `Adopted conversation ${diagnostics.actualRef} missing from the Codex tree.`);
    assert(adoptedNode.isBound === true, `Adopted conversation ${diagnostics.actualRef} is not marked bound before release.`);

    const release = await api(options.baseUrl, cookie, csrfToken, `/api/sessions/${encodeURIComponent(sessionId)}/release`, {
      method: 'POST',
    });
    assert(release.response.status === 204, `Release failed: ${release.response.status} ${release.text}`);
    diagnostics.released = true;

    const postReleaseTmux = tmuxSessionInfo(diagnostics.tmuxSessionName);
    assert(!postReleaseTmux.exists, `tmux session ${diagnostics.tmuxSessionName} still exists after release.`);

    const afterRelease = await api(options.baseUrl, cookie, csrfToken, '/api/projects/tree');
    assert(afterRelease.response.ok, `Post-release tree fetch failed: ${afterRelease.response.status} ${afterRelease.text}`);
    const releasedNode = summarizeConversationNode(afterRelease.json, options.project, diagnostics.actualRef);
    assert(releasedNode, `Adopted conversation ${diagnostics.actualRef} missing from tree after release.`);
    assert(releasedNode.isBound !== true, `Conversation ${diagnostics.actualRef} still shows as bound after release.`);

    console.log(JSON.stringify({
      ok: true,
      hiddenTmuxSession: diagnostics.tmuxSessionName,
      pendingRef: diagnostics.pendingRef,
      adoptedRef: diagnostics.actualRef,
      transcriptPath: diagnostics.transcriptPath,
      sessionsRoot,
    }, null, 2));
  } catch (error) {
    if (sessionId && !options.keepSession) {
      try {
        await api(options.baseUrl, cookie, csrfToken, `/api/sessions/${encodeURIComponent(sessionId)}/release`, { method: 'POST' });
        diagnostics.released = true;
      } catch {
        // Best effort cleanup.
      }
    }
    if (sessionId) {
      try {
        const rawOutput = await api(options.baseUrl, cookie, csrfToken, `/api/sessions/${encodeURIComponent(sessionId)}/raw-output`);
        diagnostics.rawOutputPreview = rawOutput.json?.text?.slice(-4000);
      } catch {
        // Ignore diagnostics failure.
      }
    }
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      diagnostics,
    }, null, 2));
    process.exit(1);
  }
}

await main();
