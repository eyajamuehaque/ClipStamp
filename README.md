# ClipStamp

A free video editor that runs entirely in the browser. Videos are never uploaded — decoding, effects and
encoding all happen on the user's device with WebCodecs. Once loaded, it works offline and can be installed
as an app (PWA).

## Free features

- Export MP4 (H.264/AAC), WebM (VP9/Opus), animated GIF or audio-only WAV — up to 4K, no watermark, no length limit
- Join several clips; per-clip trim, split, speed (0.25×–4×), rotation, volume and mute
- Remove an existing logo or watermark: smart fill, clone, blur or pixelate, each with its own timing
- Text overlays: bundled fonts, outline, background box, shadow, entrance animations (fade, slide, pop, typewriter), moving watermarks, timed display
- Logo / image overlays with transparency, timing and fade-in
- Crop with aspect presets, mirror, and canvas reshaping (9:16, 1:1, 4:5…) with a blurred-video background
- Colour looks plus brightness, contrast, saturation, temperature, hue, vignette
- Background music with volume, start time, looping and automatic ducking; fade in/out for sound and picture
- Undo/redo, keyboard shortcuts, save frame as PNG
- Autosave of the whole project (videos included) in the browser's IndexedDB; portable settings file

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build and local preview:

```bash
npm run build
npm run preview    # http://localhost:4173
```

## Deploy

**Vercel:** push this folder to a GitHub repo, then "Add New → Project" on vercel.com and import it.
`vercel.json` already sets the build command, output folder and service-worker caching. Or from the terminal:
`npx vercel` then `npx vercel --prod`.

**Netlify / Cloudflare Pages / GitHub Pages:** any static host works. Build command `npm run build`,
output folder `dist`. (`netlify.toml` is included.)

After the first visit, the service worker caches the app, so it keeps working with no connection.
Users can install it from the browser's address bar or the "Install app" button.

## Browser support

Exporting needs WebCodecs: Chrome, Edge, Opera, and Safari 17+ work. Firefox can decode but has limited
encoder support, so export may fall back to WebM or be unavailable. MP4 export uses H.264 where the browser
supports it and otherwise picks HEVC, VP9 or AV1 automatically.

## Project layout

```
src/
  engine/render.ts    one frame pipeline used by preview, snapshot and export
  engine/hide.ts      logo removal (push-pull inpainting, clone, blur, pixelate)
  engine/export.ts    Mediabunny + WebCodecs encode, audio mixing, GIF
  engine/persist.ts   IndexedDB autosave and settings files
  engine/timeline.ts  output-time math and output size
  player.ts           preview playback across clips, music preview
  store.ts            Zustand state with undo/redo
  components/         Stage (canvas + direct manipulation), Timeline, ClipStrip, Panels
```
