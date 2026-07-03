import {Jimp} from 'jimp';
import {GifUtil} from 'gifwrap';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Image / animation loading + pixel extraction, decoupled from Ableton.
 *
 * A "frame" is a decoded image plus how long to show it. loadFrames() accepts:
 *   - a single image  (png/jpg/bmp/tiff) -> 1 frame
 *   - an animated GIF                     -> N composited frames
 *   - a directory of images              -> 1 frame per file, sorted by name
 */

// @jimp's subpackages export several incompatible `Jimp` type identities
// (Jimp.read vs Jimp.fromBitmap vs new Jimp resolve to different ones), so we
// model just the members we use and cast at the library boundary.
type Bitmap = {width: number; height: number; data: Uint8Array};
export type JimpImage = {
  bitmap: Bitmap;
  clone(): JimpImage;
  resize(opts: {w: number; h: number}): JimpImage;
  composite(src: JimpImage, x: number, y: number): JimpImage;
  setPixelColor(color: number, x: number, y: number): JimpImage;
};

const asImage = (v: unknown) => v as JimpImage;
const readImage = async (p: string) => asImage(await Jimp.read(p));
const newImage = (w: number, h: number, color: number) => asImage(new Jimp({width: w, height: h, color}));

export type Frame = {image: JimpImage; delayMs: number};

const IMAGE_EXT = /\.(png|jpe?g|bmp|tiff?|gif)$/i;

export const loadFrames = async (input: string): Promise<Frame[]> => {
  const stat = await fs.stat(input);

  if (stat.isDirectory()) {
    const files = (await fs.readdir(input)).filter((f) => IMAGE_EXT.test(f)).sort();
    if (!files.length) throw new Error(`No images found in directory: ${input}`);
    const frames: Frame[] = [];
    for (const f of files) {
      frames.push({image: await readImage(path.join(input, f)), delayMs: 100});
    }
    return frames;
  }

  if (/\.gif$/i.test(input)) return loadGifFrames(input);

  return [{image: await readImage(input), delayMs: 100}];
};

// ── Video (via ffmpeg) ───────────────────────────────────────────────────────
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
export const isVideo = (p: string) => VIDEO_EXT.test(p);

const runFfmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', args, {stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        new Error(
          e.code === 'ENOENT' ? 'ffmpeg not found — install it first (e.g. `brew install ffmpeg`).' : String(e),
        ),
      ),
    );
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed:\n' + err.slice(-800)))));
  });

/**
 * Decode a video into pre-scaled PNG frames in a temp dir, sampled at `fps`.
 * Frames come out already at w×h so per-frame decoding stays cheap — returns
 * the sorted file paths (loaded lazily during playback, not all into memory).
 */
export const extractVideoFrames = async (input: string, w: number, h: number, fps: number): Promise<string[]> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pxd-video-'));
  await runFfmpeg(['-i', input, '-vf', `fps=${fps},scale=${w}:${h}:flags=bilinear`, '-y', path.join(dir, 'f%06d.png')]);
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(dir, f));
  if (!files.length) {
    throw new Error('ffmpeg produced no frames — is the video file valid?');
  }
  return files;
};

/** Load a single image file as a one-off frame (used for lazy video playback). */
export const loadImageFrame = async (p: string): Promise<Frame> => ({
  image: await readImage(p),
  delayMs: 0,
});

// gifwrap hands back raw (possibly partial) frames with offsets + disposal
// methods, so we composite them onto a running canvas to get full frames.
const loadGifFrames = async (input: string): Promise<Frame[]> => {
  const gif = await GifUtil.read(input);
  const w = gif.width;
  const h = gif.height;
  const canvas = newImage(w, h, 0x00000000);
  const frames: Frame[] = [];

  for (const fr of gif.frames) {
    const ox = fr.xOffset ?? 0;
    const oy = fr.yOffset ?? 0;
    canvas.composite(asImage(Jimp.fromBitmap(fr.bitmap)), ox, oy);
    frames.push({image: canvas.clone(), delayMs: (fr.delayCentisecs ?? 10) * 10});

    // Disposal method 2 = restore the frame's region to background before next
    if (fr.disposalMethod === 2) {
      const bw = fr.bitmap.width;
      const bh = fr.bitmap.height;
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < bw; xx++) {
          canvas.setPixelColor(0x00000000, ox + xx, oy + yy);
        }
      }
    }
  }
  return frames;
};

/**
 * Resize a frame to w×h and return row-major 0xRRGGBB values (alpha dropped).
 * Index into the result with `y * w + x`.
 */
export const toRGBGrid = (frame: Frame, w: number, h: number): number[] => {
  const im = frame.image.clone();
  im.resize({w, h});
  const d = im.bitmap.data;
  const out = new Array<number>(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    out[i] = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
  }
  return out;
};
