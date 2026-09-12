export async function readServerInstance(url: string, timeoutMs = 2000): Promise<string> {
  const response = await fetch(new URL('/api/health', url), {
    credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Console is not available yet.');
  const health = await response.json();
  if (health.ok !== true || typeof health.instanceId !== 'string' || !health.instanceId) {
    throw new Error('Console did not return a valid readiness response.');
  }
  return health.instanceId;
}

export async function waitForServerRestart(url: string, previousInstance: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const instance = await readServerInstance(url, Math.max(1, Math.min(2000, deadline - Date.now())));
      if (instance !== previousInstance) return;
    } catch { /* Connection errors and unsuccessful health checks are expected during restart. */ }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))));
  }
  throw new Error('Console did not become available after restarting. Check the server and refresh this page.');
}
