import { describe, expect, it } from 'vitest';
import { selectConsoleRoute } from './route-selection';

describe('console route selection', () => {
  it('selects decoded conversation params from the route table', () => {
    expect(selectConsoleRoute('conversation', {
      projectSlug: 'demo-project',
      provider: 'codex',
      conversationRef: 'pending%3Aone',
    })).toMatchObject({
      kind: 'conversation',
      selectedProjectSlug: 'demo-project',
      selectedProvider: 'codex',
      selectedConversationRef: 'pending:one',
      conversationRouteActive: true,
      isConsoleRoute: true,
    });
  });

  it('rejects invalid providers as not found', () => {
    expect(selectConsoleRoute('provider', {
      projectSlug: 'demo-project',
      provider: 'bogus',
    })).toMatchObject({
      kind: 'not-found',
      isConsoleRoute: false,
    });
  });

  it('keeps settings and login outside console selection', () => {
    expect(selectConsoleRoute('settings')).toMatchObject({ inSettings: true, isConsoleRoute: false });
    expect(selectConsoleRoute('login')).toMatchObject({ isLogin: true, isConsoleRoute: false });
  });
});
