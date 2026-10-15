import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationTimeline, NormalizedMessage, ProjectSummary, SessionInputResponse, SessionKeystrokeRequest } from '@agent-console/shared';
import { ConversationPane } from './ConversationPane';
import { api } from '../lib/api';

const baseTime = '2026-07-02T12:00:00.000Z';

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
  inputText?: string;
  inputActive?: boolean;
  mobileControlsHidden?: boolean;
  screenContent?: string;
  screenContentAnsi?: string;
  screenStatus?: string;
  screenStatusAnsi?: string;
  screenModel?: string;
  onSendKeystrokes?: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<SessionInputResponse | undefined>;
  onSetModelProfile?: (sessionId: string, profile: 'high' | 'medium' | 'low') => Promise<boolean>;
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
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        mobileControlsHidden={input.mobileControlsHidden ?? false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={input.onSuspend ?? vi.fn()}
        onSendKeystrokes={onSendKeystrokes}
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
  expect(screen.getByRole('button', { name: 'Use low Claude profile' })).toHaveAttribute('title', expect.stringContaining('claude-sonnet-5 / high'));
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'keep this Claude draft' } });
  fireEvent.keyDown(textbox, { key: 'h', altKey: true });
  await waitFor(() => expect(onSetModelProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(textbox).toHaveValue('keep this Claude draft');
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
        mobileControlsHidden={false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
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
        mobileControlsHidden={false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
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

  it.each(['claude', 'codex'] as const)('%s menu buttons send only keys and retain the separate draft', async (provider) => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    const view = renderPane({ sessionOverrides: { provider }, onSendKeystrokes: send,
      inputActive: false, mobileControlsHidden: true,
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

  it('flushes buffered bypass text before cancelling a menu', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const send = vi.fn().mockResolvedValue({ session: boundSession() });
      renderPane({ inputActive: false, screenContent: nativeModelMenu, onSendKeystrokes: send });
      const textbox = screen.getByRole('textbox');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text Bypass' })); });
      fireEvent.keyDown(textbox, { key: '2' });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Esc' })); });
      expect(send.mock.calls.map(call => call[1])).toEqual([
        { text: '2', deferScreenUpdate: true }, { keys: ['Escape'] },
      ]);
      expect(textbox).toHaveValue('');
      await act(async () => { await vi.advanceTimersByTimeAsync(45); });
      expect(send).toHaveBeenCalledTimes(2);
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
    renderPane({ inputActive: true, screenContent: 'Enter to confirm · Esc to cancel', onSendKeystrokes: send });
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

  it('caps mobile input against the visible viewport and shrinks when the keyboard opens', () => {
    localStorage.setItem('agent-console:live-bridge-height', '600');
    const viewport = Object.assign(new EventTarget(), { height: 600 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      renderPane();
      const textbox = screen.getByRole('textbox');
      expect(textbox).toHaveStyle({ height: '180px' });
      viewport.height = 320;
      act(() => { viewport.dispatchEvent(new Event('resize')); });
      expect(textbox).toHaveStyle({ height: '96px' });
      expect(screen.getByRole('button', { name: 'Reset input height' })).toBeVisible();
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
          mobileControlsHidden={false}
          onToggleMobileControls={vi.fn()}
          onBind={vi.fn()}
          onRelease={vi.fn()}
          onSuspend={vi.fn()}
          onSendKeystrokes={vi.fn(() => send.promise)}
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
    renderPane({ screenContent: `${heading}\n› 2. GPT-6-Sol (current)\n${footer}` });
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent(heading);
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent(footer);
  });

  it('shows provider progress while Claude is still thinking', () => {
    renderPane({
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
      screenStatus: '* still thinking with medium effort',
      screenStatusAnsi: '\u001b[33m* still thinking with medium effort\u001b[39m',
    });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-screen-panel')).toHaveTextContent('still thinking with medium effort');
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
  it('keeps an external Claude transcript read-only until the user confirms handoff', async () => {
    const onBind = vi.fn().mockResolvedValue(undefined);
    const externalTimeline: ConversationTimeline = {
      conversation: {
        ref: 'external-claude-chat',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'claude',
        title: 'Review Waltium business plan',
        updatedAt: baseTime,
        isBound: false,
        degraded: false,
      },
      messages: [],
      boundSession: undefined,
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
            workMode={false}
            mobileChromeHidden={false}
            onToggleMobileChrome={vi.fn()}
            mobileControlsHidden={false}
            onToggleMobileControls={vi.fn()}
            onBind={onBind}
            onRelease={vi.fn()}
            onSuspend={vi.fn()}
            onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
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

    expect(screen.getByText(/This Claude chat is outside Agent Console/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to Agent Console' })[0]!);
    expect(screen.getByRole('dialog')).toHaveTextContent('stop that terminal session first');
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
  });
});
