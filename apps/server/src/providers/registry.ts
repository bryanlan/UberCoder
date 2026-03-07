import type { ProviderId } from '@agent-console/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import type { ProviderAdapter } from './types.js';

export class ProviderRegistry {
  private readonly providers: Record<ProviderId, ProviderAdapter> = {
    codex: new CodexProvider(),
    claude: new ClaudeProvider(),
  };

  get(providerId: ProviderId): ProviderAdapter {
    return this.providers[providerId];
  }
}
