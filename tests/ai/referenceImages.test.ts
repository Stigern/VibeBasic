// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { loadReferenceImage, referenceImages, MAX_REFERENCE_BYTES, prepareReferenceImage } from '../../src/ai/referenceImages';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
afterEach(() => vi.restoreAllMocks());
test('cancelled file selection does not read a file', async () => {
  const backend = { openFileDialog: vi.fn(async () => null), readBinaryFile: vi.fn() };
  expect(await loadReferenceImage(backend)).toBeNull();
  expect(backend.readBinaryFile).not.toHaveBeenCalled();
});
test.each([
  { mime: 'image/png', bytes: PNG },
  { mime: 'image/jpeg', bytes: new Uint8Array([255, 216, 255, 224]) },
  { mime: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]) },
])('recognizes $mime content regardless of filename and excludes directories', async ({ mime, bytes }) => {
  const prepare = vi.spyOn(referenceImages, 'prepare').mockResolvedValue('data:image/png;base64,prepared');
  const backend = { openFileDialog: async () => '/private/folder/example.png', readBinaryFile: async () => bytes };
  expect(await loadReferenceImage(backend)).toEqual({ name: 'example.png', url: 'data:image/png;base64,prepared' });
  expect(prepare).toHaveBeenCalledWith(bytes, mime, document);
});
test('rejects invalid and oversized files before decoding', async () => {
  const prepare = vi.spyOn(referenceImages, 'prepare');
  const backend = (bytes: Uint8Array) => ({ openFileDialog: async () => 'example.png', readBinaryFile: async () => bytes });
  await expect(loadReferenceImage(backend(new Uint8Array([1, 2])))).rejects.toThrow('PNG, JPEG or WebP');
  await expect(loadReferenceImage(backend(new Uint8Array(MAX_REFERENCE_BYTES + 1)))).rejects.toThrow('5 MiB');
  expect(prepare).not.toHaveBeenCalled();
});
test('image decoding failures are reported', async () => {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = create(tag);
    if (tag === 'img') queueMicrotask(() => el.dispatchEvent(new Event('error')));
    return el;
  }) as typeof document.createElement);
  await expect(prepareReferenceImage(PNG, 'image/png', document)).rejects.toThrow('decode');
});
test.each(['image/png', 'image/webp'])('large %s images keep aspect ratio and transparency when resized', async mime => {
  const create = document.createElement.bind(document);
  const draw = vi.fn();
  let canvas!: HTMLCanvasElement;
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = create(tag);
    if (tag === 'img') {
      Object.defineProperties(el, { naturalWidth: { value: 3200 }, naturalHeight: { value: 2000 } });
      queueMicrotask(() => el.dispatchEvent(new Event('load')));
    }
    if (tag === 'canvas') {
      canvas = el as HTMLCanvasElement;
      canvas.getContext = vi.fn(() => ({ drawImage: draw })) as any;
      canvas.toDataURL = vi.fn(() => 'data:image/png;base64,resized');
    }
    return el;
  }) as typeof document.createElement);
  expect(await prepareReferenceImage(PNG, mime, document)).toBe('data:image/png;base64,resized');
  expect([canvas.width, canvas.height]).toEqual([1600, 1000]);
  expect(draw).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 1600, 1000);
  expect(canvas.toDataURL).toHaveBeenCalledWith('image/png', 0.85);
});
