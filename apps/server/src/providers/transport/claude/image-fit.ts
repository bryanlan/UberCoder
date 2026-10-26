// Fits an image to what the Messages API accepts before it goes to the CLI as a base64 block.
//
// The API rejects an image above 5 MB and downsizes one above about 1568 px on its long edge anyway. The CLI does not
// resize a block it is handed (the tmux path never met this: Claude opened the file with `Read`, which downsizes), so an
// oversized block would end the turn with an image error and could leave the image in the transcript, where it fails
// every later turn. The Console stores an image as the person pasted it (up to 10 MiB and 20 megapixels).
//
// An image that already fits is sent unchanged. Otherwise it is scaled down to the long-edge limit and re-encoded: PNG
// stays PNG, everything else becomes JPEG. A re-encoded image that is still too large is shrunk further, step by step.

import sharp from 'sharp';

/** The API's recommended long edge: a larger image is downsized by the API itself, so sending it only costs bytes. */
export const IMAGE_MAX_EDGE = 1568;
/**
 * The most the base64 text of one image may take. The API limit is 5 MB; this leaves room for the limit being counted on
 * the encoded text. Base64 is 4/3 of the bytes, so the decoded image is at most {@link IMAGE_MAX_BYTES}.
 */
export const IMAGE_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
export const IMAGE_MAX_BYTES = Math.floor((IMAGE_MAX_BASE64_BYTES * 3) / 4);
/** Pixels allowed when decoding. The Console already refuses more than 20 megapixels at upload; this is the guard against a file that did not come through it. */
const MAX_INPUT_PIXELS = 40_000_000;

/** Fractions of the long-edge limit tried in turn when a re-encoded image is still too large. */
const SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
/** JPEG qualities tried at each scale, best first. */
const JPEG_QUALITIES = [85, 72, 58];

export interface FittedImage {
  data: Buffer;
  mimeType: string;
}

/** The image failed to decode, or could not be made small enough. */
export class ImageFitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageFitError';
  }
}

export async function fitImage(bytes: Buffer, mimeType: string): Promise<FittedImage> {
  let width: number;
  let height: number;
  let format: string | undefined;
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none' }).metadata();
    format = metadata.format;
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch (error) {
    throw new ImageFitError(`The image could not be read (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
  if (width <= 0 || height <= 0) throw new ImageFitError('The image has no size.');
  if (Math.max(width, height) <= IMAGE_MAX_EDGE && bytes.length <= IMAGE_MAX_BYTES) return { data: bytes, mimeType };

  const keepPng = format === 'png';
  for (const scale of SCALES) {
    const edge = Math.max(16, Math.round(IMAGE_MAX_EDGE * scale));
    for (const quality of keepPng ? [undefined] : JPEG_QUALITIES) {
      const data = await encode(bytes, edge, keepPng, quality);
      if (data.length <= IMAGE_MAX_BYTES) return { data, mimeType: keepPng ? 'image/png' : 'image/jpeg' };
    }
  }
  throw new ImageFitError('The image is too large to send, even scaled down.');
}

async function encode(bytes: Buffer, edge: number, png: boolean, quality: number | undefined): Promise<Buffer> {
  try {
    // `rotate()` applies the EXIF orientation first: the re-encoded file carries none.
    let pipeline = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none' }).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    pipeline = png ? pipeline.png({ compressionLevel: 9 }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: quality ?? 80 });
    return await pipeline.toBuffer();
  } catch (error) {
    throw new ImageFitError(`The image could not be converted (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
}
