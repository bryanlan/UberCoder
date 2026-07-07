import type { ProviderId } from '@agent-console/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import type { ProviderAdapter, TranscriptParseCache } from './types.js';

export class ProviderRegistry {
  private readonly providers: Record<ProviderId, ProviderAdapter>;

  constructor(parseCache?: TranscriptParseCache) {
    this.providers = {
      codex: new CodexProvider(parseCache),
      claude: new ClaudeProvider(parseCache),
    };
  }

  get(providerId: ProviderId): ProviderAdapter {
    return this.providers[providerId];
  }
}
