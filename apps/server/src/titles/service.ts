import { randomUUID } from 'node:crypto';
import type { ConversationSummary, SessionEvent } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { RealtimeEventBus } from '../realtime/event-bus.js';
import { isCoordinationWakePrompt } from '../coordination/wake.js';
import { saveConversationTitle } from '../lib/conversation-title.js';
import type { TitleRunner } from '../workers/runtime.js';

/**
 * A chat created in the Console starts in this state. Its first human message moves it to
 * pending, then ready, failed or skipped (a chosen title already existed). Each chat gets
 * at most one model call.
 */
export const TITLE_GENERATION_AWAITING_MESSAGE = 'awaiting_message';
type TitleGenerationState = 'pending' | 'ready' | 'failed' | 'skipped';
type UserInputEvent = Extract<SessionEvent, { type: 'session.user-input' }>;

function currentConversationRef(pending: ConversationSummary): string {
  return typeof pending.rawMetadata?.adoptedConversationRef === 'string' ? pending.rawMetadata.adoptedConversationRef : pending.ref;
}

export class ConversationTitleService {
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly db: AppDatabase,
    private readonly eventBus: RealtimeEventBus,
    private readonly runner: TitleRunner,
    onError: (error: unknown) => void,
  ) {
    this.unsubscribe = eventBus.subscribe((event) => {
      if (event.type !== 'session.user-input') return;
      // One model call at a time, outside the session manager's input path.
      this.queue = this.queue.then(() => this.handle(event)).catch(onError);
    });
  }

  settled(): Promise<void> {
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.runner.stop();
    await this.queue;
  }

  private async handle(event: UserInputEvent): Promise<void> {
    const message = event.text.trim();
    // Slash commands and numbered picker choices are provider controls, not the chat's request.
    if (this.stopped || !message || message.startsWith('/') || /^\d{1,8}$/.test(message) || isCoordinationWakePrompt(message)) return;
    const pending = event.conversationRef.startsWith('pending:')
      ? this.db.pendingConversations.get(event.conversationRef)
      : this.db.pendingConversations.getByAdoptedRef(event.projectSlug, event.provider, event.conversationRef);
    if (pending?.rawMetadata?.titleGeneration !== TITLE_GENERATION_AWAITING_MESSAGE) return;
    if (this.db.titleOverrides.get(event.projectSlug, event.provider, currentConversationRef(pending))) {
      this.db.pendingConversations.setTitleGeneration(pending.ref, 'skipped');
      return;
    }
    // Reserve durably before launch: an interrupted or failed call is never retried automatically.
    this.db.pendingConversations.setTitleGeneration(pending.ref, 'pending');
    let state: TitleGenerationState = 'failed';
    try {
      const { title } = await this.runner.title(message, randomUUID());
      // The chat may have been adopted under its native ref during the call.
      const current = this.db.pendingConversations.get(pending.ref);
      if (title && current) {
        state = saveConversationTitle(this.db, this.eventBus, { projectSlug: event.projectSlug, provider: event.provider,
          conversationRef: currentConversationRef(current), title, onlyIfUntitled: true }) ? 'ready' : 'skipped';
      }
    } finally {
      this.db.pendingConversations.setTitleGeneration(pending.ref, state);
    }
    if (state === 'failed') throw new Error(`No conversation title was generated for ${pending.ref}.`);
  }
}
