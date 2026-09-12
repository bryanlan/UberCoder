import { spawn } from 'node:child_process';

export class RestartService {
  private pending = false;

  constructor(private readonly closeApp: () => Promise<void>) {}

  scheduleRestart(): boolean {
    if (this.pending) return false;
    this.pending = true;

    setTimeout(() => {
      void this.restart();
    }, 150);

    return true;
  }

  private async restart(): Promise<void> {
    try {
      await this.closeApp();
      // The installed unit uses Restart=always. Only its main process delegates
      // replacement to systemd; a child inheriting the environment does not.
      if (process.env.SYSTEMD_EXEC_PID !== String(process.pid)) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      }
      process.exit(0);
    } catch (error) {
      console.error('Agent Console restart failed:', error);
      process.exit(1);
    }
  }
}
