import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, useParams } from 'react-router-dom';
import { ConsoleRoutes } from './App';
import { selectConsoleRoute, type ConsoleRouteKind } from './features/navigation/route-selection';

function RouteProbe({ kind }: { kind: ConsoleRouteKind }) {
  const selection = selectConsoleRoute(kind, useParams());
  return (
    <div>
      <div data-testid="kind">{selection.kind}</div>
      <div data-testid="project">{selection.selectedProjectSlug ?? ''}</div>
      <div data-testid="provider">{selection.selectedProvider ?? ''}</div>
      <div data-testid="conversation">{selection.selectedConversationRef ?? ''}</div>
      <div data-testid="console">{String(selection.isConsoleRoute)}</div>
    </div>
  );
}

function renderRoute(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ConsoleRoutes Shell={RouteProbe} />
    </MemoryRouter>,
  );
}

describe('ConsoleRoutes', () => {
  it('routes encoded deep conversation links through selected params', () => {
    renderRoute('/projects/demo%20project/codex/pending%3Aone');

    expect(screen.getByTestId('kind')).toHaveTextContent('conversation');
    expect(screen.getByTestId('project')).toHaveTextContent('demo project');
    expect(screen.getByTestId('provider')).toHaveTextContent('codex');
    expect(screen.getByTestId('conversation')).toHaveTextContent('pending:one');
    expect(screen.getByTestId('console')).toHaveTextContent('true');
  });

  it('marks invalid providers as not found', () => {
    renderRoute('/projects/demo/bogus');

    expect(screen.getByTestId('kind')).toHaveTextContent('not-found');
    expect(screen.getByTestId('console')).toHaveTextContent('false');
  });

  it('routes unmatched paths to the not-found pane state', () => {
    renderRoute('/missing/page');

    expect(screen.getByTestId('kind')).toHaveTextContent('not-found');
    expect(screen.getByTestId('console')).toHaveTextContent('false');
  });
});
