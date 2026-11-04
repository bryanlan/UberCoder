import fs from 'node:fs';
import readline from 'node:readline';
import type { AppDatabase } from '../db/database.js';

/**
 * The first message the person sent in a session, read from its event log. An agent's opening prompt is logged as
 * `agent-input`, so a `user-input` line is always the person.
 */
async function firstHumanMessageAt(eventLogPath: string): Promise<string | undefined> {
  if (!fs.existsSync(eventLogPath)) return undefined;
  const lines = readline.createInterface({ input: fs.createReadStream(eventLogPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"user-input"')) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
        if (event.type === 'user-input' && typeof event.timestamp === 'string') return event.timestamp;
      } catch {
        // A damaged line is not a message.
      }
    }
  } finally {
    lines.close();
  }
  return undefined;
}

/**
 * Records, for chats an agent launched before the Console tracked replies, that the person already answered in them.
 * The reply may be in the launched session or in a later session that resumed the same chat, so it reads the event log
 * of each session on the chat until it finds one. A chat with no reply stays agent-driven. Returns how many launch
 * records it marked.
 */
export async function backfillHumanReplies(db: AppDatabase, shouldStop: () => boolean = () => false): Promise<number> {
  const marked = new Set<string>();
  for (const launch of db.boundSessions.list()) {
    if (shouldStop()) break;
    if (!launch.launchContext || launch.launchContext.humanRepliedAt || marked.has(launch.id)) continue;
    for (const session of db.boundSessions.sessionsOfConversation(launch.id)) {
      const repliedAt = session.eventLogPath ? await firstHumanMessageAt(session.eventLogPath) : undefined;
      if (!repliedAt) continue;
      for (const id of db.boundSessions.markHumanReplied(session.id, repliedAt)) marked.add(id);
      break;
    }
  }
  return marked.size;
}
