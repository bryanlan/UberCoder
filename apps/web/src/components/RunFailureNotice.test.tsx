import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunFailure } from '@agent-console/shared';
import { RunFailureNotice } from './RunFailureNotice';

afterEach(cleanup);
const failure: RunFailure = { turnId: 't1', failedAt: '2026-09-14T15:04:01Z', code: 'server_overloaded', message: 'Selected model is at capacity.', attempts: 0, maxAttempts: 3, status: 'scheduled', nextRetryAt: '2026-09-14T15:04:16Z' };
describe('Run failure notice', () => {
  it('shows the actual failure, bounded retry and an explicit stop action', () => {
    const stop = vi.fn(); render(<RunFailureNotice failure={failure} onStop={stop} />);
    expect(screen.getByRole('status').textContent).toContain('Selected model is at capacity.');
    expect(screen.getByRole('status').textContent).toContain('Retry 1 of 3');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop automatic recovery' })); expect(stop).toHaveBeenCalledOnce();
  });
  it('reports a first uncertain outcome without raising the repeated-failure alert', () => {
    render(<RunFailureNotice failure={{ ...failure, status: 'stopped', attempts: 1, stoppedReason: 'Retry delivery is uncertain.' }} onStop={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('uncertain');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('explains exhausted or cancelled recovery without offering an automatic retry', () => {
    render(<RunFailureNotice failure={{ ...failure, status: 'stopped', attempts: 3, stoppedReason: 'The automatic retry limit was reached.' }} onStop={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('retry limit was reached');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
