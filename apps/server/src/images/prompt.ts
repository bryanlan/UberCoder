import path from 'node:path';
import { MAX_PROMPT_IMAGES, type ImageAttachment, type NormalizedMessage, type ProviderId } from '@agent-console/shared';
import { z } from 'zod';

export const imageAttachmentSchema = z.object({
  id: z.string().uuid(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  name: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const OPEN = '<agent-console-images>';
const CLOSE = '</agent-console-images>';

export function imagePromptSuffix(images: Array<ImageAttachment & { path: string }>, provider: ProviderId): string {
  const tool = provider === 'codex' ? 'view_image' : 'Read';
  return `\n${OPEN}\nInspect the attached local image files with ${tool} before answering. If you cannot open them, say so.\n${images.map(image => JSON.stringify(image)).join('\n')}\n${CLOSE}`;
}

const INSTRUCTION_PREFIX = 'Inspect the attached local image files with ';

/**
 * The rows of an envelope. The envelope normally opens with the instruction line, but a transport that attaches images natively
 * sends it without (see {@link withoutImageInstruction}), so a provider transcript can hold either form.
 */
function envelopeRows(text: string): { start: number; rows: string[] } | undefined {
  const start = text.lastIndexOf(OPEN);
  if (start < 0 || !text.trimEnd().endsWith(CLOSE)) return undefined;
  const lines = text.slice(start + OPEN.length, text.lastIndexOf(CLOSE)).trim().split('\n');
  const rows = lines[0]?.startsWith(INSTRUCTION_PREFIX) ? lines.slice(1) : lines;
  if (!rows.length || rows.length > MAX_PROMPT_IMAGES) return undefined;
  return { start, rows };
}

/**
 * The message text for a transport that attaches the images itself: the envelope keeps its rows (the stored message, the event
 * log and a provider transcript still carry them, so adoption and duplicate matching work), but the line that tells a terminal
 * agent to open the files is dropped. Left in, it makes the model open each image a second time and be charged for it twice.
 */
export function withoutImageInstruction(text: string): string {
  const start = text.lastIndexOf(OPEN);
  if (start < 0 || !text.trimEnd().endsWith(CLOSE)) return text;
  const bodyStart = start + OPEN.length;
  const bodyEnd = text.lastIndexOf(CLOSE);
  const lines = text.slice(bodyStart, bodyEnd).trim().split('\n');
  if (!lines[0]?.startsWith(INSTRUCTION_PREFIX)) return text;
  return `${text.slice(0, bodyStart)}\n${lines.slice(1).join('\n')}\n${text.slice(bodyEnd)}`;
}

// The transport envelope stays in provider history and event logs for adoption,
// recovery and duplicate matching. Public messages expose only caption + metadata.
export function imagePromptDisplay(text: string): { text: string; images?: ImageAttachment[] } {
  const envelope = envelopeRows(text);
  if (!envelope) return { text };
  try {
    const images = envelope.rows.map(row => imageAttachmentSchema.parse(JSON.parse(row)));
    return { text: text.slice(0, envelope.start).trimEnd(), images };
  } catch {
    return { text };
  }
}

const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const imageRowSchema = imageAttachmentSchema.extend({ path: z.string().min(1) });

/**
 * The stored image files named by the prompt envelope, for a transport that attaches images natively. The rows are the ones the
 * `/keys` route wrote from the image store, so a row is accepted only when it names the store's own `<id>.<ext>` file directly
 * in the store directory. Any other path is refused rather than read: the message text is authored by the person, but a file
 * outside the store must never become an attachment.
 */
export function imagePromptFiles(text: string, storeDir: string): Array<{ path: string; mimeType: ImageAttachment['mediaType'] }> {
  const envelope = envelopeRows(text);
  if (!envelope) return [];
  const directory = path.resolve(storeDir);
  try {
    return envelope.rows.map((row) => {
      const image = imageRowSchema.parse(JSON.parse(row));
      if (!path.isAbsolute(image.path) || path.dirname(image.path) !== directory
        || path.basename(image.path) !== `${image.id}.${IMAGE_EXTENSIONS[image.mediaType]}`) {
        throw new Error('Not an image store file.');
      }
      return { path: image.path, mimeType: image.mediaType };
    });
  } catch {
    return [];
  }
}

export function imageMessageDisplay(message: NormalizedMessage): NormalizedMessage {
  return message.role === 'user' ? { ...message, ...imagePromptDisplay(message.text) } : message;
}
