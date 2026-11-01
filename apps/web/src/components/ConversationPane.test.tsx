import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoundSession, ModelProfileKey, ConversationTimeline, NormalizedMessage, PendingRequestSummary, ProjectSummary, SessionInputResponse, SessionKeystrokeRequest } from '@agent-console/shared';
import { ConversationPane, type MobileInputPanel } from './ConversationPane';
import type { ModelProfilesState } from '../lib/model-profiles';
import { api, ApiError } from '../lib/api';
import { CONVERSATION_DRAG_TYPE } from '../features/conversation/agent-reference';

const baseTime = '2026-07-02T12:00:00.000Z';

// What the server's model list returns in these tests (the web app has no list of its own).
const level = (model: string, label: string, effort: string) => ({ model, label, effort, launchName: model });
const readyProfiles: ModelProfilesState = {
  status: 'ready',
  profiles: {
    loadedAt: baseTime,
    providers: {
      codex: { routerProvider: 'openai', levels: {
        high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'),
        medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'),
        low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
      } },
      claude: { routerProvider: 'anthropic', levels: {
        high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'),
        medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'),
        low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
      } },
      grok: { routerProvider: 'xai', levels: {
        high: level('grok-build-high', 'Grok Build High', 'high'),
        medium: level('grok-build-medium', 'Grok Build Medium', 'medium'),
        low: level('grok-build-low', 'Grok Build Low', 'low'),
      } },
    },
  },
};

const pastedImage = {
  id: '48f85f7c-5448-4d96-94b4-177a2f8e300e', mediaType: 'image/png' as const,
  name: 'Pasted image.png', width: 32, height: 24, sizeBytes: 123,
};

function pasteImage(textbox: HTMLElement) {
  const file = new File(['image fixture'], 'clipboard.png', { type: 'image/png' });
  fireEvent.paste(textbox, { clipboardData: { files: [file], getData: () => '' } });
  return file;
}

beforeAll(() => {
  Element.prototype.scrollTo ??= vi.fn();
});

describe('clipboard images', () => {
  for (const provider of ['codex', 'claude'] as const) {
    for (const bypass of [false, true]) {
      it(`${provider} ${bypass ? 'bypass' : 'draft'} image-only submissions retain images on rejection and clear them on success`, async () => {
        const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
        const send = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ session: boundSession() });
        try {
          renderPane({ sessionOverrides: { provider }, onSendKeystrokes: send });
          const textbox = screen.getByRole('textbox');
          if (bypass) {
            fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
            await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));
          }
          const file = pasteImage(textbox);
          await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
          expect(upload).toHaveBeenCalledWith('session-1', file, undefined);
          expect(send).not.toHaveBeenCalled();
          fireEvent.keyDown(textbox, { key: 'Enter' });
          await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
          expect(send).toHaveBeenLastCalledWith('session-1', { keys: ['Enter'], imageIds: [pastedImage.id] });
          await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
          expect(screen.getByAltText('Pasted image.png')).toBeVisible();
          fireEvent.keyDown(textbox, { key: 'Enter' });
          await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          await waitFor(() => expect(screen.queryByAltText('Pasted image.png')).not.toBeInTheDocument());
        } finally { upload.mockRestore(); }
      });
    }
  }

  it('blocks submission while uploading, supports retry and keeps captions on rejected sends', async () => {
    const pending = deferred<typeof pastedImage>();
    const upload = vi.spyOn(api, 'uploadImage').mockImplementationOnce(() => pending.promise).mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValue(undefined);
    try {
      renderPane({ onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: 'Please inspect this screenshot' } });
      pasteImage(textbox);
      expect(screen.getByText('Uploading image…')).toBeVisible();
      fireEvent.keyDown(textbox, { key: 'Enter' });
      await waitFor(() => expect(textbox).toHaveValue('Please inspect this screenshot'));
      expect(send).not.toHaveBeenCalled();
      pending.resolve(pastedImage);
      await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
      fireEvent.keyDown(textbox, { key: 'Enter' });
      await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', {
        text: 'Please inspect this screenshot', submittedText: 'Please inspect this screenshot', keys: ['Enter'], imageIds: [pastedImage.id],
      }));
      await waitFor(() => expect(textbox).toHaveValue('Please inspect this screenshot'));
      fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }));
      expect(screen.queryByAltText('Pasted image.png')).not.toBeInTheDocument();
      // Clear the text draft so subsequent tests start with an empty composer.
      fireEvent.change(textbox, { target: { value: '' } });
    } finally { upload.mockRestore(); }
  });

  it('offers upload retry and retains attachments across conversation remounts', async () => {
    const upload = vi.spyOn(api, 'uploadImage').mockRejectedValueOnce(new Error('Upload unavailable')).mockResolvedValue(pastedImage);
    try {
      const first = renderPane();
      pasteImage(screen.getByRole('textbox'));
      await waitFor(() => expect(screen.getByText('Upload unavailable')).toBeVisible());
      first.unmount();
      renderPane();
      expect(screen.getByText('Upload unavailable')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
      await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }));
    } finally { upload.mockRestore(); }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function project(): ProjectSummary {
  return {
    slug: 'demo',
    directoryName: 'demo',
    displayName: 'Demo',
    path: '/tmp/demo',
    tags: [],
    allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: [] },
      claude: { id: 'claude', label: 'Claude', conversations: [] },
      grok: { id: 'grok', label: 'Grok', conversations: [] },
    },
  };
}

function boundSession(overrides: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-1',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'conversation-1',
    tmuxSessionName: 'ac-codex-demo',
    transport: 'tmux',
    status: 'bound',
    shouldRestore: true,
    title: 'Demo conversation',
    startedAt: baseTime,
    updatedAt: baseTime,
    ...overrides,
  };
}

function timeline(input: {
  inputText?: string;
  inputActive?: boolean;
  messages?: NormalizedMessage[];
  screenContent?: string;
  screenContentAnsi?: string;
  screenStatus?: string;
  screenStatusAnsi?: string;
  screenModel?: string;
  sessionOverrides?: Partial<BoundSession>;
} = {}): ConversationTimeline {
  const session = boundSession(input.sessionOverrides);
  return {
    conversation: {
      ref: 'conversation-1',
      kind: 'history',
      projectSlug: 'demo',
      provider: session.provider,
      title: 'Demo conversation',
      updatedAt: baseTime,
      isBound: true,
      boundSessionId: session.id,
      degraded: false,
    },
    messages: input.messages ?? [],
    boundSession: session,
    liveScreen: {
      content: input.screenContent ?? '',
      contentAnsi: input.screenContentAnsi,
      inputText: input.inputText ?? '',
      inputActive: input.inputActive ?? true,
      status: input.screenStatus ?? 'Session active',
      statusAnsi: input.screenStatusAnsi,
      capturedAt: baseTime,
      model: input.screenModel,
    },
    messagePage: { hasOlder: false, total: 0 },
  };
}

function renderPane(input: {
  mobileInputPanel?: MobileInputPanel;
  onCloseMobileInput?: () => void;
  inputText?: string;
  inputActive?: boolean;
  messages?: NormalizedMessage[];
  screenContent?: string;
  screenContentAnsi?: string;
  screenStatus?: string;
  screenStatusAnsi?: string;
  screenModel?: string;
  onSendKeystrokes?: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<SessionInputResponse | undefined>;
  modelProfiles?: ModelProfilesState;
  onSetModelProfile?: (sessionId: string, profile: ModelProfileKey) => Promise<boolean>;
  onCancelModelProfileRequest?: (sessionId: string, requestId: string) => Promise<boolean>;
  onSuspend?: (sessionId: string) => Promise<void>;
  onLocalSubmittedText?: (sessionId: string, text: string) => { id: string } | undefined;
  sessionOverrides?: Partial<BoundSession>;
} = {}) {
  const onSendKeystrokes = input.onSendKeystrokes ?? vi.fn().mockResolvedValue({ session: boundSession() });
  const onSetModelProfile = input.onSetModelProfile ?? vi.fn().mockResolvedValue(true);
  const onCancelModelProfileRequest = input.onCancelModelProfileRequest ?? vi.fn().mockResolvedValue(true);
  const onLocalSubmittedText = input.onLocalSubmittedText ?? vi.fn(() => ({ id: 'optimistic-1' }));
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider={input.sessionOverrides?.provider ?? 'codex'}
        timeline={timeline({
          inputText: input.inputText,
          inputActive: input.inputActive,
          messages: input.messages,
          screenContent: input.screenContent,
          screenContentAnsi: input.screenContentAnsi,
          screenStatus: input.screenStatus,
          screenStatusAnsi: input.screenStatusAnsi,
          screenModel: input.screenModel,
          sessionOverrides: input.sessionOverrides,
        })}
        liveMode
        onRetryResume={vi.fn()}
        loading={false}
        workMode={false}
        mobileInputPanel={input.mobileInputPanel}
        onCloseMobileInput={input.onCloseMobileInput}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={input.onSuspend ?? vi.fn()}
        onSendKeystrokes={onSendKeystrokes}
        modelProfiles={input.modelProfiles ?? readyProfiles}
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={onCancelModelProfileRequest}
        onLocalSubmittedText={onLocalSubmittedText}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
        suspending={false}
        debugOpen={false}
        onToggleDebug={vi.fn()}
        rawLoading={false}
        hasOlderMessages={false}
        loadingOlderMessages={false}
        onLoadOlderMessages={vi.fn()}
        conversationKey={`demo:${input.sessionOverrides?.provider ?? 'codex'}:conversation-1`}
        historyPrependVersion={0}
      />
    </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onSendKeystrokes, onSetModelProfile, onCancelModelProfileRequest, onLocalSubmittedText };
}

it('Alt H selects the high Codex profile without changing the draft', async () => {
  const onSetModelProfile = vi.fn().mockResolvedValue(true);
  renderPane({ onSetModelProfile });
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'keep this draft' } });

  fireEvent.keyDown(textbox, { key: 'h', altKey: true });

  await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(textbox).toHaveValue('keep this draft');
});

it('offers Claude H/M/L models and selects high without changing the draft', async () => {
  const onSetModelProfile = vi.fn().mockResolvedValue(true);
  renderPane({ onSetModelProfile, sessionOverrides: { provider: 'claude', claudeProfile: 'medium' } });
  expect(screen.getByRole('button', { name: 'Use high Claude profile' })).toHaveAttribute('title', expect.stringContaining('claude-fable-5-1 / xhigh'));
  expect(screen.getByRole('button', { name: 'Use medium Claude profile' })).toHaveAttribute('title', expect.stringContaining('claude-opus-5-5 / xhigh'));
  expect(screen.getByRole('button', { name: 'Use low Claude profile' })).toHaveAttribute('title', expect.stringContaining('claude-sonnet-5-5 / high'));
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'keep this Claude draft' } });
  fireEvent.keyDown(textbox, { key: 'h', altKey: true });
  await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(textbox).toHaveValue('keep this Claude draft');
});

it('offers Grok A/H/M/L on a structured Grok session, reads grokProfile and selects with Alt H', async () => {
  const onSetModelProfile = vi.fn().mockResolvedValue(true);
  renderPane({
    onSetModelProfile,
    sessionOverrides: { provider: 'grok', transport: 'structured', tmuxSessionName: 'acs-session-1', grokProfile: 'medium' },
    screenModel: 'grok-build-medium medium',
  });
  const group = screen.getByLabelText('Grok model profile');
  expect(Array.from(group.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['A', 'H', 'M', 'L']);
  expect(screen.getByRole('button', { name: 'Use high Grok profile' })).toHaveAttribute('title', expect.stringContaining('grok-build-high / high'));
  expect(screen.getByRole('button', { name: 'Use medium Grok profile' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Use low Grok profile' })).toHaveAttribute('aria-pressed', 'false');
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'keep this Grok draft' } });
  fireEvent.keyDown(textbox, { key: 'h', altKey: true });
  await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(textbox).toHaveValue('keep this Grok draft');
});

describe('Auto model profile (A)', () => {
  const structuredCodex = { transport: 'structured' as const, tmuxSessionName: 'acs-session-1' };
  const decision = {
    source: 'router' as const, decidedAt: baseTime, model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'low',
    launchName: 'claude-sonnet-5-5', role: 'implementer', rolePercent: 91, difficulty: 'lighter', classifierStatus: 'ok',
    quotaState: 'on_pace', reason: 'Best implementer fit is Claude Sonnet 5.5 at low effort; it is on pace for its weekly quota.',
  };

  it('offers A to the left of H, M and L on a structured session and Alt A selects it', async () => {
    const onSetModelProfile = vi.fn().mockResolvedValue(true);
    renderPane({ onSetModelProfile, sessionOverrides: { ...structuredCodex, codexProfile: 'medium' } });
    const group = screen.getByLabelText('Codex model profile');
    expect(Array.from(group.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['A', 'H', 'M', 'L']);
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'keep this draft' } });
    fireEvent.keyDown(textbox, { key: 'a', altKey: true });
    await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'auto'));
    expect(textbox).toHaveValue('keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Use auto Codex profile' }));
    await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledTimes(2));
  });

  it('does not offer A, nor react to Alt A, on a terminal-backed session', () => {
    const onSetModelProfile = vi.fn().mockResolvedValue(true);
    renderPane({ onSetModelProfile, sessionOverrides: { codexProfile: 'medium' } });
    expect(screen.queryByRole('button', { name: 'Use auto Codex profile' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a', altKey: true });
    expect(onSetModelProfile).not.toHaveBeenCalled();
  });

  it('shows the compact route line from typed fields and the router reason on hover', () => {
    renderPane({
      sessionOverrides: { ...structuredCodex, provider: 'claude', claudeProfile: 'auto', autoRoute: { routePending: false, decision } },
      screenModel: 'claude-sonnet-5-5 low',
    });
    const line = screen.getByTestId('auto-route-line');
    expect(line).toHaveTextContent('A → Sonnet 5.5·low · implementer 91% · lighter · Claude on pace');
    expect(line).toHaveAttribute('title', decision.reason);
    expect(screen.getByRole('button', { name: 'Use auto Claude profile' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks a provisional choice, says the role is unclear, and drops the re-route hint', () => {
    renderPane({
      sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: true, routedPrompts: 1, previousPrompt: 'hm', decision: {
        source: 'router', decidedAt: baseTime, model: 'gpt-6-luna', label: 'GPT-6 Luna', effort: 'low', launchName: 'gpt-6-luna',
        role: 'implementer', rolePercent: 41, difficulty: 'lighter', classifierStatus: 'cannot_tell', provisional: true,
      } } },
    });
    const line = screen.getByTestId('auto-route-line');
    expect(line).toHaveTextContent('A (provisional) → GPT-6 Luna·low · role unclear · lighter');
    expect(line).not.toHaveTextContent('41%');
    expect(line).not.toHaveTextContent('re-routes with your next message');
  });

  it('says a clear first choice is checked again at the next prompt, and that A pressed again re-routes', () => {
    const decision = { source: 'router' as const, decidedAt: baseTime, model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'low', launchName: 'gpt-6.1-terra', role: 'implementer', rolePercent: 91 };
    const first = renderPane({ sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: true, routedPrompts: 1, previousPrompt: 'hi', decision } } });
    expect(screen.getByTestId('auto-route-line')).toHaveTextContent('A → GPT-6.1 Terra·low · implementer 91% · re-checks at your next prompt');
    first.unmount();
    const pressed = renderPane({ sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: true, decision } } });
    expect(screen.getByTestId('auto-route-line')).toHaveTextContent('implementer 91% · re-routes with your next message');
    pressed.unmount();
    renderPane({ sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: false, decision } } });
    expect(screen.getByTestId('auto-route-line')).not.toHaveTextContent('re-');
  });

  it('shows a Grok session\'s Auto choice with its own name and quota state', () => {
    renderPane({
      sessionOverrides: { ...structuredCodex, provider: 'grok', grokProfile: 'auto', autoRoute: { routePending: false, decision: {
        source: 'router', decidedAt: baseTime, model: 'grok-4.7', label: 'Grok 4.7', effort: 'high', launchName: 'grok-4.7',
        role: 'implementer', rolePercent: 72, difficulty: 'lighter', quotaState: 'unknown',
      } } },
      screenModel: 'grok-4.7 high',
    });
    expect(screen.getByTestId('auto-route-line')).toHaveTextContent('A → Grok 4.7·high · implementer 72% · lighter · Grok quota unknown');
    expect(screen.getByRole('button', { name: 'Use auto Grok profile' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says the next message will be routed while A is pending, and shows a fallback warning', () => {
    const pending = renderPane({ sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: true } } });
    expect(screen.getByTestId('auto-route-line')).toHaveTextContent('A → routes with your next message');
    pending.unmount();
    renderPane({
      sessionOverrides: { ...structuredCodex, codexProfile: 'auto', autoRoute: { routePending: false, decision: {
        source: 'fallback', decidedAt: baseTime, model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: 'xhigh', launchName: 'gpt-6.1-sol',
        warning: 'Auto unavailable: timed out after 8 s. Using Medium.',
      } } },
    });
    expect(screen.getByTestId('auto-route-warning')).toHaveTextContent('Auto unavailable: timed out after 8 s. Using Medium.');
    expect(screen.getByTestId('auto-route-line')).toHaveTextContent('A → GPT-6.1 Sol·xhigh');
  });
});

describe('model profile list from the server', () => {
  it('shows a clear error and disables every profile button when the list cannot be loaded', () => {
    renderPane({
      modelProfiles: { status: 'error', message: 'Model profiles unavailable: wo was not found at /x/wo' },
      sessionOverrides: { transport: 'structured', tmuxSessionName: 'acs-session-1', codexProfile: 'medium' },
    });
    expect(screen.getByTestId('model-profiles-error')).toHaveTextContent('Model profiles unavailable: wo was not found at /x/wo');
    for (const name of ['auto', 'high', 'medium', 'low']) {
      expect(screen.getByRole('button', { name: `Use ${name} Codex profile` })).toBeDisabled();
    }
  });

  it('does not act on Alt H while the list is missing', () => {
    const onSetModelProfile = vi.fn().mockResolvedValue(true);
    renderPane({ onSetModelProfile, modelProfiles: { status: 'loading' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'h', altKey: true });
    expect(onSetModelProfile).not.toHaveBeenCalled();
    expect(screen.getByText('Loading model profiles…')).toBeInTheDocument();
  });
});

it('does not present a saved profile as current when the live model is older', () => {
  renderPane({ sessionOverrides: { codexProfile: 'medium' }, screenModel: 'gpt-5.6-sol xhigh' });
  expect(screen.getByText('Running: gpt-5.6-sol xhigh · select H, M, or L')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use medium Codex profile' })).toHaveAttribute('aria-pressed', 'false');
});

it('submits a busy-session profile immediately and does not carry its server queue to another conversation', async () => {
  const onSetModelProfile = vi.fn().mockResolvedValue(true);
  const view = renderPane({
    onSetModelProfile,
    sessionOverrides: {
      id: 'session-1',
      isWorking: true,
      modelProfileRequest: { requestId: 'request-1', profile: 'high', requestedAt: baseTime, state: 'queued', deferredReason: 'turn_running' },
    },
  });

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'h', altKey: true });
  await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(screen.getByText(/High queued/)).toBeInTheDocument();

  view.rerender(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({ sessionOverrides: { id: 'session-2', isWorking: false } })}
        liveMode
        onRetryResume={vi.fn()}
        loading={false}
        workMode={false}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
        modelProfiles={readyProfiles}
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
        onLocalSubmittedText={vi.fn(() => ({ id: 'optimistic-2' }))}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
        suspending={false}
        debugOpen={false}
        onToggleDebug={vi.fn()}
        rawLoading={false}
        hasOlderMessages={false}
        loadingOlderMessages={false}
        onLoadOlderMessages={vi.fn()}
        conversationKey="demo:codex:conversation-2"
        historyPrependVersion={0}
      />
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.queryByText(/High queued/)).not.toBeInTheDocument());
  expect(onSetModelProfile).toHaveBeenCalledTimes(1);
});

it('does not use browser idleness to apply a server-owned queued profile', async () => {
  const onSetModelProfile = vi.fn().mockResolvedValue(true);
  const view = renderPane({
    onSetModelProfile,
    sessionOverrides: {
      id: 'session-1',
      isWorking: true,
      modelProfileRequest: { requestId: 'request-1', profile: 'high', requestedAt: baseTime, state: 'queued', deferredReason: 'turn_running' },
    },
  });

  expect(screen.getByText(/High queued/)).toBeInTheDocument();

  view.rerender(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({ sessionOverrides: {
          id: 'session-1',
          isWorking: false,
          modelProfileRequest: { requestId: 'request-1', profile: 'high', requestedAt: baseTime, state: 'queued', deferredReason: 'turn_running' },
        } })}
        liveMode
        onRetryResume={vi.fn()}
        loading={false}
        workMode={false}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
        modelProfiles={readyProfiles}
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
        onLocalSubmittedText={vi.fn(() => ({ id: 'optimistic-2' }))}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
        suspending={false}
        debugOpen={false}
        onToggleDebug={vi.fn()}
        rawLoading={false}
        hasOlderMessages={false}
        loadingOlderMessages={false}
        onLoadOlderMessages={vi.fn()}
        conversationKey="demo:codex:conversation-1"
        historyPrependVersion={0}
      />
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText(/High queued/)).toBeInTheDocument());
  expect(onSetModelProfile).not.toHaveBeenCalled();
});

it('cancels the exact server-owned queued profile request', async () => {
  const onCancelModelProfileRequest = vi.fn().mockResolvedValue(true);
  renderPane({
    onCancelModelProfileRequest,
    sessionOverrides: {
      modelProfileRequest: {
        requestId: 'request-1',
        profile: 'high',
        requestedAt: baseTime,
        state: 'queued',
        deferredReason: 'unsent_input',
      },
    },
  });

  expect(screen.getByText(/Send or clear the terminal draft/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued profile' }));

  await waitFor(() => expect(onCancelModelProfileRequest).toHaveBeenCalledWith('session-1', 'request-1'));
});

describe('ConversationPane live input bridge', () => {
  it.each(['codex', 'claude'] as const)('inserts a dropped agent into the %s draft at the selection without sending', async provider => {
    const resolved = { recipientId: 'peer-assignment', title: 'Review agent', provider: 'claude', projectSlug: 'another-project', conversationRef: 'peer-chat' };
    const lookup = vi.spyOn(api, 'agentReference').mockResolvedValue(resolved);
    const { onSendKeystrokes } = renderPane({ sessionOverrides: { provider } });
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Before REPLACE after' } });
    textbox.setSelectionRange(7, 14);
    fireEvent.drop(textbox, { dataTransfer: { types: [CONVERSATION_DRAG_TYPE], getData: () => JSON.stringify({ projectSlug: 'another-project', provider: 'claude', conversationRef: 'peer-chat' }) } });
    await waitFor(() => expect(textbox.value).toContain('recipientId=peer-assignment'));
    expect(textbox.value).toMatch(/^Before \[Agent "Review agent"/);
    expect(textbox.value).toMatch(/\n after$/);
    expect(textbox.value).not.toContain('REPLACE');
    expect(lookup).toHaveBeenCalledWith({ projectSlug: 'another-project', provider: 'claude', conversationRef: 'peer-chat' });
    expect(onSendKeystrokes).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: '' } });
    lookup.mockRestore();
  });

  it('retains the draft when the dropped chat has no available agent or a malformed payload', async () => {
    const lookup = vi.spyOn(api, 'agentReference').mockRejectedValue(new Error('This chat has no connected agent.'));
    const { onSendKeystrokes } = renderPane();
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Keep this draft' } });
    fireEvent.drop(textbox, { dataTransfer: { types: [CONVERSATION_DRAG_TYPE], getData: () => JSON.stringify({ projectSlug: 'demo', provider: 'codex', conversationRef: 'peer' }) } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no connected agent'));
    expect(textbox).toHaveValue('Keep this draft');
    lookup.mockClear();
    fireEvent.drop(textbox, { dataTransfer: { types: [CONVERSATION_DRAG_TYPE], getData: () => 'not json' } });
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
    expect(textbox).toHaveValue('Keep this draft');
    expect(lookup).not.toHaveBeenCalled();
    expect(onSendKeystrokes).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: '' } });
    lookup.mockRestore();
  });

  it('discards a reference lookup when its composer is replaced during the request', async () => {
    const result = deferred<Awaited<ReturnType<typeof api.agentReference>>>();
    const lookup = vi.spyOn(api, 'agentReference').mockReturnValue(result.promise);
    const first = renderPane();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original draft' } });
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { types: [CONVERSATION_DRAG_TYPE], getData: () => JSON.stringify({ projectSlug: 'demo', provider: 'codex', conversationRef: 'peer' }) } });
    first.unmount();
    const second = renderPane({ sessionOverrides: { id: 'replacement-session' } });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'New composer draft' } });
    await act(async () => result.resolve({ recipientId: 'stale-peer', title: 'Old reference', provider: 'codex', projectSlug: 'demo', conversationRef: 'peer' }));
    expect(textbox).toHaveValue('New composer draft');
    expect(first.onSendKeystrokes).not.toHaveBeenCalled();
    expect(second.onSendKeystrokes).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: '' } });
    lookup.mockRestore();
  });

  it('types a dropped reference through Text Bypass without submitting Enter', async () => {
    const lookup = vi.spyOn(api, 'agentReference').mockResolvedValue({ recipientId: 'bypass-peer', title: 'Helper', provider: 'codex', projectSlug: 'demo', conversationRef: 'helper' });
    const { onSendKeystrokes } = renderPane();
    const textbox = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.drop(textbox, { dataTransfer: { types: [CONVERSATION_DRAG_TYPE], getData: () => JSON.stringify({ projectSlug: 'demo', provider: 'codex', conversationRef: 'helper' }) } });
    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toContain('recipientId=bypass-peer'));
    await waitFor(() => expect(onSendKeystrokes).toHaveBeenCalled());
    expect(onSendKeystrokes).toHaveBeenLastCalledWith('session-1', { text: expect.stringContaining('recipientId=bypass-peer'), deferScreenUpdate: true });
    expect(vi.mocked(onSendKeystrokes).mock.calls.every(([, payload]) => !payload.keys?.includes('Enter'))).toBe(true);
    lookup.mockRestore();
  });

  it('stops Text Bypass after queue acceptance and keeps the next message local until Enter', async () => {
    const queuedInput = { requestId: 'queued-1', text: 'first message', requestedAt: baseTime,
      state: 'queued' as const, reason: 'Waiting for the session to accept input.' };
    const send = vi.fn(async (_sessionId: string, payload: SessionKeystrokeRequest): Promise<SessionInputResponse> => ({
      session: boundSession(), ...(payload.keys?.includes('Enter') ? { queuedInput } : {}),
    }));
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    const bypass = screen.getByRole('button', { name: 'Text Bypass' });
    fireEvent.change(textbox, { target: { value: '' } });
    fireEvent.click(bypass);
    await waitFor(() => expect(bypass).toHaveAttribute('aria-pressed', 'true'));
    for (const key of 'first message') fireEvent.keyDown(textbox, { key });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(bypass).toHaveAttribute('aria-pressed', 'false'));
    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    expect(send.mock.calls.map(call => call[1])).toEqual([
      { text: 'first message', deferScreenUpdate: true },
      { keys: ['Enter'], submittedText: 'first message', clientOptimisticMessageId: 'optimistic-1' },
    ]);
    fireEvent.change(textbox, { target: { value: 'second message' } });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(send).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenLastCalledWith('session-1', {
      text: 'second message', submittedText: 'second message', keys: ['Enter'],
    });
  });

  it('keeps Text Bypass disabled when a pending send is restored', () => {
    renderPane({ sessionOverrides: { queuedInputs: [{ requestId: 'queued-1', text: 'pending message', requestedAt: baseTime,
      state: 'queued', reason: 'Waiting for the session to accept input.' }] } });
    expect(screen.getByRole('button', { name: 'Text Bypass' })).toBeDisabled();
  });

  it('shows an in-flight send without offering cancellation', () => {
    renderPane({ sessionOverrides: { queuedInputs: [{ requestId: 'sending-1', text: 'sending message', requestedAt: baseTime,
      state: 'submitting', reason: 'Sending the message.' }] } });
    expect(screen.getByText('Sending…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel queued send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  const nativeModelMenu = 'Select model\n❯ 1. Default\n2. Opus\nEnter to confirm · Esc to cancel';

  it.each(['Esc', 'keyboard', 'Interrupt session'])('%s interrupts without sending or changing a held draft', async control => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Keep this draft local' } });
    if (control === 'keyboard') fireEvent.keyDown(textbox, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: control }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('session-1', { keys: ['Escape'] }));
    expect(textbox).toHaveValue('Keep this draft local');
    expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it.each(['Esc', 'keyboard', 'Interrupt session'])('%s remains available during a pending send', async control => {
    const pending = deferred<SessionInputResponse>();
    const next = deferred<SessionInputResponse>();
    const send = vi.fn().mockImplementation((_session, request) => request.keys?.includes('Escape')
      ? Promise.resolve({ session: boundSession() }) : request.submittedText === 'The next message' ? next.promise : pending.promise);
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'A pending message' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(textbox).toHaveAttribute('readonly');
    if (control === 'keyboard') fireEvent.keyDown(textbox, { key: 'Escape' });
    else {
      expect(screen.getByRole('button', { name: control })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: control }));
    }
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith('session-1', { keys: ['Escape'] });
    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    expect(textbox).toHaveValue('A pending message');
    fireEvent.change(textbox, { target: { value: 'The next message' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(textbox).toHaveAttribute('readonly');
    pending.resolve({ session: boundSession() });
    await act(async () => { await pending.promise; });
    expect(textbox).toHaveAttribute('readonly');
    expect(textbox).not.toHaveValue('A pending message');
    next.resolve({ session: boundSession() });
    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    expect(textbox).toHaveValue('');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('handles Escape when focus is outside the message editor', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('session-1', { keys: ['Escape'] }));
  });

  it('interrupts Text Bypass without flushing buffered text or a queued Enter', async () => {
    const pending = deferred<SessionInputResponse>();
    const send = vi.fn().mockImplementation((_session, request) => request.keys?.includes('Escape')
      ? Promise.resolve({ session: boundSession() }) : pending.promise);
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.keyDown(textbox, { key: 'x' });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    pending.resolve({ session: boundSession() });
    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    expect(send.mock.calls.map(call => call[1])).toEqual([{ text: 'x', deferScreenUpdate: true }, { keys: ['Escape'] }]);
    expect(textbox).toHaveValue('x');
    expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('keeps unflushed Text Bypass input as an editable local draft after Stop', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.keyDown(textbox, { key: 'x' });
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('session-1', { keys: ['Escape'] }));
    expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'false');
    expect(textbox).toHaveValue('x');
    fireEvent.change(textbox, { target: { value: 'edited locally' } });
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it.each(['claude', 'codex'] as const)('%s menu buttons send only keys and retain the separate draft', async (provider) => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    const view = renderPane({ sessionOverrides: { provider }, onSendKeystrokes: send, inputActive: false,
      screenContent: 'Select model\n❯ 2. Opus 5.5\nEnter to confirm · Esc to cancel' });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Switching models before reviewing the plan' } });
    for (const [label, key] of [['↓', 'Down'], ['Enter', 'Enter'], ['Esc', 'Escape']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(send).toHaveBeenLastCalledWith('session-1', { keys: [key] }));
      await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
      expect(textbox).toHaveValue('Switching models before reviewing the plan');
      expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'false');
    }
    view.unmount();
    renderPane({ sessionOverrides: { provider }, onSendKeystrokes: send });
    expect(screen.getByRole('textbox')).toHaveValue('Switching models before reviewing the plan');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
  });

  it('menu Enter retains attached images and never sends them to the selection', async () => {
    const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    try {
      renderPane({ inputActive: false, screenContent: 'Enter to confirm · Esc to cancel', onSendKeystrokes: send });
      pasteImage(screen.getByRole('textbox'));
      await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
      await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', { keys: ['Enter'] }));
      expect(screen.getByAltText('Pasted image.png')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }));
    } finally { upload.mockRestore(); }
  });

  it.each(['button', 'keyboard'] as const)('%s Enter sends a numeric menu choice without consuming images', async (source) => {
    const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    try {
      const { onLocalSubmittedText } = renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: '2' } });
      pasteImage(textbox);
      await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
      if (source === 'button') fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
      else fireEvent.keyDown(textbox, { key: 'Enter' });
      await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', { text: '2', submittedText: '2', keys: ['Enter'] }));
      await waitFor(() => expect(textbox).toHaveValue(''));
      expect(onLocalSubmittedText).not.toHaveBeenCalled();
      expect(screen.getByAltText('Pasted image.png')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }));
    } finally { upload.mockRestore(); }
  });

  it.each(['claude', 'codex'] as const)('%s menu Enter flushes buffered bypass text and consumes its preview', async (provider) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const send = vi.fn().mockResolvedValue({ session: boundSession() });
      const { onLocalSubmittedText } = renderPane({ sessionOverrides: { provider }, inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      fireEvent.keyDown(textbox, { key: '2' });
      expect(send).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([
        { text: '2', deferScreenUpdate: true }, { keys: ['Enter'], submittedText: '2' },
      ]);
      expect(textbox).toHaveValue('');
      expect(onLocalSubmittedText).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(45); });
      expect(send).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('waits for in-flight bypass text acknowledgement before confirming a menu', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const typed = deferred<SessionInputResponse | undefined>();
      const send = vi.fn().mockImplementationOnce(() => typed.promise).mockResolvedValue({ session: boundSession() });
      renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      fireEvent.keyDown(textbox, { key: '2' });
      await act(async () => { await vi.advanceTimersByTimeAsync(45); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([{ text: '2', deferScreenUpdate: true }]);
      await act(async () => { typed.resolve({ session: boundSession() }); });
      expect(send.mock.calls.map(call => call[1])).toEqual([
        { text: '2', deferScreenUpdate: true }, { keys: ['Enter'], submittedText: '2' },
      ]);
      expect(textbox).toHaveValue('');
    } finally { vi.useRealTimers(); }
  });

  it('does not confirm a menu if buffered bypass text was rejected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      fireEvent.keyDown(textbox, { key: '2' });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([{ text: '2', deferScreenUpdate: true }]);
      expect(textbox).toHaveValue('2');
    } finally { vi.useRealTimers(); }
  });

  it('retains bypass selection preview and images when menu Enter is rejected', async () => {
    const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValueOnce({ session: boundSession() }).mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onLocalSubmittedText } = renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      await act(async () => { pasteImage(textbox); });
      fireEvent.keyDown(textbox, { key: '2' });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([
        { text: '2', deferScreenUpdate: true }, { keys: ['Enter'], submittedText: '2' },
      ]);
      expect(textbox).toHaveValue('2');
      expect(onLocalSubmittedText).not.toHaveBeenCalled();
      expect(screen.getByAltText('Pasted image.png')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }));
    } finally { vi.useRealTimers(); upload.mockRestore(); }
  });

  it('cancels a menu without flushing buffered bypass text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const send = vi.fn().mockResolvedValue({ session: boundSession() });
      renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      fireEvent.keyDown(textbox, { key: '2' });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Esc' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([{ keys: ['Escape'] }]);
      expect(textbox).toHaveValue('2');
      await act(async () => { await vi.advanceTimersByTimeAsync(45); });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('Enter in a nonempty draft textarea keeps guarded chat submission at a native menu', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    renderPane({ inputActive: false, screenContent: 'Enter to confirm · Esc to cancel', onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'My unsent instruction' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', {
      text: 'My unsent instruction', submittedText: 'My unsent instruction', keys: ['Enter'],
    }));
    await waitFor(() => expect(textbox).toHaveValue('My unsent instruction'));
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('quoted menu instructions at an active composer keep normal chat submission', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ inputActive: true, sessionOverrides: { isWorking: false },
      screenContent: 'Enter to confirm · Esc to cancel', onSendKeystrokes: send });
    expect(screen.queryByTestId('live-screen-panel')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'This is my chat message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', {
      text: 'This is my chat message', submittedText: 'This is my chat message', keys: ['Enter'],
    }));
  });

  it('Smaller resets an oversized saved input without changing the draft', () => {
    localStorage.setItem('agent-console:live-bridge-height', '400');
    try {
      renderPane();
      const textbox = screen.getByRole('textbox');
      fireEvent.change(textbox, { target: { value: 'keep this draft while resizing' } });
      expect(textbox).toHaveStyle({ height: '400px' });
      fireEvent.click(screen.getByRole('button', { name: 'Reset input height' }));
      expect(textbox).toHaveStyle({ height: '96px' });
      expect(textbox).toHaveValue('keep this draft while resizing');
      expect(localStorage.getItem('agent-console:live-bridge-height')).toBe('96');
      fireEvent.change(textbox, { target: { value: '' } });
    } finally { localStorage.removeItem('agent-console:live-bridge-height'); }
  });

  it('opens mobile input compactly, caps long drafts above the keyboard, and preserves desktop sizing', () => {
    localStorage.setItem('agent-console:live-bridge-height', '600');
    const viewport = Object.assign(new EventTarget(), { height: 600 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      renderPane({ mobileInputPanel: 'reply' });
      const textbox = screen.getByRole('textbox');
      expect(textbox).toHaveStyle({ height: '44px' });
      Object.defineProperty(textbox, 'scrollHeight', { configurable: true, value: 600 });
      fireEvent.change(textbox, { target: { value: 'A long mobile draft' } });
      expect(textbox).toHaveStyle({ height: '112px' });
      viewport.height = 320;
      act(() => { viewport.dispatchEvent(new Event('resize')); });
      expect(parseFloat(textbox.style.height)).toBeLessThanOrEqual(71);
      expect(textbox).toHaveValue('A long mobile draft');
      expect(screen.queryByRole('button', { name: 'Reset input height' })).not.toBeInTheDocument();
      expect(localStorage.getItem('agent-console:live-bridge-height')).toBe('600');
      fireEvent.change(textbox, { target: { value: '' } });
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem('agent-console:live-bridge-height');
    }
  });

  it('allows the server to decide suspension when the provider working label includes an input wait', () => {
    const onSuspend = vi.fn().mockResolvedValue(undefined);
    renderPane({ sessionOverrides: { isWorking: true }, onSuspend,
      screenContent: 'Do you want to proceed?\n1. Yes\n2. No\nEnter to confirm · Esc to cancel' });
    const button = screen.getByRole('button', { name: 'Suspend' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSuspend).toHaveBeenCalledWith('session-1');
  });

  it('restores a rejected draft and keeps it when the conversation is reopened', async () => {
    const send = deferred<SessionInputResponse | undefined>();
    const onSendKeystrokes = vi.fn(() => send.promise);
    const view = renderPane({ onSendKeystrokes });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'keep the background build running' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(textbox).toHaveValue('');

    send.resolve(undefined);

    await waitFor(() => expect(textbox).toHaveValue('keep the background build running'));
    expect(onSendKeystrokes).toHaveBeenCalledTimes(1);

    view.unmount();
    renderPane({ onSendKeystrokes });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('keep the background build running'));
    expect(onSendKeystrokes).toHaveBeenCalledTimes(1);
  });

  it('clears the normal draft immediately after Enter while the keystroke request is pending', () => {
    const send = deferred<SessionInputResponse | undefined>();
    renderPane({
      onSendKeystrokes: vi.fn(() => send.promise),
    });
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textbox, { target: { value: 'recap where we left things' } });
    expect(textbox.value).toBe('recap where we left things');

    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(textbox.value).toBe('');
    send.resolve({ session: boundSession() });
  });

  it('clears the text-bypass preview immediately after local submission even when terminal input still contains that text', async () => {
    const send = deferred<SessionInputResponse | undefined>();
    const onLocalSubmittedText = vi.fn(() => ({ id: 'optimistic-1' }));
    const { rerender } = renderPane({
      onSendKeystrokes: vi.fn(() => send.promise),
      onLocalSubmittedText,
    });
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.keyDown(textbox, { key: 'r' });
    fireEvent.keyDown(textbox, { key: 'e' });
    fireEvent.keyDown(textbox, { key: 'c' });
    fireEvent.keyDown(textbox, { key: 'a' });
    fireEvent.keyDown(textbox, { key: 'p' });
    expect(textbox.value).toBe('recap');

    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(onLocalSubmittedText).toHaveBeenCalledWith('session-1', 'recap');
    expect(textbox.value).toBe('');

    rerender(
      <MemoryRouter>
        <ConversationPane
          projects={[project()]}
          project={project()}
          selectedProvider="codex"
          timeline={timeline({ inputText: 'recap' })}
          liveMode
          onRetryResume={vi.fn()}
          loading={false}
          workMode={false}
          mobileChromeHidden={false}
          onToggleMobileChrome={vi.fn()}
          onBind={vi.fn()}
          onRelease={vi.fn()}
          onSuspend={vi.fn()}
          onSendKeystrokes={vi.fn(() => send.promise)}
          modelProfiles={readyProfiles}
          onSetModelProfile={vi.fn().mockResolvedValue(true)}
          onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
          onLocalSubmittedText={onLocalSubmittedText}
          onDiscardLocalSubmittedText={vi.fn()}
          binding={false}
          releasing={false}
          suspending={false}
          debugOpen={false}
          onToggleDebug={vi.fn()}
          rawLoading={false}
          hasOlderMessages={false}
          loadingOlderMessages={false}
          onLoadOlderMessages={vi.fn()}
          conversationKey="demo:codex:conversation-1"
          historyPrependVersion={0}
        />
      </MemoryRouter>,
    );

    expect(textbox.value).toBe('');
    send.resolve({ session: boundSession() });
  });

  it('does not promote server-derived input text into a pending user transcript row', () => {
    renderPane({ inputText: '/model' });

    expect(screen.getByText('Waiting for session output…')).toBeInTheDocument();
    expect(screen.queryByText('/model')).not.toBeInTheDocument();
  });

  it('submits /model from ordinary entry as a terminal command', async () => {
    const onSendKeystrokes = vi.fn().mockResolvedValue({ session: boundSession() });
    const { onLocalSubmittedText } = renderPane({ onSendKeystrokes });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: '/model' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });

    await waitFor(() => expect(onSendKeystrokes).toHaveBeenCalledWith('session-1', {
      text: '/model', keys: ['Enter'], submittedText: '/model',
    }));
    expect(onLocalSubmittedText).not.toHaveBeenCalled();
  });

  it('submits /model from Text Bypass without creating a conversation turn', async () => {
    const onSendKeystrokes = vi.fn().mockResolvedValue({ session: boundSession() });
    const { onLocalSubmittedText } = renderPane({ onSendKeystrokes });
    const textbox = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));
    for (const key of '/model') fireEvent.keyDown(textbox, { key });
    expect(screen.getByText('Waiting for session output…')).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: 'Enter' });

    await waitFor(() => expect(onSendKeystrokes).toHaveBeenCalledWith('session-1', {
      keys: ['Enter'], submittedText: '/model',
    }));
    expect(onLocalSubmittedText).not.toHaveBeenCalled();
  });

  it('does not show ordinary terminal scrollback as a live screen panel', () => {
    renderPane({
      inputText: 'Giovanni Severini is a real prospect — a referral from my dad',
      screenContent: [
        'Hidden risk: CTO failure cluster is live and daily.',
        'Where do you want to start — the exit math, or the client-acquisition commitment?',
      ].join('\n'),
    });

    expect(screen.getByText('Waiting for session output…')).toBeInTheDocument();
    expect(screen.queryByText(/Giovanni Severini is a real prospect/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-screen-panel')).not.toBeInTheDocument();
  });

  it('shows interactive live screen output for terminal pickers', () => {
    renderPane({
      sessionOverrides: { isWorking: false },
      inputActive: false,
      inputText: '/model',
      screenContent: [
        'gpt-5.5 default fast · ~/code/demo',
        '',
        '  /model  choose what model and reasoning effort to use',
      ].join('\n'),
    });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('choose what model and reasoning effort to use');
  });

  it.each([
    ['Select Model and Effort', 'enter select · esc back'],
    ['Select Reasoning Level for GPT-6-Sol', 'enter default · s session · esc back'],
  ])('shows the current Codex %s picker', (heading, footer) => {
    renderPane({ inputActive: false, sessionOverrides: { isWorking: false },
      screenContent: `${heading}\n› 2. GPT-6-Sol (current)\n${footer}` });
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent(heading);
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent(footer);
  });

  it('shows a Claude approval menu while the session is idle', () => {
    renderPane({ inputActive: false, sessionOverrides: { provider: 'claude', isWorking: false },
      screenContent: 'Do you want to proceed?\n❯ 1. Yes\n2. No\nEnter to confirm · Esc to cancel' });
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('Do you want to proceed?');
  });

  it('shows provider progress while Claude is still thinking', () => {
    renderPane({
      sessionOverrides: { provider: 'claude', isWorking: true },
      screenContent: [
        '* Fluttering… (6m 29s · almost done thinking with medium effort)',
        '⎿ Tip: Try setting environment variable COLORTERM=truecolor for richer colors',
      ].join('\n'),
    });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('almost done thinking with medium effort');
  });

  it('shows provider progress when only the status line is active', () => {
    renderPane({
      sessionOverrides: { isWorking: true },
      screenStatus: '* still thinking with medium effort',
      screenStatusAnsi: '\u001b[33m* still thinking with medium effort\u001b[39m',
    });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('still thinking with medium effort');
  });

  it.each([
    ['codex', 'Enter to confirm · Esc to cancel'],
    ['claude', 'Enter to confirm · Esc to cancel'],
    ['codex', '/model choose a different model'],
    ['claude', '/model choose a different model'],
  ] as const)('keeps the completed %s answer in chat when it quotes %s', (provider, quotedControl) => {
    const answer = `The preview is ready. For later changes:\n\n${quotedControl}`;
    renderPane({
      sessionOverrides: { provider, isWorking: false },
      messages: [{ id: 'completed-answer', provider, role: 'assistant', lifecycle: 'durable',
        text: answer, timestamp: baseTime, conversationRef: 'conversation-1', source: 'history-file' }],
      screenContent: `${answer}\nBrewed for 10s · done 5:02 AM · 1 shell still running\nTry thinking about the next step.`,
      screenStatus: '⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage',
    });

    expect(screen.getByText('The preview is ready. For later changes:')).toBeVisible();
    expect(screen.getByText(quotedControl)).toBeVisible();
    expect(screen.queryByTestId('live-screen-panel')).not.toBeInTheDocument();
  });

  it('shows current working output without depending on provider-specific progress words', () => {
    renderPane({ sessionOverrides: { isWorking: true }, screenContent: 'Inspecting the latest build results.' });
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('Inspecting the latest build results.');
  });

  it('mirrors text-bypass typing into the main transcript before submission', async () => {
    renderPane();
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text Bypass' })).toHaveAttribute('aria-pressed', 'true'));

    for (const key of 'hello') fireEvent.keyDown(textbox, { key });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getAllByText('hello').length).toBeGreaterThan(1);
  });
});

describe('ConversationPane external Claude handoff', () => {
  it.each([
    { name: 'unknown Claude history', closed: false, active: false, mobile: false, workMode: false },
    { name: 'closed desktop chat', closed: true, active: false, mobile: false, workMode: false },
    { name: 'closed chat in desktop Work mode', closed: true, active: false, mobile: false, workMode: true },
    { name: 'closed mobile chat', closed: true, active: false, mobile: true, workMode: false },
    { name: 'resumed chat with a previous close', closed: true, active: true, mobile: false, workMode: false },
  ])('offers the correct resume action for $name', async ({ closed, active, mobile, workMode }) => {
    const media = vi.spyOn(globalThis, 'matchMedia').mockImplementation(query => ({
      matches: mobile, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    try {
      const onBind = vi.fn().mockResolvedValue(undefined);
      const externalTimeline: ConversationTimeline = {
        conversation: {
          ref: 'external-claude-chat',
          kind: 'history',
          projectSlug: 'demo',
          provider: 'claude',
          title: 'Review Waltium business plan',
          updatedAt: baseTime,
          isBound: active,
          lastClosedAt: closed ? baseTime : undefined,
          degraded: false,
        },
        messages: [],
        boundSession: active ? boundSession({ provider: 'claude' }) : undefined,
        liveScreen: undefined,
        messagePage: { hasOlder: false, total: 0 },
      };
      function HandoffPane({ conversationKey }: { conversationKey: string }) {
        return (
          <MemoryRouter>
            <ConversationPane
              projects={[project()]}
              project={project()}
              selectedProvider="claude"
              timeline={externalTimeline}
              liveMode={false}
              onRetryResume={vi.fn()}
              loading={false}
              workMode={workMode}
              mobileChromeHidden={false}
              onToggleMobileChrome={vi.fn()}
              onBind={onBind}
              onRelease={vi.fn()}
              onSuspend={vi.fn()}
              onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
              modelProfiles={readyProfiles}
              onSetModelProfile={vi.fn().mockResolvedValue(true)}
              onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
              onLocalSubmittedText={vi.fn()}
              onDiscardLocalSubmittedText={vi.fn()}
              binding={false}
              releasing={false}
              suspending={false}
              debugOpen={false}
              onToggleDebug={vi.fn()}
              rawLoading={false}
              hasOlderMessages={false}
              loadingOlderMessages={false}
              onLoadOlderMessages={vi.fn()}
              conversationKey={conversationKey}
              historyPrependVersion={0}
            />
          </MemoryRouter>
        );
      }
      const view = render(<HandoffPane conversationKey="demo:claude:external-claude-chat" />);

      if (active) {
        expect(screen.getByText('Bound')).toBeVisible();
        expect(screen.queryByText(/This conversation is closed/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Resume$/ })).not.toBeInTheDocument();
        return;
      }
      if (closed) {
        expect(screen.getByText(/This conversation is closed/)).toBeVisible();
        expect(screen.queryByText(/outside Agent Console/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Move to Agent Console' })).not.toBeInTheDocument();
        fireEvent.click(screen.getAllByRole('button', { name: /^Resume$/ })[0]!);
        await waitFor(() => expect(onBind).toHaveBeenCalledExactlyOnceWith());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        return;
      }
      expect(screen.getByText(/This Claude chat is not currently managed by Agent Console/)).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Move to Agent Console' })[0]!);
      expect(screen.getByRole('dialog')).toHaveTextContent('If this chat is running in another terminal, stop that session first');
      expect(screen.getByRole('button', { name: 'Start in Agent Console' })).toBeDisabled();

      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Start in Agent Console' }));
      await waitFor(() => expect(onBind).toHaveBeenCalledWith({ confirmExternalHandoff: true }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(screen.getAllByRole('button', { name: 'Move to Agent Console' })[0]!);
      fireEvent.click(screen.getByRole('checkbox'));
      view.rerender(<HandoffPane conversationKey="demo:claude:another-chat" />);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(onBind).toHaveBeenCalledTimes(1);
    } finally { media.mockRestore(); }
  });
});

describe('ConversationPane app-server (structured) sessions', () => {
  const structured = { transport: 'structured' as const, tmuxSessionName: 'acs-session-1' };
  const terminalOnlyButtons = ['Text Bypass', 'Backspace', 'Tab', '↑', '↓', '←', '→'];

  it('hides every terminal-only control and shows the app-server badge', () => {
    renderPane({ sessionOverrides: structured });

    for (const name of terminalOnlyButtons) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText('app-server')).toBeVisible();
    expect(screen.getByText('Bound')).toBeVisible();
  });

  it('labels a structured Claude session headless, not app-server', () => {
    renderPane({ sessionOverrides: { ...structured, provider: 'claude', claudeProfile: 'medium' } });

    expect(screen.getByText('headless')).toBeVisible();
    expect(screen.queryByText('app-server')).not.toBeInTheDocument();
  });

  it('labels a structured Grok session ACP and names the Grok ACP protocol in its tooltip', () => {
    renderPane({ sessionOverrides: { ...structured, provider: 'grok', grokProfile: 'medium' } });

    expect(screen.getByText('ACP')).toHaveAttribute('title', 'Driven through the Grok ACP protocol rather than a terminal');
    expect(screen.queryByText('app-server')).not.toBeInTheDocument();
    expect(screen.queryByText('headless')).not.toBeInTheDocument();
  });

  it('keeps Send, Esc and Stop, the model profile controls, copy, suspend and release', () => {
    renderPane({ sessionOverrides: structured });

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Esc' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeVisible();
    for (const profile of ['high', 'medium', 'low']) {
      expect(screen.getByRole('button', { name: `Use ${profile} Codex profile` })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: 'Copy latest assistant message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Release' })).toBeVisible();
  });

  it('submits a message with Enter and interrupts with Esc exactly like a terminal chat', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession(structured) });
    renderPane({ onSendKeystrokes: send, sessionOverrides: structured });
    const textbox = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(textbox, { target: { value: 'build the thing' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toBe('session-1');
    expect(send.mock.calls[0]?.[1]).toMatchObject({ keys: ['Enter'], submittedText: 'build the thing' });

    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('session-1', { keys: ['Escape'] }));
  });

  it('does not forward arrow keys, Tab or Backspace, and Ctrl+/ cannot start Text Bypass', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession(structured) });
    renderPane({ onSendKeystrokes: send, sessionOverrides: structured });
    const textbox = screen.getByRole('textbox', { name: 'Message' });

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace']) {
      fireEvent.keyDown(textbox, { key });
    }
    fireEvent.keyDown(textbox, { key: '/', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    // In Text Bypass the textarea only mirrors terminal input and ignores edits.
    fireEvent.change(textbox, { target: { value: 'still an ordinary draft' } });

    expect(send).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('still an ordinary draft');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('uploads pasted images and sends them with the message, as on a terminal chat', async () => {
    const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValue({ session: boundSession(structured) });
    try {
      renderPane({ onSendKeystrokes: send, sessionOverrides: structured });
      const textbox = screen.getByRole('textbox', { name: 'Message' });
      const file = pasteImage(textbox);

      await waitFor(() => expect(screen.getByAltText('Pasted image.png')).toBeVisible());
      expect(upload).toHaveBeenCalledWith('session-1', file, undefined);
      fireEvent.keyDown(textbox, { key: 'Enter' });
      await waitFor(() => expect(send).toHaveBeenCalledWith('session-1', { keys: ['Enter'], imageIds: [pastedImage.id] }));
      await waitFor(() => expect(screen.queryByAltText('Pasted image.png')).not.toBeInTheDocument());
    } finally {
      upload.mockRestore();
    }
  });

  it('never shows the terminal screen panel, even for picker-like screen text', () => {
    renderPane({
      sessionOverrides: { ...structured, isWorking: false },
      inputActive: false,
      inputText: '/model',
      screenContent: 'Select Model and Effort\n› 2. GPT-6-Sol (current)\nenter select · esc back',
    });

    expect(screen.queryByTestId('live-screen-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/Select Model and Effort/)).not.toBeInTheDocument();
    expect(screen.getByText('Send a message to start this app-server session.')).toBeVisible();
  });

  it('copes with an empty synthesized screen and still shows the session status block', () => {
    renderPane({
      sessionOverrides: structured,
      screenContent: '',
      screenStatus: 'Idle',
      screenModel: 'gpt-5.5',
    });

    expect(screen.queryByTestId('live-screen-panel')).not.toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeVisible();
  });

  it('keeps the queued-message and provider-failure notices', () => {
    renderPane({
      sessionOverrides: {
        ...structured,
        queuedInputs: [{ requestId: 'queued-1', text: 'pending message', requestedAt: baseTime,
          state: 'queued', reason: 'Waiting for the session to accept input.' }],
        runFailure: { turnId: 't1', failedAt: baseTime, code: 'server_overloaded', message: 'Selected model is at capacity.',
          attempts: 0, maxAttempts: 3, status: 'scheduled', nextRetryAt: baseTime },
      },
    });

    expect(screen.getByText('pending message')).toBeVisible();
    expect(screen.getByText(/Selected model is at capacity\./)).toBeVisible();
  });

  it('leaves a terminal session unchanged: all keys, Text Bypass and no badge', () => {
    renderPane();

    for (const name of terminalOnlyButtons) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }
    expect(screen.queryByText('app-server')).not.toBeInTheDocument();
  });
});


describe('ConversationPane agent question card', () => {
  const structured = { transport: 'structured' as const, tmuxSessionName: 'acs-session-1' };
  const ask = (overrides: Partial<PendingRequestSummary> = {}): PendingRequestSummary => ({
    requestId: 'q1',
    kind: 'question',
    summary: 'Fixture: Strict schemas or UI flexibility?',
    openedAt: baseTime,
    questions: [{
      id: 'schema',
      header: 'Fixture',
      question: 'Strict schemas or UI flexibility?',
      options: [{ label: 'Strict', description: 'Validate tightly' }, { label: 'Flexible' }],
      allowCustom: true,
    }],
    ...overrides,
  });
  const answered = () => vi.spyOn(api, 'answerSessionRequest').mockResolvedValue({ session: boundSession(structured) });

  it('shows the header, question, options, a typed-answer field, Submit and Decline, and leaves the composer usable', () => {
    renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });

    const card = screen.getByRole('region', { name: 'Agent question' });
    expect(card).toHaveTextContent('Fixture');
    expect(card).toHaveTextContent('Strict schemas or UI flexibility?');
    expect(screen.getByRole('radio', { name: /Strict/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Flexible/ })).toBeVisible();
    expect(screen.getByLabelText('Your answer: Fixture')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    expect(composer).toBeEnabled();
    expect(composer).not.toHaveAttribute('readonly');
  });

  it('submits the chosen option once and only then', async () => {
    const answer = answered();
    try {
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('radio', { name: /Strict/ }));
      expect(screen.getByRole('radio', { name: /Strict/ })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('radio', { name: /Flexible/ }));
      expect(screen.getByRole('radio', { name: /Strict/ })).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(screen.getByRole('radio', { name: /Strict/ }));

      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
      expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'answer', answers: { schema: ['Strict'] } }, undefined);
    } finally { answer.mockRestore(); }
  });

  it('disables the card while the answer is on its way, so it cannot be sent twice', async () => {
    const pending = deferred<{ session: BoundSession }>();
    const answer = vi.spyOn(api, 'answerSessionRequest').mockImplementation(() => pending.promise);
    try {
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('radio', { name: /Strict/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(answer).toHaveBeenCalledTimes(1);
      pending.resolve({ session: boundSession(structured) });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled());
    } finally { answer.mockRestore(); }
  });

  it('sends a typed answer instead of an option', async () => {
    const answer = answered();
    try {
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('radio', { name: /Strict/ }));
      fireEvent.change(screen.getByLabelText('Your answer: Fixture'), { target: { value: '  something else  ' } });
      expect(screen.getByRole('radio', { name: /Strict/ })).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'answer', answers: { schema: ['something else'] } }, undefined));
    } finally { answer.mockRestore(); }
  });

  it('lets a multi-select question take several options and a typed one', async () => {
    const answer = answered();
    try {
      const request = ask({ questions: [{
        id: 'tags', question: 'Which areas?', options: [{ label: 'Server' }, { label: 'Web' }, { label: 'Docs' }], multiSelect: true, allowCustom: true,
      }] });
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [request] } });
      fireEvent.click(screen.getByRole('checkbox', { name: /Server/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Web/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Docs/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Docs/ }));
      fireEvent.change(screen.getByLabelText('Your answer: Which areas?'), { target: { value: 'tests' } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'answer', answers: { tags: ['Server', 'Web', 'tests'] } }, undefined));
    } finally { answer.mockRestore(); }
  });

  it('needs an answer to every question before Submit, and offers only a text field when there are no options', async () => {
    const answer = answered();
    try {
      const request = ask({ questions: [
        { id: 'a', question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
        { id: 'b', question: 'Name it', options: [] },
      ] });
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [request] } });
      expect(screen.queryByLabelText('Your answer: First?')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
      expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Your answer: Name it'), { target: { value: 'Orion' } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'answer', answers: { a: ['Yes'], b: ['Orion'] } }, undefined));
    } finally { answer.mockRestore(); }
  });

  it('declines without needing an answer', async () => {
    const answer = answered();
    try {
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'decline' }, undefined));
    } finally { answer.mockRestore(); }
  });

  it('says so when the question is no longer waiting, and allows trying again for other failures', async () => {
    const answer = vi.spyOn(api, 'answerSessionRequest')
      .mockRejectedValueOnce(new ApiError('That request is no longer waiting for an answer.', { status: 404 }))
      .mockRejectedValueOnce(new ApiError('Boom', { status: 500 }));
    try {
      renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer waiting for an answer'));
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Boom'));
      expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
    } finally { answer.mockRestore(); }
  });

  it('shows one card per open question', () => {
    renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask(), ask({ requestId: 'q2', questions: [{ id: 'x', question: 'Another?', options: [] }] })] } });
    expect(screen.getAllByRole('region', { name: 'Agent question' })).toHaveLength(2);
  });

  it('shows nothing for a session without questions, a terminal session, or a request that is not a question', () => {
    renderPane({ sessionOverrides: structured });
    expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument();
    renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
    expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument();
    renderPane({ sessionOverrides: { ...structured, pendingRequests: [ask({ kind: 'permission', questions: [] })] } });
    expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument();
  });
});
