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
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      this.pending = false;
      return;
    }

    try {
      await this.closeApp();
    } finally {
      process.exit(0);
    }
  }
}
