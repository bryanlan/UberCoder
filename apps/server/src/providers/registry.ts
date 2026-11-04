import type { ProviderId } from '@agent-console/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GrokProvider } from './grok-provider.js';
import { VibeProvider, type VibeProviderLog } from './vibe-provider.js';
import type { ProviderAdapter, TranscriptParseCache } from './types.js';

export class ProviderRegistry {
  private readonly providers: Record<ProviderId, ProviderAdapter>;

  constructor(parseCache?: TranscriptParseCache, log?: VibeProviderLog) {
    this.providers = {
      codex: new CodexProvider(parseCache),
      claude: new ClaudeProvider(parseCache),
      grok: new GrokProvider(parseCache),
      vibe: new VibeProvider(parseCache, log),
    };
  }

  get(providerId: ProviderId): ProviderAdapter {
    return this.providers[providerId];
  }
}
