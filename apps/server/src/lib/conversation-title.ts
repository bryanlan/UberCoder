import type { ProviderId } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { RealtimeEventBus } from '../realtime/event-bus.js';
import { nowIso } from './time.js';

/**
 * Saves a chosen conversation title wherever the Console displays it. With onlyIfUntitled,
 * an existing chosen title (a rename or launch title) wins and nothing changes.
 */
export function saveConversationTitle(db: AppDatabase, eventBus: RealtimeEventBus, input: {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  title: string;
  onlyIfUntitled?: boolean;
}): boolean {
  const { projectSlug, provider, conversationRef, title } = input;
  const updatedAt = nowIso();
  const saved = db.transaction(() => {
    if (input.onlyIfUntitled && db.titleOverrides.get(projectSlug, provider, conversationRef)) return false;
    db.titleOverrides.set(projectSlug, provider, conversationRef, title, updatedAt);
    db.searchIndex.updateTitle(projectSlug, provider, conversationRef, title);
    const boundSession = db.boundSessions.getRestorableByConversation(projectSlug, provider, conversationRef);
    if (boundSession) db.boundSessions.upsert({ ...boundSession, title, updatedAt });
    return true;
  });
  if (saved) eventBus.emit({ type: 'conversation.index-updated', projectSlug, provider, conversationRef, timestamp: updatedAt });
  return saved;
}
