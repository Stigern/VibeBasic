import type { Backend } from '../backend/backend';
import { bytesToBase64 } from '../ide/propertyEditors';

export interface ReferenceImage { name: string; url: string }
export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
export const MAX_REFERENCES = 2;
const MAX_EDGE = 1600;

function imageMime(bytes: Uint8Array): string | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Decode before accepting a file; small images keep their bytes, large ones fit within MAX_EDGE. */
export async function prepareReferenceImage(bytes: Uint8Array, mime: string, doc: Document): Promise<string> {
  const url = `data:${mime};base64,${bytesToBase64(bytes)}`;
  const img = doc.createElement('img');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not decode the reference image in time.')), 15000);
    img.onload = () => { clearTimeout(timer); resolve(); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('Could not decode the reference image.')); };
    img.src = url;
  });
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('Could not decode the reference image dimensions.');
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) return url;
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not resize the reference image.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // WebP, like PNG, may have transparency; converting it to JPEG would flatten the reference's background.
  return canvas.toDataURL(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85);
}

/** Like formPictures: the browser decoding boundary can be substituted in non-visual tests. */
export const referenceImages = { prepare: prepareReferenceImage };

export async function loadReferenceImage(backend: Pick<Backend, 'openFileDialog' | 'readBinaryFile'>, doc = document): Promise<ReferenceImage | null> {
  const path = await backend.openFileDialog([{ name: 'Reference images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]);
  if (!path) return null;
  const bytes = await backend.readBinaryFile(path);
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error('Reference images must be 5 MiB or smaller.');
  const mime = imageMime(bytes);
  if (!mime) throw new Error('Choose a PNG, JPEG or WebP image.');
  return { name: path.split(/[\\/]/).pop() || 'Reference image', url: await referenceImages.prepare(bytes, mime, doc) };
}
