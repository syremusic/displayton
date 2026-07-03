import {Ableton} from 'ableton-js';
import {loadFrames, toRGBGrid, isVideo, extractVideoFrames, loadImageFrame, type Frame} from './pixels.js';

/**
 * Display images, GIFs, and video inside Ableton Live's Arrangement view.
 *
 * Each pixel is a colored clip on the timeline: rows are collapsed tracks,
 * columns are fixed-length clips. Both dimensions are set by the script, so no
 * manual track resizing.
 *
 * Examples:
 *   npx tsx pixel-display.ts --image cat.png
 *   npx tsx pixel-display.ts --video gameplay.mp4 --animate --width 96 --height 54
 *   npx tsx pixel-display.ts --clear
 */

// ── CLI parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const INPUT = opt('image') ?? opt('video'); // --image and --video are interchangeable
const ANIMATE = flag('animate');
const CLEAR = flag('clear');
const WIDTH = Number(opt('width', '32'));
const HEIGHT = Number(opt('height', '32'));

// Sensible fixed internals — no need to tune these.
const EXTRACT_FPS = 12; // frames/sec sampled from video files
const DELTA = 16; // skip color updates whose per-channel change is below this
const CONCURRENCY = 24; // max in-flight color sets (only used on the fallback path)

// Tag so re-runs can find and replace their own tracks.
const PREFIX = 'PXD▸';
const ARR_STEP = 0.5; // clip length (beats) = one pixel's width

const ableton = new Ableton({
  logger: console,
  // A heavy grid makes Live slow to answer; without these the default 2s
  // timeout errors out mid-frame (dropping the connection) and the 1s warn
  // threshold spams the console.
  commandTimeoutMs: 30000,
  commandWarnMs: 15000,
});

// Run async tasks with bounded concurrency (UDP pipelining without a flood).
const mapLimit = async <T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) => {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
};

// ── Track cleanup ────────────────────────────────────────────────────────────
const clearDisplayTracks = async () => {
  const tracks = await ableton.song.get('tracks');
  // Delete from the end so earlier indices stay valid.
  for (let i = tracks.length - 1; i >= 0; i--) {
    const name = await tracks[i].get('name');
    if (name.startsWith(PREFIX)) await ableton.song.deleteTrack(i);
  }
};

// ── Build the pixel grid in the Arrangement ──────────────────────────────────
// Rows are collapsed tracks (uniform minimal height), columns are fixed-length
// clips (uniform width). Both dimensions are API-controlled — no manual sizing.
const buildArrangement = async (w: number, h: number) => {
  await clearDisplayTracks();

  const rows: any[] = [];
  for (let y = 0; y < h; y++) {
    const track = await ableton.song.createMidiTrack(-1);
    await track.set('name', `${PREFIX}r${y}`);
    try {
      await track.view.set('is_collapsed', true);
    } catch {
      /* older Live: leave uncollapsed */
    }
    rows.push(track);
  }

  // Per row: make a temp source clip, stamp W arrangement clips of length STEP.
  const cells: any[][] = Array.from({length: w}, () => new Array(h));
  console.log(`Creating ${w}×${h} = ${w * h} arrangement clips…`);
  await mapLimit(
    rows.map((t, y) => [t, y] as [any, number]),
    8,
    async ([track, y]) => {
      const slots = await track.get('clip_slots');
      await slots[0].createClip(ARR_STEP);
      const source = await slots[0].get('clip');
      for (let x = 0; x < w; x++) {
        cells[x][y] = await track.duplicateClipToArrangement(source, x * ARR_STEP);
      }
      await slots[0].deleteClip(); // remove the temp Session source clip
    },
  );

  return cells;
};

// ── Rendering ────────────────────────────────────────────────────────────────
// Largest per-channel difference between two 0xRRGGBB colors.
const channelDelta = (a: number, b: number) =>
  Math.max(
    Math.abs(((a >> 16) & 0xff) - ((b >> 16) & 0xff)),
    Math.abs(((a >> 8) & 0xff) - ((b >> 8) & 0xff)),
    Math.abs((a & 0xff) - (b & 0xff)),
  );

// Renders one frame. `last` is a persistent buffer (-1 = never set) that we
// update only for cells we actually change, so DELTA-skipped cells keep their
// real baseline instead of silently drifting.
const renderFrame = async (cells: any[][], rgb: number[], w: number, h: number, last: number[]) => {
  const changed: Array<[number, number, number, number]> = []; // x, y, index, color
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      const val = rgb[i];
      if (last[i] < 0 || channelDelta(last[i], val) > DELTA) changed.push([x, y, i, val]);
    }
  }
  if (!changed.length) return 0;

  // Individual sets, throttled + resilient to dropped commands.
  await mapLimit(changed, CONCURRENCY, async ([x, y, i, val]) => {
    try {
      if (cells[x][y]) {
        await cells[x][y].set('color', val);
        last[i] = val;
      }
    } catch {
      /* command timed out / dropped — leave last[i] so we retry next frame */
    }
  });
  return changed.length;
};

// ── Frame source ─────────────────────────────────────────────────────────────
// A lazy provider so long videos aren't all held in memory: images/GIFs are
// preloaded; videos are decoded to pre-scaled PNGs and read one frame at a time.
type FrameSource = {count: number; get: (i: number) => Promise<Frame>};

const buildSource = async (input: string): Promise<FrameSource> => {
  if (isVideo(input)) {
    console.log('Decoding video with ffmpeg (this can take a moment)…');
    const files = await extractVideoFrames(input, WIDTH, HEIGHT, EXTRACT_FPS);
    return {count: files.length, get: (i) => loadImageFrame(files[i])};
  }
  const frames = await loadFrames(input);
  return {count: frames.length, get: async (i) => frames[i]};
};

// A round-trip that only completes once Live's main thread has drained pending
// work (individual color-set commands ack *before* Live finishes repainting,
// so we need this to avoid outrunning Live and piling up a backlog).
const syncBarrier = async () => {
  try {
    await ableton.song.get('current_song_time');
  } catch {
    /* ignore — barrier is best-effort */
  }
};

// ── Animation driver ─────────────────────────────────────────────────────────
// Play frames in order as fast as Live will accept them: render a frame, wait
// for Live to finish painting (the barrier), then move to the next. This
// naturally paces to Live's real throughput without any target frame rate.
const runAnimation = async (count: number, render: (index: number) => Promise<void>) => {
  let running = true;
  process.on('SIGINT', () => {
    running = false;
  });

  let i = 0;
  while (running) {
    await render(i);
    await syncBarrier();
    i = (i + 1) % count;
  }
};

// ── Main ─────────────────────────────────────────────────────────────────────
const main = async () => {
  await ableton.start();
  console.log('Connected to Ableton! 🎹\n');

  if (CLEAR) {
    await clearDisplayTracks();
    console.log('Cleared display tracks.');
    await ableton.close();
    return;
  }

  if (!INPUT) {
    console.error('Missing --image/--video <path>. (Or use --clear to remove the display.)');
    await ableton.close();
    return;
  }

  const src = await buildSource(INPUT);
  console.log(`Loaded ${src.count} frame(s) from ${INPUT}`);
  const animate = ANIMATE && src.count > 1;

  const cells = await buildArrangement(WIDTH, HEIGHT);
  await ableton.application.view.showView('Arranger');

  const last = new Array<number>(WIDTH * HEIGHT).fill(-1);
  if (animate) {
    console.log(`Animating ${src.count} frames as fast as Live allows (Ctrl+C to stop)…`);
    let shown = false;
    await runAnimation(src.count, async (i) => {
      const grid = toRGBGrid(await src.get(i), WIDTH, HEIGHT);
      const t0 = Date.now();
      const n = await renderFrame(cells, grid, WIDTH, HEIGHT, last);
      if (!shown) {
        shown = true;
        console.log(`Frame ${i}: updated ${n}/${WIDTH * HEIGHT} cells in ${Date.now() - t0}ms.`);
      }
    });
  } else {
    await renderFrame(cells, toRGBGrid(await src.get(0), WIDTH, HEIGHT), WIDTH, HEIGHT, last);
    console.log('🖼️  Image rendered into the Arrangement.');
  }

  await ableton.close();
};

main().catch(console.error);
