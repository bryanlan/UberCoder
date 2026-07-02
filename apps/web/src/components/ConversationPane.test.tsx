import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationTimeline, ProjectSummary, SessionKeystrokeRequest } from '@agent-console/shared';
import { ConversationPane } from './ConversationPane';

const baseTime = '2026-07-02T12:00:00.000Z';

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

function timeline(input: { inputText?: string } = {}): ConversationTimeline {
  const session = boundSession();
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
    messages: [],
    boundSession: session,
    liveScreen: {
      content: '',
      inputText: input.inputText ?? '',
      status: 'Session active',
      capturedAt: baseTime,
    },
    messagePage: { hasOlder: false, total: 0 },
  };
}

function renderPane(input: {
  inputText?: string;
  onSendKeystrokes?: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  onLocalSubmittedText?: (sessionId: string, text: string) => { id: string } | undefined;
} = {}) {
  const onSendKeystrokes = input.onSendKeystrokes ?? vi.fn().mockResolvedValue(true);
  const onLocalSubmittedText = input.onLocalSubmittedText ?? vi.fn(() => ({ id: 'optimistic-1' }));
  const view = render(
    <MemoryRouter>
      <ConversationPane
        projects={[project()]}
        project={project()}
        selectedProvider="codex"
        timeline={timeline({ inputText: input.inputText })}
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
  return { ...view, onSendKeystrokes, onLocalSubmittedText };
}

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
});
