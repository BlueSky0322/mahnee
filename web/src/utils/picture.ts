// A chosen photo made into a profile picture on the device: the middle square, at 256px,
// as WebP (JPEG where the browser can't make WebP), under the server's limit
// (MAX_PICTURE_BYTES), so a phone's several-MB photo goes up as a few KB.

import { MAX_PICTURE_BYTES } from '@shared/api';
import { UserError } from './notify';

/** The side a picture is kept at: sharp at the largest circle it's drawn in (64px, 3x) */
export const PICTURE_SIDE = 256;

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // Applies the photo's rotation, so portrait shots stay upright
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Some browsers decode more formats through an <img>; tried below
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new UserError("Couldn't read that photo.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** The photo as a small square picture, ready to send; a UserError says why it can't be */
export async function squarePicture(file: Blob): Promise<Blob> {
  const image = await decode(file);
  const side = Math.min(image.width, image.height);
  const sx = (image.width - side) / 2;
  const sy = (image.height - side) / 2;
  const out = Math.min(PICTURE_SIDE, Math.max(1, Math.round(side)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (ctx == null) throw new UserError("Couldn't read that photo.");
  // A see-through picture sits on white, as JPEG would draw it
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, side, side, 0, 0, out, out);
  if ('close' in image) image.close();

  for (const quality of [0.85, 0.7, 0.5]) {
    let blob = await toBlob(canvas, 'image/webp', quality);
    // Browsers that can't make WebP make PNG instead: JPEG is smaller
    if (blob != null && blob.type !== 'image/webp') {
      blob = await toBlob(canvas, 'image/jpeg', quality);
    }
    if (blob == null) throw new UserError("Couldn't read that photo.");
    if (blob.size <= MAX_PICTURE_BYTES) return blob;
  }
  throw new UserError("That photo couldn't be made small enough.");
}
