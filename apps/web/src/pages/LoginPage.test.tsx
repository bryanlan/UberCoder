import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

describe('LoginPage', () => {
  it('submits a trimmed password through the login form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);

    render(<LoginPage onSubmit={onSubmit} loading={false} tailscaleEnabled={false} />);

    await user.type(screen.getByLabelText(/password/i), '  local-secret  ');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(onSubmit).toHaveBeenCalledWith('local-secret');
  });
});
