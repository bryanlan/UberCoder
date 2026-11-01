import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationTimeline, NormalizedMessage, PendingRequestSummary, ProjectSummary, SessionInputResponse, SessionKeystrokeRequest } from '@agent-console/shared';
import { ConversationPane, type MobileInputPanel } from './ConversationPane';
import { api, ApiError } from '../lib/api';
import { CONVERSATION_DRAG_TYPE } from '../features/conversation/agent-reference';

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
    it(`${provider} image-only submissions retain images on rejection and clear them on success`, async () => {
      const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
      const send = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ session: boundSession() });
      try {
        renderPane({ sessionOverrides: { provider }, onSendKeystrokes: send });
        const textbox = screen.getByRole('textbox');
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
    status: 'bound',
    shouldRestore: true,
    title: 'Demo conversation',
    startedAt: baseTime,
    updatedAt: baseTime,
    ...overrides,
  };
}

function timeline(input: {
  messages?: NormalizedMessage[];
  screenStatus?: string;
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
      content: '',
      inputText: '',
      inputActive: true,
      status: input.screenStatus ?? 'Session active',
      capturedAt: baseTime,
      model: input.screenModel,
    },
    messagePage: { hasOlder: false, total: 0 },
  };
}

function renderPane(input: {
  mobileInputPanel?: MobileInputPanel;
  onCloseMobileInput?: () => void;
  messages?: NormalizedMessage[];
  screenStatus?: string;
  screenModel?: string;
  onSendKeystrokes?: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<SessionInputResponse | undefined>;
  onSetModelProfile?: (sessionId: string, profile: 'high' | 'medium' | 'low') => Promise<boolean>;
  onCancelModelProfileRequest?: (sessionId: string, requestId: string) => Promise<boolean>;
  onSuspend?: (sessionId: string) => Promise<void>;
  sessionOverrides?: Partial<BoundSession>;
} = {}) {
  const onSendKeystrokes = input.onSendKeystrokes ?? vi.fn().mockResolvedValue({ session: boundSession() });
  const onSetModelProfile = input.onSetModelProfile ?? vi.fn().mockResolvedValue(true);
  const onCancelModelProfileRequest = input.onCancelModelProfileRequest ?? vi.fn().mockResolvedValue(true);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider={input.sessionOverrides?.provider ?? 'codex'}
        timeline={timeline({
          messages: input.messages,
          screenStatus: input.screenStatus,
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
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={onCancelModelProfileRequest}
        binding={false}
        releasing={false}
        suspending={false}
        hasOlderMessages={false}
        loadingOlderMessages={false}
        onLoadOlderMessages={vi.fn()}
        conversationKey={`demo:${input.sessionOverrides?.provider ?? 'codex'}:conversation-1`}
        historyPrependVersion={0}
      />
    </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onSendKeystrokes, onSetModelProfile, onCancelModelProfileRequest };
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
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSuspend={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue({ session: boundSession() })}
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
        binding={false}
        releasing={false}
        suspending={false}
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
        onSetModelProfile={onSetModelProfile}
        onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
        binding={false}
        releasing={false}
        suspending={false}
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

  expect(screen.getByText(/queued until the pending message is sent or dismissed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued profile' }));

  await waitFor(() => expect(onCancelModelProfileRequest).toHaveBeenCalledWith('session-1', 'request-1'));
});

describe('ConversationPane message box', () => {
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

  it('shows an in-flight send without offering cancellation', () => {
    renderPane({ sessionOverrides: { queuedInputs: [{ requestId: 'sending-1', text: 'sending message', requestedAt: baseTime,
      state: 'submitting', reason: 'Sending the message.' }] } });
    expect(screen.getByText('Sending…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel queued send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it.each(['keyboard', 'Interrupt session'])('%s interrupts without sending or changing a held draft', async control => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Keep this draft local' } });
    if (control === 'keyboard') fireEvent.keyDown(textbox, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: control }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('session-1', { keys: ['Escape'] }));
    expect(textbox).toHaveValue('Keep this draft local');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it.each(['keyboard', 'Interrupt session'])('%s remains available during a pending send', async control => {
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

  it('sends the draft as one complete message from the Send button, and only when there is something to send', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'This is my chat message' } });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('session-1', {
      text: 'This is my chat message', submittedText: 'This is my chat message', keys: ['Enter'],
    }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  });

  it('keeps a Shift+Enter line break in the draft instead of sending', () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'first line' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('first line');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('takes the next message on its own after a send the server queued', async () => {
    const queuedInput = { requestId: 'queued-1', text: 'first message', requestedAt: baseTime,
      state: 'queued' as const, reason: 'Waiting for the session to accept input.' };
    const send = vi.fn(async (): Promise<SessionInputResponse> => ({ session: boundSession(), queuedInput }));
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'first message' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    expect(textbox).toHaveValue('');
    fireEvent.change(textbox, { target: { value: 'second message' } });
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith('session-1', {
      text: 'second message', submittedText: 'second message', keys: ['Enter'],
    });
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

  it('lets the person suspend a working session and leaves the decision to the server', () => {
    const onSuspend = vi.fn().mockResolvedValue(undefined);
    renderPane({ sessionOverrides: { isWorking: true }, onSuspend });
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
    });

    expect(screen.getByText('The preview is ready. For later changes:')).toBeVisible();
    expect(screen.getByText(quotedControl)).toBeVisible();
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
              onSetModelProfile={vi.fn().mockResolvedValue(true)}
              onCancelModelProfileRequest={vi.fn().mockResolvedValue(true)}
              binding={false}
              releasing={false}
              suspending={false}
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

describe('ConversationPane session controls', () => {
  const terminalControls = ['Enter', 'Esc', 'Backspace', 'Tab', '↑', '↓', '←', '→'];

  it('offers no terminal controls, no transport badge and no debug panel', () => {
    renderPane();

    for (const name of terminalControls) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /debug/i })).not.toBeInTheDocument();
    expect(screen.queryByText('app-server')).not.toBeInTheDocument();
    expect(screen.queryByText('headless')).not.toBeInTheDocument();
    expect(screen.getByText('Bound')).toBeVisible();
  });

  it('keeps Send, Stop, the model profile controls, copy, suspend and release', () => {
    renderPane();

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeVisible();
    for (const profile of ['high', 'medium', 'low']) {
      expect(screen.getByRole('button', { name: `Use ${profile} Codex profile` })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: 'Copy latest assistant message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Release' })).toBeVisible();
  });

  it('sends a message with Enter and stops the turn with Stop', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(textbox, { target: { value: 'build the thing' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toBe('session-1');
    expect(send.mock.calls[0]?.[1]).toEqual({ text: 'build the thing', keys: ['Enter'], submittedText: 'build the thing' });

    await waitFor(() => expect(textbox).not.toHaveAttribute('readonly'));
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('session-1', { keys: ['Escape'] }));
  });

  it('edits the draft locally for arrow keys, Tab and Backspace and sends nothing', async () => {
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    renderPane({ onSendKeystrokes: send });
    const textbox = screen.getByRole('textbox', { name: 'Message' });

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace']) {
      fireEvent.keyDown(textbox, { key });
    }
    fireEvent.keyDown(textbox, { key: '/', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(textbox, { target: { value: 'an ordinary draft' } });

    expect(send).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('an ordinary draft');
    fireEvent.change(textbox, { target: { value: '' } });
  });

  it('uploads pasted images and sends them with the message', async () => {
    const upload = vi.spyOn(api, 'uploadImage').mockResolvedValue(pastedImage);
    const send = vi.fn().mockResolvedValue({ session: boundSession() });
    try {
      renderPane({ onSendKeystrokes: send });
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

  it('asks for a first message when the conversation has no transcript yet', () => {
    renderPane();

    expect(screen.getByText('Send a message to start this session.')).toBeVisible();
    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
  });

  it('still shows the session status block when the synthesized status is short', () => {
    renderPane({
      screenStatus: 'Idle',
      screenModel: 'gpt-5.5',
    });

    expect(screen.getByText('Idle')).toBeVisible();
    expect(screen.getByText('gpt-5.5')).toBeVisible();
  });

  it('keeps the queued-message and provider-failure notices', () => {
    renderPane({
      sessionOverrides: {
        queuedInputs: [{ requestId: 'queued-1', text: 'pending message', requestedAt: baseTime,
          state: 'queued', reason: 'Waiting for the session to accept input.' }],
        runFailure: { turnId: 't1', failedAt: baseTime, code: 'server_overloaded', message: 'Selected model is at capacity.',
          attempts: 0, maxAttempts: 3, status: 'scheduled', nextRetryAt: baseTime },
      },
    });

    expect(screen.getByText('pending message')).toBeVisible();
    expect(screen.getByText(/Selected model is at capacity\./)).toBeVisible();
  });
});

describe('ConversationPane agent question card', () => {
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
  const answered = () => vi.spyOn(api, 'answerSessionRequest').mockResolvedValue({ session: boundSession() });

  it('shows the header, question, options, a typed-answer field, Submit and Decline, and leaves the composer usable', () => {
    renderPane({ sessionOverrides: { pendingRequests: [ask()] } });

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
      renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
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
      renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('radio', { name: /Strict/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(answer).toHaveBeenCalledTimes(1);
      pending.resolve({ session: boundSession() });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled());
    } finally { answer.mockRestore(); }
  });

  it('sends a typed answer instead of an option', async () => {
    const answer = answered();
    try {
      renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
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
      renderPane({ sessionOverrides: { pendingRequests: [request] } });
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
      renderPane({ sessionOverrides: { pendingRequests: [request] } });
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
      renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith('session-1', 'q1', { decision: 'decline' }, undefined));
    } finally { answer.mockRestore(); }
  });

  it('says so when the question is no longer waiting, and allows trying again for other failures', async () => {
    const answer = vi.spyOn(api, 'answerSessionRequest')
      .mockRejectedValueOnce(new ApiError('That request is no longer waiting for an answer.', { status: 404 }))
      .mockRejectedValueOnce(new ApiError('Boom', { status: 500 }));
    try {
      renderPane({ sessionOverrides: { pendingRequests: [ask()] } });
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer waiting for an answer'));
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Boom'));
      expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
    } finally { answer.mockRestore(); }
  });

  it('shows one card per open question', () => {
    renderPane({ sessionOverrides: { pendingRequests: [ask(), ask({ requestId: 'q2', questions: [{ id: 'x', question: 'Another?', options: [] }] })] } });
    expect(screen.getAllByRole('region', { name: 'Agent question' })).toHaveLength(2);
  });

  it('shows nothing for a session without questions or for a request that is not a question', () => {
    renderPane();
    expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument();
    renderPane({ sessionOverrides: { pendingRequests: [ask({ kind: 'permission', questions: [] })] } });
    expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument();
  });
});
