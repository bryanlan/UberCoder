import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationTimeline, NormalizedMessage, ProjectSummary, SessionKeystrokeRequest } from '@agent-console/shared';
import { ConversationPane } from './ConversationPane';

const baseTime = '2026-07-02T12:00:00.000Z';

beforeAll(() => {
  Element.prototype.scrollTo ??= vi.fn();
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
  messages?: NormalizedMessage[];
  screenContent?: string;
  screenContentAnsi?: string;
  screenStatus?: string;
  screenStatusAnsi?: string;
  sessionOverrides?: Partial<BoundSession>;
} = {}): ConversationTimeline {
  const session = boundSession(input.sessionOverrides);
  return {
    conversation: {
      ref: 'conversation-1',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
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
      status: input.screenStatus ?? 'Session active',
      statusAnsi: input.screenStatusAnsi,
      capturedAt: baseTime,
    },
    messagePage: { hasOlder: false, total: 0 },
  };
}

function renderPane(input: {
  inputText?: string;
  screenContent?: string;
  screenContentAnsi?: string;
  screenStatus?: string;
  screenStatusAnsi?: string;
  onSendKeystrokes?: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  onSetCodexProfile?: (sessionId: string, profile: 'high' | 'medium' | 'low') => Promise<boolean>;
  onLocalSubmittedText?: (sessionId: string, text: string) => { id: string } | undefined;
  sessionOverrides?: Partial<BoundSession>;
} = {}) {
  const onSendKeystrokes = input.onSendKeystrokes ?? vi.fn().mockResolvedValue(true);
  const onSetCodexProfile = input.onSetCodexProfile ?? vi.fn().mockResolvedValue(true);
  const onLocalSubmittedText = input.onLocalSubmittedText ?? vi.fn(() => ({ id: 'optimistic-1' }));
  const view = render(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({
          inputText: input.inputText,
          screenContent: input.screenContent,
          screenContentAnsi: input.screenContentAnsi,
          screenStatus: input.screenStatus,
          screenStatusAnsi: input.screenStatusAnsi,
          sessionOverrides: input.sessionOverrides,
        })}
        liveMode
        loading={false}
        workMode={false}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        mobileControlsHidden={false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSendKeystrokes={onSendKeystrokes}
        onSetCodexProfile={onSetCodexProfile}
        onLocalSubmittedText={onLocalSubmittedText}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
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
  return { ...view, onSendKeystrokes, onSetCodexProfile, onLocalSubmittedText };
}

it('Alt H selects the high Codex profile without changing the draft', async () => {
  const onSetCodexProfile = vi.fn().mockResolvedValue(true);
  renderPane({ onSetCodexProfile });
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'keep this draft' } });

  fireEvent.keyDown(textbox, { key: 'h', altKey: true });

  await waitFor(() => expect(onSetCodexProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(textbox).toHaveValue('keep this draft');
});

it('does not apply a queued profile to a different conversation', async () => {
  const onSetCodexProfile = vi.fn().mockResolvedValue(true);
  const view = renderPane({
    onSetCodexProfile,
    sessionOverrides: { id: 'session-1', isWorking: true },
  });

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'h', altKey: true });
  expect(screen.getByText(/High queued/)).toBeInTheDocument();

  view.rerender(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({ sessionOverrides: { id: 'session-2', isWorking: false } })}
        liveMode
        loading={false}
        workMode={false}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        mobileControlsHidden={false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue(true)}
        onSetCodexProfile={onSetCodexProfile}
        onLocalSubmittedText={vi.fn(() => ({ id: 'optimistic-2' }))}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
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
  expect(onSetCodexProfile).not.toHaveBeenCalled();
});

it('applies a queued profile when the current turn becomes idle', async () => {
  const onSetCodexProfile = vi.fn().mockResolvedValue(true);
  const view = renderPane({
    onSetCodexProfile,
    sessionOverrides: { id: 'session-1', isWorking: true },
  });

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'h', altKey: true });
  expect(screen.getByText(/High queued/)).toBeInTheDocument();

  view.rerender(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({ sessionOverrides: { id: 'session-1', isWorking: false } })}
        liveMode
        loading={false}
        workMode={false}
        mobileChromeHidden={false}
        onToggleMobileChrome={vi.fn()}
        mobileControlsHidden={false}
        onToggleMobileControls={vi.fn()}
        onBind={vi.fn()}
        onRelease={vi.fn()}
        onSendKeystrokes={vi.fn().mockResolvedValue(true)}
        onSetCodexProfile={onSetCodexProfile}
        onLocalSubmittedText={vi.fn(() => ({ id: 'optimistic-2' }))}
        onDiscardLocalSubmittedText={vi.fn()}
        binding={false}
        releasing={false}
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

  await waitFor(() => expect(onSetCodexProfile).toHaveBeenCalledWith('session-1', 'high'));
  expect(screen.getByText(/High selected/)).toBeInTheDocument();
});

describe('ConversationPane live input bridge', () => {
  it('clears the normal draft immediately after Enter while the keystroke request is pending', () => {
    const send = deferred<boolean>();
    renderPane({
      onSendKeystrokes: vi.fn(() => send.promise),
    });
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textbox, { target: { value: 'recap where we left things' } });
    expect(textbox.value).toBe('recap where we left things');

    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(textbox.value).toBe('');
    send.resolve(true);
  });

  it('clears the text-bypass preview immediately after local submission even when terminal input still contains that text', async () => {
    const send = deferred<boolean>();
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
          loading={false}
          workMode={false}
          mobileChromeHidden={false}
          onToggleMobileChrome={vi.fn()}
          mobileControlsHidden={false}
          onToggleMobileControls={vi.fn()}
          onBind={vi.fn()}
          onRelease={vi.fn()}
          onSendKeystrokes={vi.fn(() => send.promise)}
          onSetCodexProfile={vi.fn().mockResolvedValue(true)}
          onLocalSubmittedText={onLocalSubmittedText}
          onDiscardLocalSubmittedText={vi.fn()}
          binding={false}
          releasing={false}
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
    send.resolve(true);
  });

  it('does not promote server-derived input text into a pending user transcript row', () => {
    renderPane({ inputText: '/model' });

    expect(screen.getByText('Waiting for session output…')).toBeInTheDocument();
    expect(screen.queryByText('/model')).not.toBeInTheDocument();
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

    fireEvent.keyDown(textbox, { key: '/' });
    fireEvent.keyDown(textbox, { key: 'm' });
    fireEvent.keyDown(textbox, { key: 'o' });
    fireEvent.keyDown(textbox, { key: 'd' });
    fireEvent.keyDown(textbox, { key: 'e' });
    fireEvent.keyDown(textbox, { key: 'l' });

    expect(screen.queryByText('Waiting for session output…')).not.toBeInTheDocument();
    expect(screen.getAllByText('/model').length).toBeGreaterThan(0);
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
            loading={false}
            workMode={false}
            mobileChromeHidden={false}
            onToggleMobileChrome={vi.fn()}
            mobileControlsHidden={false}
            onToggleMobileControls={vi.fn()}
            onBind={onBind}
            onRelease={vi.fn()}
            onSendKeystrokes={vi.fn().mockResolvedValue(true)}
            onSetCodexProfile={vi.fn().mockResolvedValue(true)}
            onLocalSubmittedText={vi.fn()}
            onDiscardLocalSubmittedText={vi.fn()}
            binding={false}
            releasing={false}
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
