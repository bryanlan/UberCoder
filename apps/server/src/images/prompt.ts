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

// The transport envelope stays in provider history and event logs for adoption,
// recovery and duplicate matching. Public messages expose only caption + metadata.
export function imagePromptDisplay(text: string): { text: string; images?: ImageAttachment[] } {
  const start = text.lastIndexOf(OPEN);
  if (start < 0 || !text.trimEnd().endsWith(CLOSE)) return { text };
  const lines = text.slice(start + OPEN.length, text.lastIndexOf(CLOSE)).trim().split('\n');
  if (!lines[0]?.startsWith('Inspect the attached local image files with ')) return { text };
  const rows = lines.slice(1);
  if (!rows.length || rows.length > MAX_PROMPT_IMAGES) return { text };
  try {
    const images = rows.map(row => imageAttachmentSchema.parse(JSON.parse(row)));
    return { text: text.slice(0, start).trimEnd(), images };
  } catch {
    return { text };
  }
}

export function imageMessageDisplay(message: NormalizedMessage): NormalizedMessage {
  return message.role === 'user' ? { ...message, ...imagePromptDisplay(message.text) } : message;
}
