import { Bot, Sparkles, Wind, Zap, type LucideIcon } from 'lucide-react';
import type { ProviderId } from '@agent-console/shared';

/** The icon each provider wears in the sidebar and on the project pages. */
export const PROVIDER_ICONS: Record<ProviderId, LucideIcon> = { codex: Sparkles, claude: Bot, grok: Zap, vibe: Wind };
