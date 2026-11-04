// Vibe's unified session store, as Mistral Vibe 3.0.4 writes it under `<VIBE_HOME>/logs/session/unified/<session id>/`.
// CURRENT names the generation. The projection history lives in content-addressed chunks. An unknown major format is
// refused: a reader must not guess a conversation out of a store it does not understand.

import fs from 'node:fs';
import path from 'node:path';

export const VIBE_STORE_FORMAT = 'mistral.vibe.unified-session-store/v1';
/** The minor this Console was checked against. Newer minors are read only when the pointer and manifest still have the fields below. */
export const VIBE_STORE_MINOR = 10;

export class VibeStoreFormatError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'VibeStoreFormatError';
  }
}

export interface VibePointer {
  sessionId: string;
  generation: string;
  snapshotSequence: number;
  minor: number;
}

export interface VibeHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  turnId?: string;
}

export interface VibeHistory {
  cwd?: string;
  title?: string;
  model?: string;
  messages: VibeHistoryMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requiredPointer(value: unknown): VibePointer {
  if (!isRecord(value)) throw new VibeStoreFormatError('CURRENT is not an object.');
  if (value.store_format !== VIBE_STORE_FORMAT) {
    const format = typeof value.store_format === 'string' ? value.store_format : 'missing';
    throw new VibeStoreFormatError(`Unknown Vibe store format ${format}.`);
  }
  const minor = value.store_format_minor;
  if (typeof minor !== 'number' || !Number.isInteger(minor) || minor < 1) {
    throw new VibeStoreFormatError('CURRENT has no store_format_minor.');
  }
  if (minor < VIBE_STORE_MINOR) {
    throw new VibeStoreFormatError(`Vibe store minor ${minor} is older than the supported minor ${VIBE_STORE_MINOR}.`);
  }
  const sessionId = value.session_id;
  const generation = value.generation;
  const snapshotSequence = value.snapshot_sequence;
  if (typeof sessionId !== 'string' || !sessionId || typeof generation !== 'string' || !generation) {
    throw new VibeStoreFormatError('CURRENT is missing session_id or generation.');
  }
  if (typeof snapshotSequence !== 'number' || !Number.isInteger(snapshotSequence) || snapshotSequence < 0) {
    throw new VibeStoreFormatError('CURRENT is missing snapshot_sequence.');
  }
  // A newer minor is acceptable only while these fields still describe the store. Anything else was already refused.
  return { sessionId, generation, snapshotSequence, minor };
}

/** The CURRENT pointer, or a reason the store cannot be trusted. Never guesses. */
export function readVibePointer(sessionDir: string): { ok: true; pointer: VibePointer } | { ok: false; reason: string } {
  try {
    return { ok: true, pointer: requiredPointer(readJson(path.join(sessionDir, 'CURRENT'))) };
  } catch (error) {
    if (error instanceof VibeStoreFormatError) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'CURRENT could not be read.' };
  }
}

function executionState(sessionDir: string, generation: string): 'quiescent' | 'recoverable' | undefined {
  try {
    const manifest = readJson(path.join(sessionDir, 'generations', generation, 'manifest.json'));
    if (!isRecord(manifest)) return undefined;
    return manifest.execution_state === 'quiescent' || manifest.execution_state === 'recoverable' ? manifest.execution_state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the store shows that the turn recorded at `baseline` has finished.
 * A finished turn changed the generation name (ordinary compaction) or the snapshot sequence (a projection rollover)
 * and the new manifest is quiescent. An unchanged pointer, a recoverable generation, or a store that cannot be read
 * does not end the turn.
 */
export function vibeTurnSettled(
  sessionDir: string,
  baseline: { generation: string; snapshotSequence: number },
): 'finished' | 'open' | 'unknown' {
  const current = readVibePointer(sessionDir);
  if (!current.ok || !baseline.generation) return 'unknown';
  const state = executionState(sessionDir, current.pointer.generation);
  if (!state) return 'unknown';
  const advanced = current.pointer.generation !== baseline.generation || current.pointer.snapshotSequence > baseline.snapshotSequence;
  if (!advanced) return 'open';
  return state === 'quiescent' ? 'finished' : 'open';
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function historyEntries(sessionDir: string, generation: string): unknown[] {
  const manifest = readJson(path.join(sessionDir, 'generations', generation, 'manifest.json'));
  if (!isRecord(manifest) || !isRecord(manifest.projection_state)) throw new VibeStoreFormatError('The generation manifest has no projection.');
  const projection = manifest.projection_state;
  const chunks = Array.isArray(projection.chunks) ? projection.chunks.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  if (chunks.length > 0) {
    const entries: unknown[] = [];
    for (const digest of chunks) {
      const chunk = readJson(path.join(sessionDir, 'chunks', `${digest}.json`));
      if (!Array.isArray(chunk)) throw new VibeStoreFormatError(`Stored chunk ${digest} is not a transcript run.`);
      entries.push(...chunk);
    }
    return entries;
  }
  const fileName = typeof projection.path === 'string' ? projection.path : 'projection-state.json';
  const document = readJson(path.join(sessionDir, 'generations', generation, fileName));
  const snapshot = isRecord(document) && isRecord(document.snapshot) ? document.snapshot : undefined;
  const history = snapshot && isRecord(snapshot.history) ? snapshot.history : undefined;
  const entries = history && Array.isArray(history.entries) ? history.entries : undefined;
  if (!entries) throw new VibeStoreFormatError('The projection has no history.');
  return entries;
}

function metaOf(sessionDir: string): { cwd?: string; title?: string; model?: string } {
  try {
    const meta = readJson(path.join(sessionDir, 'meta.json'));
    if (!isRecord(meta)) return {};
    const environment = isRecord(meta.environment) ? meta.environment : undefined;
    const config = isRecord(meta.config) ? meta.config : undefined;
    const cwd = environment && typeof environment.working_directory === 'string' ? environment.working_directory : undefined;
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : undefined;
    const model = config && typeof config.active_model === 'string' ? config.active_model : undefined;
    return { ...(cwd ? { cwd } : {}), ...(title ? { title } : {}), ...(model ? { model } : {}) };
  } catch {
    return {};
  }
}

/** The saved user and assistant text of one session. Refuses an unknown or unreadable store. */
export function readVibeHistory(sessionDir: string): { ok: true; history: VibeHistory } | { ok: false; reason: string } {
  try {
    const pointer = requiredPointer(readJson(path.join(sessionDir, 'CURRENT')));
    const entries = historyEntries(sessionDir, pointer.generation);
    const messages: VibeHistoryMessage[] = [];
    let open: { role: 'user' | 'assistant'; text: string; timestamp: string; turnId?: string } | undefined;
    const flush = (): void => {
      if (!open) return;
      const message = open;
      open = undefined;
      if (!message.text.trim()) return;
      messages.push(message);
    };
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry.type !== 'message' || (entry.role !== 'user' && entry.role !== 'assistant')) {
        flush(); // reasoning and tool entries end the text before them
        continue;
      }
      if (entry.generationStatus === 'in_progress') continue;
      const text = textOf(entry.content);
      const timestamp = typeof entry.createdAt === 'number' ? new Date(entry.createdAt).toISOString() : new Date(0).toISOString();
      const turnId = typeof entry.turnId === 'string' ? entry.turnId : undefined;
      // Assistant text split across entries is one reply; two user messages (a cancelled turn, then a reply) stay two.
      if (open && (open.role !== entry.role || entry.role === 'user')) flush();
      if (!open) open = { role: entry.role, text: '', timestamp, ...(turnId ? { turnId } : {}) };
      open.text += text;
    }
    flush();
    return { ok: true, history: { ...metaOf(sessionDir), messages } };
  } catch (error) {
    if (error instanceof VibeStoreFormatError) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'The Vibe session store could not be read.' };
  }
}
