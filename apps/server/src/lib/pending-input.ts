import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';
import { normalizeComparableText, stableTextHash, truncate } from './text.js';

const STAGED_LIVE_INPUT_PATTERN = /^Read and follow the full user prompt saved at "([^"]+)"\. Treat the file contents as the user's latest message before replying\.$/;

export function buildStagedLiveInputInstruction(filePath: string): string {
  return `Read and follow the full user prompt saved at "${filePath}". Treat the file contents as the user's latest message before replying.`;
}

export function extractStagedLiveInputPath(text: string): string | undefined {
  return text.match(STAGED_LIVE_INPUT_PATTERN)?.[1];
}

export function buildPendingInputMetadata(
  rawMetadata: Record<string, unknown> | undefined,
  text: string,
  options: { stagedPath?: string } = {},
): Record<string, unknown> {
  const stagedPath = options.stagedPath ?? extractStagedLiveInputPath(text);
  const nextMetadata = { ...(rawMetadata ?? {}) };

  nextMetadata.lastUserInputHash = stableTextHash(normalizeComparableText(text));
  nextMetadata.lastUserInputPreview = truncate(text, 120);

  if (stagedPath) {
    nextMetadata.lastUserTransportPath = stagedPath;
    nextMetadata.lastUserTransportHash = stableTextHash(
      normalizeComparableText(buildStagedLiveInputInstruction(stagedPath)),
    );
  } else {
    delete nextMetadata.lastUserTransportPath;
    delete nextMetadata.lastUserTransportHash;
  }

  return nextMetadata;
}

async function addStagedInstructionHashFromFile(
  hashes: Set<string>,
  filePath: string,
  expectedContentHash: string | undefined,
  preview: string | undefined,
): Promise<void> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    const contentHash = stableTextHash(normalizeComparableText(content));
    const normalizedPreview = preview ? normalizeComparableText(preview) : undefined;
    const normalizedContent = normalizedPreview ? normalizeComparableText(content) : undefined;

    if (
      expectedContentHash
      && contentHash !== expectedContentHash
      && (!normalizedPreview || !normalizedContent?.startsWith(normalizedPreview))
    ) {
      return;
    }

    hashes.add(contentHash);
    hashes.add(stableTextHash(normalizeComparableText(buildStagedLiveInputInstruction(filePath))));
  } catch {
    // Best-effort match enrichment only.
  }
}

export async function collectPendingMatchHashes(
  pending: ConversationSummary,
  options: { session?: BoundSession; runtimeDir?: string } = {},
): Promise<string[]> {
  const hashes = new Set<string>();
  const rawMetadata = pending.rawMetadata ?? {};
  const expectedContentHash = typeof rawMetadata.lastUserInputHash === 'string'
    ? rawMetadata.lastUserInputHash
    : undefined;
  const preview = typeof rawMetadata.lastUserInputPreview === 'string'
    ? rawMetadata.lastUserInputPreview
    : undefined;
  const explicitTransportHash = typeof rawMetadata.lastUserTransportHash === 'string'
    ? rawMetadata.lastUserTransportHash
    : undefined;
  const explicitTransportPath = typeof rawMetadata.lastUserTransportPath === 'string'
    ? rawMetadata.lastUserTransportPath
    : undefined;

  if (expectedContentHash) {
    hashes.add(expectedContentHash);
  }
  if (explicitTransportHash) {
    hashes.add(explicitTransportHash);
  }
  if (explicitTransportPath) {
    await addStagedInstructionHashFromFile(hashes, explicitTransportPath, expectedContentHash, preview);
  }

  const sessionDir = options.session?.rawLogPath
    ? path.dirname(options.session.rawLogPath)
    : options.session && options.runtimeDir
      ? path.join(options.runtimeDir, options.session.id)
      : undefined;
  if (!sessionDir) {
    return [...hashes];
  }

  try {
    const bridgeInputsDir = path.join(sessionDir, 'bridge-inputs');
    const entries = await fsPromises.readdir(bridgeInputsDir, { withFileTypes: true });
    const candidatePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(bridgeInputsDir, entry.name))
      .sort((a, b) => b.localeCompare(a));

    for (const filePath of candidatePaths) {
      await addStagedInstructionHashFromFile(hashes, filePath, expectedContentHash, preview);
    }
  } catch {
    // No staged prompt files available for recovery.
  }

  return [...hashes];
}
