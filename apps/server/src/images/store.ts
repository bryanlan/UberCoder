import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { MAX_IMAGE_BYTES, type BoundSession, type ImageAttachment } from '@agent-console/shared';
import { imageAttachmentSchema } from './prompt.js';

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const MAX_PIXELS = 20_000_000;

export class ImageUploadError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export class ImageStore {
  constructor(private readonly directory: string) {}

  async save(bytes: Buffer, mediaType: string, session: BoundSession): Promise<ImageAttachment> {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageUploadError('Images must be between 1 byte and 10 MiB.', 413);
    if (!(mediaType in EXTENSIONS)) throw new ImageUploadError('Paste a PNG, JPEG or WebP image.', 415);
    const mime = mediaType as ImageAttachment['mediaType'];
    let metadata: Metadata;
    try {
      const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
      metadata = await image.metadata();
      const expectedFormat = mime === 'image/jpeg' ? 'jpeg' : EXTENSIONS[mime];
      if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) throw new Error('Format mismatch or animated image.');
      // Force pixel decoding as well as header inspection; reject truncated files.
      await image.stats();
    } catch {
      throw new ImageUploadError('The clipboard image is invalid, animated, or exceeds 20 million pixels.');
    }
    const id = randomUUID();
    const attachment: ImageAttachment = {
      id, mediaType: mime, name: `Pasted image.${EXTENSIONS[mime]}`,
      sizeBytes: bytes.length, width: metadata.width!, height: metadata.height!,
    };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(attachment);
    await fs.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await fs.writeFile(this.metadataPath(id), JSON.stringify({ ...attachment, projectSlug: session.projectSlug, provider: session.provider }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.unlink(filePath);
      throw error;
    }
    return attachment;
  }

  async get(id: string): Promise<ImageAttachment & { projectSlug: string; provider: string }> {
    if (!imageAttachmentSchema.shape.id.safeParse(id).success) throw new ImageUploadError('Image not found.', 404);
    try {
      const data = JSON.parse(await fs.readFile(this.metadataPath(id), 'utf8'));
      const attachment = imageAttachmentSchema.parse(data);
      if (attachment.id !== id || typeof data.projectSlug !== 'string' || typeof data.provider !== 'string') throw new Error('Invalid metadata.');
      return { ...attachment, projectSlug: data.projectSlug, provider: data.provider };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImageUploadError('Image not found.', 404);
      throw error;
    }
  }

  async resolve(ids: string[], session: BoundSession): Promise<Array<ImageAttachment & { path: string }>> {
    return await Promise.all(ids.map(async id => {
      const { projectSlug, provider, ...attachment } = await this.get(id);
      if (projectSlug !== session.projectSlug || provider !== session.provider) throw new ImageUploadError('This image belongs to another project or provider.', 403);
      const filePath = this.filePath(attachment);
      try { await fs.access(filePath); } catch { throw new ImageUploadError('The image file is missing. Paste it again.', 404); }
      return { ...attachment, path: filePath };
    }));
  }

  async read(id: string): Promise<{ attachment: ImageAttachment; bytes: Buffer }> {
    const attachment = await this.get(id);
    try { return { attachment, bytes: await fs.readFile(this.filePath(attachment)) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImageUploadError('Image not found.', 404);
      throw error;
    }
  }

  private metadataPath(id: string): string { return path.join(this.directory, `${id}.json`); }
  private filePath(image: ImageAttachment): string { return path.join(this.directory, `${image.id}.${EXTENSIONS[image.mediaType]}`); }
}
