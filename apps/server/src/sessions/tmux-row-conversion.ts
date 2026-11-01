import { spawnSync } from 'node:child_process';

/**
 * Ends the hidden tmux session of a conversation that an earlier build ran on the tmux transport, so its provider process cannot
 * keep writing to the conversation once the row moves to the structured transport (see `SessionManager`'s startup conversion).
 * Best effort: tmux may not be installed, its server or the session may be gone, and every failure is ignored. The socket is the
 * one that build used: `AGENT_CONSOLE_TMUX_SOCKET`, or `agent-console`.
 */
export function endTmuxSession(sessionName: string): void {
  const socket = process.env.AGENT_CONSOLE_TMUX_SOCKET ?? 'agent-console';
  spawnSync('tmux', [...(socket ? ['-L', socket] : []), 'kill-session', '-t', sessionName], { stdio: 'ignore', timeout: 5_000 });
}
