import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';

describe('AppDatabase', () => {
  it('deduplicates repeated conversation refs during index replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.replaceConversationIndex('demo', 'claude', [
      {
        ref: 'dup-ref',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'claude',
        title: 'Older transcript',
        updatedAt: '2026-03-07T00:00:00.000Z',
        isBound: false,
        degraded: false,
      },
      {
        ref: 'dup-ref',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'claude',
        title: 'Newer transcript',
        updatedAt: '2026-03-07T01:00:00.000Z',
        isBound: false,
        degraded: false,
      },
    ]);

    const conversations = db.listConversationIndex();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe('Newer transcript');
    db.close();
  });
});
