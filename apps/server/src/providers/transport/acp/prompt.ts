import fs from 'node:fs';

/** A file error that may clear on a retry, so the message was not sent and can be queued again. */
export function isTransientFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN' || code === 'EBUSY' || code === 'EIO' || code === 'ENOMEM';
}

export interface PromptImage {
  path: string;
  mimeType: string;
}

/**
 * ACP prompt blocks: every image, then the text. The caller turns a read failure into the transport error it wants
 * (`NotSentError` for a transient read, `SendRejectedError` for a missing file).
 */
export async function buildPromptBlocks(
  input: { text: string; images?: PromptImage[] },
  errors: { onTransient(error: unknown): Error; onMissing(error: unknown): Error },
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const image of input.images ?? []) {
    let data: Buffer;
    try {
      data = await fs.promises.readFile(image.path);
    } catch (error) {
      throw isTransientFileError(error) ? errors.onTransient(error) : errors.onMissing(error);
    }
    blocks.push({ type: 'image', data: data.toString('base64'), mimeType: image.mimeType });
  }
  blocks.push({ type: 'text', text: input.text });
  return blocks;
}
