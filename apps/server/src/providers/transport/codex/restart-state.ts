// What a Codex backend leaves behind for the next one. The shared app-server runs behind a session host and outlives a Console
// backend restart, and so does everything it is waiting for: a turn that is still running, a question that is waiting for a
// person (the server holds the JSON-RPC request open until somebody answers it by id). The new backend can find the process again,
// but it knows none of that, so the old one writes it down in the Console database (`PluginContext.meta`):
//   - the question requests it holds open (id, thread, params), so the new backend can show them and answer them by id;
//   - the turn each thread is running, so a turn that ended while no backend listened can still be reported once;
//   - the command each thread's turns started (process and turn), so Stop after a restart ends the adopted turn's commands and not
//     the background terminals that earlier turns left running on purpose;
//   - how far into the host's replay buffer it had read, so the new backend knows which lines it has not seen.
// All of it belongs to one app-server process. When the process ends, or a new one starts, `reset()` forgets it.

import type { PluginContext } from '../types.js';

const QUESTIONS_KEY = 'structured-codex-requests';
const TURNS_KEY = 'structured-codex-turns';
const CURSOR_KEY = 'structured-codex-cursor';
const COMMANDS_KEY = 'structured-codex-commands';

/** A server request held open for the person. `id` is the JSON-RPC id, in the type the server used. */
export interface HeldQuestionRecord {
  id: string | number;
  threadId: string;
  turnId?: string;
  params: unknown;
}

/** A command a turn started: the process it runs as and the turn that started it. */
export interface CommandRecord {
  processId: string;
  turnId: string;
}

/** The newest host line the backend had handled, and which process it belongs to (the cursor means nothing for another one). */
export interface HostCursor {
  seq: number;
  pid?: number;
  startTicks?: string;
}

function parse<T>(stored: string | undefined, fallback: T): T {
  if (!stored) return fallback;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function isQuestionRecord(value: unknown): value is HeldQuestionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<HeldQuestionRecord>;
  return (typeof record.id === 'string' || typeof record.id === 'number') && typeof record.threadId === 'string';
}

function isCommandRecord(value: unknown): value is CommandRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<CommandRecord>;
  return typeof record.processId === 'string' && typeof record.turnId === 'string';
}

export class CodexRestartState {
  constructor(private readonly meta: PluginContext['meta']) {}

  // ---- held questions --------------------------------------------------------------------------------

  questions(): HeldQuestionRecord[] {
    const stored = parse<unknown>(this.meta.get(QUESTIONS_KEY), []);
    return Array.isArray(stored) ? stored.filter(isQuestionRecord) : [];
  }

  questionsForThread(threadId: string): HeldQuestionRecord[] {
    return this.questions().filter((record) => record.threadId === threadId);
  }

  hasQuestion(requestId: string): boolean {
    return this.questions().some((record) => String(record.id) === requestId);
  }

  saveQuestion(record: HeldQuestionRecord): void {
    const others = this.questions().filter((existing) => String(existing.id) !== String(record.id));
    this.writeQuestions([...others, record]);
  }

  removeQuestion(requestId: string): void {
    const all = this.questions();
    const kept = all.filter((record) => String(record.id) !== requestId);
    if (kept.length !== all.length) this.writeQuestions(kept);
  }

  removeThreadQuestions(threadId: string): void {
    const all = this.questions();
    const kept = all.filter((record) => record.threadId !== threadId);
    if (kept.length !== all.length) this.writeQuestions(kept);
  }

  private writeQuestions(records: HeldQuestionRecord[]): void {
    if (records.length > 0) this.meta.set(QUESTIONS_KEY, JSON.stringify(records));
    else this.meta.delete(QUESTIONS_KEY);
  }

  // ---- running turns ---------------------------------------------------------------------------------

  /** The turn this thread was running when the last backend looked, if it had not ended. */
  trackedTurn(threadId: string): string | undefined {
    return this.turns()[threadId];
  }

  noteTurn(threadId: string, turnId: string | undefined): void {
    const turns = this.turns();
    if (turnId === undefined) {
      if (!(threadId in turns)) return;
      delete turns[threadId];
    } else {
      if (turns[threadId] === turnId) return;
      turns[threadId] = turnId;
    }
    if (Object.keys(turns).length > 0) this.meta.set(TURNS_KEY, JSON.stringify(turns));
    else this.meta.delete(TURNS_KEY);
  }

  private turns(): Record<string, string> {
    const stored = parse<unknown>(this.meta.get(TURNS_KEY), {});
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

  // ---- commands --------------------------------------------------------------------------------------

  /** The commands the backends that were attached saw start on this thread and that have not ended, by item id. */
  commands(threadId: string): Record<string, CommandRecord> {
    return this.allCommands()[threadId] ?? {};
  }

  noteCommand(threadId: string, itemId: string, record: CommandRecord): void {
    const all = this.allCommands();
    const existing = all[threadId]?.[itemId];
    if (existing?.processId === record.processId && existing.turnId === record.turnId) return;
    all[threadId] = { ...all[threadId], [itemId]: record };
    this.writeCommands(all);
  }

  forgetCommand(threadId: string, itemId: string): void {
    const all = this.allCommands();
    const forThread = all[threadId];
    if (!forThread || !(itemId in forThread)) return;
    delete forThread[itemId];
    if (Object.keys(forThread).length === 0) delete all[threadId];
    this.writeCommands(all);
  }

  /**
   * The conversation was released, or the server closed the thread and its terminals ended with it. Not for an unload: Codex keeps
   * the thread and its terminals for about 30 minutes after the last subscriber leaves, and a later backend still needs who owns them.
   */
  dropThreadCommands(threadId: string): void {
    const all = this.allCommands();
    if (!(threadId in all)) return;
    delete all[threadId];
    this.writeCommands(all);
  }

  private allCommands(): Record<string, Record<string, CommandRecord>> {
    const stored = parse<unknown>(this.meta.get(COMMANDS_KEY), {});
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const all: Record<string, Record<string, CommandRecord>> = {};
    for (const [threadId, commands] of Object.entries(stored)) {
      if (typeof commands !== 'object' || commands === null || Array.isArray(commands)) continue;
      const valid = Object.entries(commands as Record<string, unknown>).filter((entry): entry is [string, CommandRecord] => isCommandRecord(entry[1]));
      if (valid.length > 0) all[threadId] = Object.fromEntries(valid);
    }
    return all;
  }

  private writeCommands(all: Record<string, Record<string, CommandRecord>>): void {
    if (Object.keys(all).length > 0) this.meta.set(COMMANDS_KEY, JSON.stringify(all));
    else this.meta.delete(COMMANDS_KEY);
  }

  // ---- host cursor -----------------------------------------------------------------------------------

  cursor(): HostCursor | undefined {
    const stored = parse<Partial<HostCursor> | undefined>(this.meta.get(CURSOR_KEY), undefined);
    if (!stored || typeof stored.seq !== 'number' || !Number.isInteger(stored.seq) || stored.seq < 0) return undefined;
    return {
      seq: stored.seq,
      ...(typeof stored.pid === 'number' ? { pid: stored.pid } : {}),
      ...(typeof stored.startTicks === 'string' ? { startTicks: stored.startTicks } : {}),
    };
  }

  saveCursor(cursor: HostCursor): void {
    this.meta.set(CURSOR_KEY, JSON.stringify(cursor));
  }

  // ---- the process is gone ---------------------------------------------------------------------------

  /** The app-server process ended or a new one replaced it: nothing recorded about the old one is true any more. */
  reset(): void {
    this.meta.delete(QUESTIONS_KEY);
    this.meta.delete(TURNS_KEY);
    this.meta.delete(COMMANDS_KEY);
    this.meta.delete(CURSOR_KEY);
  }
}
