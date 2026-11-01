import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Every server test that reaches the model catalog runs against a stand-in `wo` script, never the real command or the real router.
export default defineConfig({
  test: {
    env: { AGENT_CONSOLE_WO_PATH: fileURLToPath(new URL('./test/helpers/fake-wo.mjs', import.meta.url)) },
  },
});
