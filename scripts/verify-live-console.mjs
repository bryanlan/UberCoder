#!/usr/bin/env node

import process from 'node:process';
import { chromium } from '@playwright/test';

const DEFAULT_PROJECT = 'UberCoder--agent-console-mvp--agent-console';
const DEFAULT_CLAUDE_REF = 'pending:dcfd00af-433b-4a37-ab59-eb7ec7d2ac8f';
const DEFAULT_CODEX_REF = 'pending:41ef7ea9-013b-4afd-8d30-af56039d3791';

const DEFAULT_LEAK_TERMS = [
  'Live session did not accept',
  'draft was not submitted',
  'Starting MCP servers',
  'Write tests for @filename',
  'Select model',
  'Switch between Claude models',
  'Effort not supported',
  'Ran 1 shell command',
  'WWoorr',
  'Sttarr',
  'TinTk',
  'Mosyin',
];

function parseArgs(argv) {
  const baseUrl = process.env.AGENT_CONSOLE_BASE_URL ?? 'http://127.0.0.1:4317';
  const defaults = {
    baseUrl,
    cdpUrl: process.env.AGENT_CONSOLE_CDP_URL ?? 'http://127.0.0.1:9222',
    password: process.env.AGENT_CONSOLE_PASSWORD,
    claudeUrl: process.env.AGENT_CONSOLE_VERIFY_CLAUDE_URL
      ?? `/projects/${DEFAULT_PROJECT}/claude/${encodeURIComponent(DEFAULT_CLAUDE_REF)}`,
    codexUrl: process.env.AGENT_CONSOLE_VERIFY_CODEX_URL
      ?? `/projects/${DEFAULT_PROJECT}/codex/${encodeURIComponent(DEFAULT_CODEX_REF)}`,
    switchUrls: process.env.AGENT_CONSOLE_VERIFY_SWITCH_URLS,
    timeoutMs: Number(process.env.AGENT_CONSOLE_VERIFY_TIMEOUT_MS ?? 60_000),
    maxTypePreviewMs: Number(process.env.AGENT_CONSOLE_VERIFY_MAX_TYPE_PREVIEW_MS ?? 750),
    maxClearMs: Number(process.env.AGENT_CONSOLE_VERIFY_MAX_CLEAR_MS ?? 1_000),
    maxUserVisibleMs: Number(process.env.AGENT_CONSOLE_VERIFY_MAX_USER_VISIBLE_MS ?? 1_500),
    maxSwitchMs: Number(process.env.AGENT_CONSOLE_VERIFY_MAX_SWITCH_MS ?? 5_000),
    settleMs: Number(process.env.AGENT_CONSOLE_VERIFY_SETTLE_MS ?? 5_000),
  };

  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--base-url':
        options.baseUrl = requireValue(arg, next);
        index += 1;
        break;
      case '--cdp-url':
        options.cdpUrl = requireValue(arg, next);
        index += 1;
        break;
      case '--password':
        options.password = requireValue(arg, next);
        index += 1;
        break;
      case '--claude-url':
        options.claudeUrl = requireValue(arg, next);
        index += 1;
        break;
      case '--codex-url':
        options.codexUrl = requireValue(arg, next);
        index += 1;
        break;
      case '--switch-urls':
        options.switchUrls = requireValue(arg, next);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(requireValue(arg, next));
        index += 1;
        break;
      case '--max-switch-ms':
        options.maxSwitchMs = Number(requireValue(arg, next));
        index += 1;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith('max') || key.endsWith('Ms')) {
      assert(Number.isFinite(value) && value > 0, `Invalid numeric option ${key}: ${value}`);
    }
  }

  return options;
}

function requireValue(arg, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-live-console.mjs [options]

Attaches to a visible Chrome instance through CDP and verifies real Agent Console live UX.

Options:
  --base-url <url>       Agent Console URL. Default: http://127.0.0.1:4317
  --cdp-url <url>        Chrome CDP URL. Default: http://127.0.0.1:9222
  --password <password>  Optional login password if the browser is not already authenticated
  --claude-url <url>     Claude conversation route to test
  --codex-url <url>      Codex conversation route to test
  --switch-urls <csv>    Routes/URLs to navigate for switch latency checks
  --timeout-ms <ms>      Submit timeout. Default: 60000
  --max-switch-ms <ms>   Maximum allowed route switch latency. Default: 5000
`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(baseUrl, input) {
  return new URL(input, baseUrl).toString();
}

function routePartsFromPath(pathname) {
  const match = pathname.match(/^\/projects\/([^/]+)\/(claude|codex)\/(.+)$/);
  assert(match, `Unexpected conversation route: ${pathname}`);
  return {
    projectSlug: decodeURIComponent(match[1]),
    provider: match[2],
    conversationRef: decodeURIComponent(match[3]),
  };
}

function marker(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

async function waitForMainContent(page, timeoutMs) {
  await page.locator('main').waitFor({ timeout: timeoutMs });
  await page.waitForFunction(() => {
    const main = document.querySelector('main');
    return Boolean(main && (main.textContent ?? '').trim().length > 0);
  }, null, { timeout: timeoutMs });
}

async function navigateToConsole(page, options, url) {
  const targetUrl = absoluteUrl(options.baseUrl, url);
  const startedAt = Date.now();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 500 }).catch(() => undefined);

  const passwordInput = page.getByLabel('Password');
  const loginFormVisible = await passwordInput.isVisible({ timeout: 500 }).catch(() => false);
  if (new URL(page.url()).pathname === '/login' || loginFormVisible) {
    assert(options.password, 'Browser is not authenticated. Pass --password or set AGENT_CONSOLE_PASSWORD.');
    await passwordInput.fill(options.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await passwordInput.waitFor({ state: 'detached', timeout: options.timeoutMs }).catch(() => undefined);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  }

  await waitForMainContent(page, options.timeoutMs);
  return Date.now() - startedAt;
}

async function waitForLiveBridge(page, timeoutMs) {
  await page.getByText('Live input bridge', { exact: false }).waitFor({ timeout: timeoutMs });
  const textarea = page.locator('main textarea').last();
  await textarea.waitFor({ timeout: timeoutMs });
  await page.getByRole('button', { name: 'Text Bypass' }).waitFor({ timeout: timeoutMs });
  return textarea;
}

async function ensureTextBypass(page, textarea) {
  const button = page.getByRole('button', { name: 'Text Bypass' });
  const pressed = await button.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    await button.click();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => (candidate.textContent ?? '').trim() === 'Text Bypass');
      return button?.getAttribute('aria-pressed') === 'true';
    }, null, { timeout: 5_000 });
  }
  await textarea.click();
}

async function fetchCurrentTimeline(page) {
  return await page.evaluate(async () => {
    const match = location.pathname.match(/^\/projects\/([^/]+)\/(claude|codex)\/(.+)$/);
    if (!match) {
      throw new Error(`Unexpected conversation route: ${location.pathname}`);
    }
    const [, projectSlug, provider, conversationRef] = match;
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(decodeURIComponent(projectSlug))}/${provider}/${encodeURIComponent(decodeURIComponent(conversationRef))}/messages`,
      { credentials: 'include' },
    );
    if (!response.ok) {
      throw new Error(`Timeline request failed with ${response.status}`);
    }
    return await response.json();
  });
}

async function fetchCurrentScreen(page) {
  const timeline = await fetchCurrentTimeline(page);
  const sessionId = timeline.boundSession?.id;
  assert(sessionId, 'Current conversation is not bound to a live session.');
  const screenResponse = await page.evaluate(async (boundSessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(boundSessionId)}/screen`, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Screen request failed with ${response.status}`);
    }
    return await response.json();
  }, sessionId);
  return {
    sessionId,
    screen: screenResponse.screen,
  };
}

async function waitForCurrentScreen(page, timeoutMs, predicate, description) {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await fetchCurrentScreen(page);
    const searchableText = [
      latest.screen.model ?? '',
      latest.screen.status ?? '',
      latest.screen.inputText ?? '',
      latest.screen.content ?? '',
    ].join('\n');
    if (predicate(latest.screen, searchableText)) {
      return latest;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest?.screen ?? null, null, 2)}`);
}

async function submitThroughTextBypass(page, options, text) {
  const textarea = await waitForLiveBridge(page, options.timeoutMs);
  await ensureTextBypass(page, textarea);
  const currentDraft = await textarea.inputValue();
  assert(currentDraft === '', `Live bridge was not empty before submitting ${JSON.stringify(text)}: ${JSON.stringify(currentDraft)}`);

  const typeStartedAt = Date.now();
  await page.keyboard.type(text, { delay: 0 });
  await page.waitForFunction((expected) => {
    return document.querySelector('main textarea')?.value === expected;
  }, text, { timeout: options.timeoutMs });
  const typePreviewMs = Date.now() - typeStartedAt;
  assert(typePreviewMs <= options.maxTypePreviewMs, `Text bypass typing was slow for ${JSON.stringify(text)}: ${typePreviewMs}ms`);

  const clearStartedAt = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    return document.querySelector('main textarea')?.value === '';
  }, null, { timeout: options.timeoutMs });
  const clearMs = Date.now() - clearStartedAt;
  assert(clearMs <= options.maxClearMs, `Send box cleared slowly for ${JSON.stringify(text)}: ${clearMs}ms`);

  return {
    text,
    typePreviewMs,
    clearMs,
  };
}

async function waitForMarkerState(page, markerText, leakTerms, settleMs) {
  await sleep(settleMs);
  return await page.evaluate(({ markerText: markerArg, leakTerms: leakArgs }) => {
    const articles = [...document.querySelectorAll('main article')].map((article) => article.textContent ?? '');
    const markerArticles = articles.filter((text) => text.includes(markerArg));
    const latestRegion = articles.slice(-6).join('\n');
    return {
      markerArticleCount: markerArticles.length,
      markerArticles,
      latestTexts: articles.slice(-6),
      leaks: leakArgs.filter((term) => latestRegion.includes(term)),
      textareaValue: document.querySelector('main textarea')?.value ?? null,
    };
  }, { markerText, leakTerms });
}

async function pollSubmitState(page, markerText, leakTerms, timeoutMs) {
  const startedAt = Date.now();
  const prompt = `Reply exactly ${markerText}`;
  let firstClearMs;
  let firstUserMs;
  let firstAssistantMs;
  let lastState;

  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate(({ markerText: markerArg, prompt: promptArg, leakTerms: leakArgs }) => {
      const textarea = document.querySelector('main textarea');
      const articles = [...document.querySelectorAll('main article')].map((article) => article.textContent ?? '');
      const markerArticles = articles.filter((text) => text.includes(markerArg));
      const userVisible = articles.some((text) => text.includes(promptArg));
      const assistantVisible = articles.some((text) => text.includes(markerArg) && !text.includes(promptArg));
      const latestRegion = articles.slice(-6).join('\n');
      return {
        textareaValue: textarea?.value ?? null,
        markerArticleCount: markerArticles.length,
        markerArticles,
        userVisible,
        assistantVisible,
        leaks: leakArgs.filter((term) => latestRegion.includes(term)),
        latestTexts: articles.slice(-6),
      };
    }, { markerText, prompt, leakTerms });

    const elapsedMs = Date.now() - startedAt;
    if (firstClearMs === undefined && state.textareaValue === '') firstClearMs = elapsedMs;
    if (firstUserMs === undefined && state.userVisible) firstUserMs = elapsedMs;
    if (firstAssistantMs === undefined && state.assistantVisible) firstAssistantMs = elapsedMs;
    lastState = state;

    if (
      firstClearMs !== undefined
      && firstUserMs !== undefined
      && firstAssistantMs !== undefined
      && state.markerArticleCount === 2
      && state.leaks.length === 0
    ) {
      return {
        firstClearMs,
        firstUserMs,
        firstAssistantMs,
        state,
      };
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for clean marker ${markerText}: ${JSON.stringify({
    firstClearMs,
    firstUserMs,
    firstAssistantMs,
    lastState,
  }, null, 2)}`);
}

async function verifyModelPicker(page, options, input) {
  const loadMs = await navigateToConsole(page, options, input.url);
  routePartsFromPath(new URL(page.url()).pathname);

  const openCommand = await submitThroughTextBypass(page, options, '/model');
  const openScreen = await waitForCurrentScreen(
    page,
    options.timeoutMs,
    (_screen, text) => input.menuPattern.test(text),
    `${input.label} model picker menu`,
  );

  const selection = await submitThroughTextBypass(page, options, input.selection);
  const selectedScreen = await waitForCurrentScreen(
    page,
    options.timeoutMs,
    (_screen, text) => input.modelPattern.test(text) && input.confirmationPattern.test(text),
    `${input.label} selected model ${input.expectedModel}`,
  );

  const timeline = await fetchCurrentTimeline(page);
  const latestTexts = (timeline.messages ?? []).slice(-8).map((message) => message.text ?? '');
  assert(
    !latestTexts.includes('/model') && !latestTexts.includes(input.selection),
    `${input.label} model picker command leaked into conversation messages.`,
  );

  return {
    label: input.label,
    loadMs,
    sessionId: selectedScreen.sessionId,
    expectedModel: input.expectedModel,
    openedModelText: openScreen.screen.model ?? openScreen.screen.status,
    selectedModelText: selectedScreen.screen.model ?? selectedScreen.screen.status,
    commands: [openCommand, selection],
  };
}

async function verifyTextBypassSubmit(page, options, input) {
  const loadMs = await navigateToConsole(page, options, input.url);
  const textarea = await waitForLiveBridge(page, options.timeoutMs);
  await ensureTextBypass(page, textarea);

  const bodyText = await page.locator('body').textContent();
  assert(input.modelPattern.test(bodyText ?? ''), `${input.label} model/status text missing or unreadable.`);

  const currentDraft = await textarea.inputValue();
  assert(currentDraft === '', `${input.label} live bridge was not empty before submit: ${JSON.stringify(currentDraft)}`);

  const markerText = marker(input.markerPrefix);
  const prompt = `Reply exactly ${markerText}`;
  const typeStartedAt = Date.now();
  await page.keyboard.type(prompt, { delay: 0 });
  await page.waitForFunction((expected) => {
    return document.querySelector('main textarea')?.value === expected;
  }, prompt, { timeout: options.timeoutMs });
  const typePreviewMs = Date.now() - typeStartedAt;
  assert(typePreviewMs <= options.maxTypePreviewMs, `${input.label} text bypass typing was slow: ${typePreviewMs}ms`);

  await page.keyboard.press('Enter');
  const submit = await pollSubmitState(page, markerText, input.leakTerms, options.timeoutMs);
  assert(submit.firstClearMs <= options.maxClearMs, `${input.label} send box cleared slowly: ${submit.firstClearMs}ms`);
  assert(submit.firstUserMs <= options.maxUserVisibleMs, `${input.label} user transcript row was slow: ${submit.firstUserMs}ms`);

  const settled = await waitForMarkerState(page, markerText, input.leakTerms, options.settleMs);
  assert(settled.textareaValue === '', `${input.label} send box refilled after submit: ${JSON.stringify(settled.textareaValue)}`);
  assert(settled.markerArticleCount === 2, `${input.label} expected exactly two marker rows after settle, got ${settled.markerArticleCount}`);
  assert(settled.leaks.length === 0, `${input.label} transcript leaked terminal/status text: ${settled.leaks.join(', ')}`);

  return {
    label: input.label,
    loadMs,
    marker: markerText,
    typePreviewMs,
    firstClearMs: submit.firstClearMs,
    firstUserMs: submit.firstUserMs,
    firstAssistantMs: submit.firstAssistantMs,
    markerArticleCount: settled.markerArticleCount,
  };
}

async function measureSwitches(page, options) {
  const configured = options.switchUrls
    ? options.switchUrls.split(',').map((value) => value.trim()).filter(Boolean)
    : [options.claudeUrl, options.codexUrl, options.claudeUrl];

  const results = [];
  for (const [index, url] of configured.entries()) {
    const elapsedMs = await navigateToConsole(page, options, url);
    const warmup = index === 0;
    if (!warmup) {
      assert(elapsedMs <= options.maxSwitchMs, `Route switch to ${url} took ${elapsedMs}ms, above ${options.maxSwitchMs}ms`);
    }
    results.push({ url, elapsedMs, warmup });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.connectOverCDP(options.cdpUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) ?? await context.newPage();
  await page.bringToFront();

  const switchResults = await measureSwitches(page, options);
  const claudeModelPicker = await verifyModelPicker(page, options, {
    label: 'Claude',
    url: options.claudeUrl,
    selection: '5',
    expectedModel: 'Haiku 4.5',
    menuPattern: /Select model[\s\S]*Haiku/i,
    modelPattern: /Haiku\s+4\.5/,
    confirmationPattern: /Set model to Haiku\s+4\.5|Haiku\s+4\.5/i,
  });
  const codexModelPicker = await verifyModelPicker(page, options, {
    label: 'Codex',
    url: options.codexUrl,
    selection: '3',
    expectedModel: 'gpt-5.4-mini medium',
    menuPattern: /Select Model and Effort[\s\S]*gpt-5\.4-mini/i,
    modelPattern: /gpt-5\.4-mini\s+medium/,
    confirmationPattern: /Model changed to gpt-5\.4-mini medium|gpt-5\.4-mini\s+medium/i,
  });
  const claude = await verifyTextBypassSubmit(page, options, {
    label: 'Claude',
    url: options.claudeUrl,
    markerPrefix: 'CLAUDE_PLAYWRIGHT_TEXT_BYPASS',
    modelPattern: /Haiku\s+4\.5/,
    leakTerms: DEFAULT_LEAK_TERMS,
  });
  const codex = await verifyTextBypassSubmit(page, options, {
    label: 'Codex',
    url: options.codexUrl,
    markerPrefix: 'CODEX_PLAYWRIGHT_TEXT_BYPASS',
    modelPattern: /gpt-5\.4-mini\s+medium/,
    leakTerms: DEFAULT_LEAK_TERMS,
  });

  console.log(JSON.stringify({
    ok: true,
    baseUrl: options.baseUrl,
    cdpUrl: options.cdpUrl,
    switchResults,
    modelPickers: [claudeModelPicker, codexModelPicker],
    submissions: [claude, codex],
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
