# ableton-pixel-display

Display images, GIFs, and video **inside Ableton Live's Arrangement view** by
driving it over [`ableton-js`](https://github.com/leolabs/ableton-js). Each pixel
is a colored clip on the timeline — rows are collapsed tracks, columns are
fixed-length clips — so both dimensions are set by the script (no manual track
resizing). Live stores full 24-bit RGB, so it's a real color display.

## Prerequisites

1. Copy the AbletonJS MIDI Remote Script into Live's Remote Scripts folder and
   enable it as a **Control Surface** (Live → Settings → Link/Tempo/MIDI). See
   the [ableton-js README](https://github.com/leolabs/ableton-js#prerequisites).
2. Ableton Live must be **running**.
3. Node 18+ and `npm install` in this folder.
4. For **video** input, [`ffmpeg`](https://ffmpeg.org) must be on your `PATH`
   (`brew install ffmpeg`). Not needed for images/GIFs.

## Quick start

```bash
npm install

# A single image
npm run pixels -- --image ~/Pictures/photo.png --width 64 --height 64

# An animated GIF
npm run pixels -- --image ~/Downloads/clip.gif --animate --width 64 --height 36

# A video file (needs ffmpeg)
npm run pixels -- --video ~/Downloads/gameplay.mp4 --animate --width 64 --height 36

# Remove everything this tool created
npm run pixels -- --clear
```

> `npm run pixels -- <flags>` — the `--` passes the flags through to the script.
> It auto-switches Live to the Arrangement view; you zoom the timeline to frame it.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--image <path>` | — | PNG/JPG/GIF, or a folder of frames |
| `--video <path>` | — | Video file (mp4/mov/webm/…), decoded via ffmpeg; alias of `--image` |
| `--width <n>` | `32` | Columns (horizontal pixels) |
| `--height <n>` | `32` | Rows (vertical pixels) |
| `--animate` | off | Play multiple frames (GIF/video/dir) in order, looping until `Ctrl+C` |
| `--clear` | — | Delete all display tracks and exit |

Animation plays each frame in order **as fast as Live will accept it** (render a
frame, wait for Live to finish painting, move on) — no frame rate to configure.
Videos are sampled at a fixed 12 fps when decoded.

> The flag parser is minimal and does **not** validate — an unknown or
> misspelled flag is silently ignored and the default is used.

## Performance (important for video)

Each pixel is a Live clip, and **Live repaints at ~1,000 clips/sec** — that's the
hard ceiling. So roughly:

> **fps ≈ 1000 ÷ (clips that change per frame)**

| Grid | full-motion fps |
|---|---|
| 24×16 | ~2.6 |
| 32×18 | ~1.7 |
| 96×54 | ~0.2 |
| 192×120 | ~0.05 |

So the one lever that matters is **`--width`/`--height`** — keep it small
(~24×16–32×18) for smoother motion, or go large and accept a slideshow. Under the
hood it already does the sensible things automatically: it only re-colors clips
that actually changed, and it uses the batched `set_clip_colors` command in the
AbletonJS script to avoid per-clip round-trips. The first frame log says `(bulk)`
when that fast path is active; if it says `(per-clip …)`, restart Live so the
script reloads.

## How it works

`buildArrangement` creates `H` collapsed tracks and tiles each with `W`
fixed-length clips (via `duplicateClipToArrangement`), tagging them with a `PXD▸`
name prefix so re-runs and `--clear` can find them. Then frames are streamed in:
images/GIFs are preloaded, video is decoded by ffmpeg to pre-scaled PNGs read one
at a time. Animation is time-based with frame-dropping — it renders the frame
matching elapsed wall time and waits for Live to finish painting, so a slow Live
drops frames and stays in real time instead of building a backlog.

## Files
- [pixel-display.ts](pixel-display.ts) — CLI, arrangement builder, renderer, animation loop.
- [pixels.ts](pixels.ts) — image/GIF/video frame loading, resizing, RGB extraction.

## Limitations
- **Motion is throughput-bound** by Live's ~1k-clips/sec repaint — high-res video
  is a slideshow, not smooth playback.
- **Zoom** isn't in the Live API — you frame the image manually.
- Recent Live stores full 24-bit RGB; very old versions may snap clip colors to
  Live's ~60-color palette.
