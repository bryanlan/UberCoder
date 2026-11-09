import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { observeSqlite, type OperationObserver } from '../runtime/slow-operations.js';
import { migrateDatabase } from './schema.js';
import { AuthSessionsRepo } from './repos/auth-sessions.js';
import { BoundSessionsRepo } from './repos/bound-sessions.js';
import { ConversationIndexRepo, pickPreferredConversation } from './repos/conversation-index.js';
import { MetaRepo } from './repos/meta.js';
import { PendingConversationsRepo } from './repos/pending-conversations.js';
import { SearchIndexRepo } from './repos/search-index.js';
import { TypedInputRecordsRepo } from './repos/typed-input-records.js';
import { TitleOverridesRepo } from './repos/title-overrides.js';
import { TranscriptParseCacheRepo } from './repos/transcript-parse-cache.js';
import { UiPreferencesRepo } from './repos/ui-preferences.js';

export { pickPreferredConversation };
export type { ConversationSearchIndexChunk, ConversationSearchStateRow } from './repos/search-index.js';

export class AppDatabase {
  readonly sqlite: Database.Database;
  readonly meta: MetaRepo;
  readonly conversationIndex: ConversationIndexRepo;
  readonly searchIndex: SearchIndexRepo;
  readonly titleOverrides: TitleOverridesRepo;
  readonly pendingConversations: PendingConversationsRepo;
  readonly boundSessions: BoundSessionsRepo;
  readonly authSessions: AuthSessionsRepo;
  readonly uiPreferences: UiPreferencesRepo;
  readonly transcriptParseCache: TranscriptParseCacheRepo;
  readonly typedInputRecords: TypedInputRecordsRepo;

  constructor(databasePath: string, observe?: OperationObserver) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.sqlite = new Database(databasePath);
    if (observe) observeSqlite(this.sqlite, 'main', observe);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('cache_size = -65536');
    migrateDatabase(this.sqlite);

    this.meta = new MetaRepo(this.sqlite);
    this.conversationIndex = new ConversationIndexRepo(this.sqlite);
    this.searchIndex = new SearchIndexRepo(this.sqlite);
    this.titleOverrides = new TitleOverridesRepo(this.sqlite);
    this.pendingConversations = new PendingConversationsRepo(this.sqlite);
    this.boundSessions = new BoundSessionsRepo(this.sqlite);
    this.authSessions = new AuthSessionsRepo(this.sqlite);
    this.uiPreferences = new UiPreferencesRepo(this.sqlite);
    this.transcriptParseCache = new TranscriptParseCacheRepo(this.sqlite);
    this.typedInputRecords = new TypedInputRecordsRepo(this.sqlite);
  }

  close(): void {
    void this.searchIndex.close();
    this.sqlite.close();
  }

  isOpen(): boolean {
    return this.sqlite.open;
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
}
