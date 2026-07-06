import { buildApp } from './app.js';

const SHUTDOWN_FORCE_EXIT_MS = 8_000;
const { app, config } = await buildApp();
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down Agent Console.');
  const forceExitTimer = setTimeout(() => {
    app.log.error({ signal, timeoutMs: SHUTDOWN_FORCE_EXIT_MS }, 'Forcing Agent Console shutdown after timeout.');
    process.exit(1);
  }, SHUTDOWN_FORCE_EXIT_MS);
  forceExitTimer.unref();
  try {
    app.server.closeIdleConnections?.();
    app.server.closeAllConnections?.();
    await app.close();
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    app.log.error({ err: error, signal }, 'Failed to shut down Agent Console cleanly.');
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

const address = await app.listen({
  host: config.server.host,
  port: config.server.port,
});
app.log.info(`Agent Console listening at ${address}`);
