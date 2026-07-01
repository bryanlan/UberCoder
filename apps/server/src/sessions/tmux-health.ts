import { sleep } from '../lib/async.js';
import type { TmuxClient } from './tmux-client.js';

export type TmuxLiveness = 'alive' | 'dead' | 'unknown';

export async function checkTmuxLiveness(
  tmuxClient: Pick<TmuxClient, 'hasSession'>,
  sessionName: string,
  options: { retryDelayMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<TmuxLiveness> {
  const retryDelayMs = options.retryDelayMs ?? 250;
  const sleepFn = options.sleepFn ?? sleep;

  let firstAlive: boolean;
  try {
    firstAlive = await tmuxClient.hasSession(sessionName);
  } catch {
    return 'unknown';
  }
  if (firstAlive) {
    return 'alive';
  }

  await sleepFn(retryDelayMs);

  try {
    return await tmuxClient.hasSession(sessionName) ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}
