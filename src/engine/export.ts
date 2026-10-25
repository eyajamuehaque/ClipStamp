// Export pipeline. Everything runs in the browser with WebCodecs (via Mediabunny) — no upload.
import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat,
  Output, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM, Quality, VideoSampleSink, WavOutputFormat, WebMOutputFormat,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
  type AudioCodec, type InputAudioTrack, type InputVideoTrack, type VideoCodec,
} from 'mediabunny';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { Clip, Doc } from '../types';
import { createRenderer, preloadFonts, preloadImages } from './render';
import { clipOutDur, outputSize, totalDuration } from './timeline';

export class ExportCanceled extends Error { constructor() { super('Export canceled.'); this.name = 'ExportCanceled'; } }

export interface ExportJob {
  cancel(): void;
  done: Promise<{ blob: Blob; name: string; note: string }>;
}

const SR = 48000;
const WIN = 30; // seconds of audio rendered per chunk (keeps memory flat on long videos)

interface Opened { clip: Clip; input: Input; video: InputVideoTrack; audio: InputAudioTrack | null }

export function startExport(doc: Doc, onProgress: (p: number, msg: string) => void): ExportJob {
  let cancelled = false;
  let output: Output | null = null;
  const check = () => { if (cancelled) throw new ExportCanceled(); };

  const done = (async () => {
    const fmt = doc.output.format;
    const clips = doc.clips;
    if (!clips.length) throw new Error('Add a video first.');
    const total = totalDuration(clips);
    if (total <= 0.01) throw new Error('Every clip is trimmed to nothing. Widen a trim range and try again.');

    onProgress(0, 'Reading clips…');
    const opened: Opened[] = [];
    for (const clip of clips) {
      const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error(`"${clip.name}" has no video track.`);
      if (!(await video.canDecode())) throw new Error(`This browser can't decode "${clip.name}". Try Chrome or Edge, or convert the file to H.264 MP4 first.`);
      let audio: InputAudioTrack | null = null;
      try { const a = await input.getPrimaryAudioTrack(); if (a && await a.canDecode()) audio = a; } catch { /* no audio */ }
      opened.push({ clip, input, video, audio });
    }
    await preloadFonts(doc.overlays);
    await preloadImages(doc.overlays);

    // Decode each added audio file once, however many times it's placed on the timeline.
    const sounds = new Map<string, AudioBuffer>();
    for (const src of doc.audio.sources) {
      if (!doc.audio.clips.some(a => a.sourceId === src.id)) continue;
      onProgress(0, `Decoding ${src.name}…`);
      const ac = new OfflineAudioContext(2, 1, SR);
      try { sounds.set(src.id, await ac.decodeAudioData(await src.file.arrayBuffer())); }
      catch { throw new Error(`"${src.name}" couldn't be decoded. Try converting it to MP3 or WAV.`); }
    }
    const wantAudio = opened.some(o => o.audio && !o.clip.muted && o.clip.volume > 0) || sounds.size > 0;

    // Name the file after the watermark text when there is one, e.g. "MyBrand.mp4".
    const mark = doc.overlaysEnabled ? doc.overlays.find(o => o.kind === 'text' && o.text.trim()) : undefined;
    const markName = mark?.kind === 'text' ? safeFileName(mark.text) : '';
    const base = markName || (clips.length > 1 ? 'clipsmith-edit' : clips[0].name.replace(/\.[^.]+$/, '') + '-edited');

    try {
      if (fmt === 'gif') {
        const blob = await renderGif(doc, opened, total, onProgress, check);
        return { blob, name: base + '.gif', note: `Animated GIF, ${doc.output.gifWidth}px wide at ${doc.output.gifFps} fps.` };
      }

      const target = new BufferTarget();
      output = new Output({ format: fmt === 'webm' ? new WebMOutputFormat() : fmt === 'wav' ? new WavOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }), target });

      let videoSource: CanvasSource | null = null;
      let canvas: OffscreenCanvas | null = null;
      let size = { w: 0, h: 0 };
      let vcodec: VideoCodec | null = null;
      if (fmt !== 'wav') {
        size = outputSize(doc);
        const candidates: VideoCodec[] = fmt === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'vp9', 'av1'];
        vcodec = await getFirstEncodableVideoCodec(candidates, { width: size.w, height: size.h });
        if (!vcodec) throw new Error(`This browser can't encode ${size.w}×${size.h} video. Try a lower export resolution, or use Chrome/Edge.`);
        canvas = new OffscreenCanvas(size.w, size.h);
        videoSource = new CanvasSource(canvas, { codec: vcodec, quality: pickQuality(doc, total), keyFrameInterval: 2 });
        output.addVideoTrack(videoSource, { frameRate: doc.output.fps || 30 });
      }

      let audioSource: AudioBufferSource | null = null;
      let acodec: AudioCodec | null = null;
      if (wantAudio || fmt === 'wav') {
        acodec = fmt === 'wav' ? 'pcm-s16'
          : await getFirstEncodableAudioCodec(fmt === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus'], { numberOfChannels: 2, sampleRate: SR });
        if (acodec) {
          audioSource = new AudioBufferSource(fmt === 'wav' ? { codec: acodec } : { codec: acodec, quality: QUALITY_HIGH });
          output.addAudioTrack(audioSource);
        }
      }

      await output.start();

      // Video and audio are written clip by clip, so they stay in sync.
      const renderer = createRenderer();
      const ctx = canvas?.getContext('2d', { alpha: false }) ?? null;
      const cap = doc.output.fps || 60;
      let offset = 0;
      for (let i = 0; i < opened.length; i++) {
        check();
        const o = opened[i];
        const label = opened.length > 1 ? `Clip ${i + 1} of ${opened.length}` : 'Encoding';
        if (videoSource && ctx) {
          let nextEmit = -Infinity;
          const sink = new VideoSampleSink(o.video);
          for await (const sample of sink.samples(o.clip.trimStart, o.clip.trimEnd)) {
            try {
              check();
              const outTs = Math.max(offset, offset + (sample.timestamp - o.clip.trimStart) / o.clip.speed);
              if (outTs < nextEmit - 0.25 / cap) continue; // keep at most `cap` frames per second
              nextEmit = outTs + 1 / cap;
              const src = { w: sample.displayWidth, h: sample.displayHeight, draw: (c: any, w: number, h: number) => sample.draw(c, 0, 0, w, h) };
              renderer.render(ctx, size.w, size.h, src, o.clip, doc, sample.timestamp, outTs, total);
              const dur = Math.max(1 / 240, Math.min(sample.duration, o.clip.trimEnd - sample.timestamp) / o.clip.speed);
              await videoSource.add(outTs, dur);
              const p = Math.min(0.99, (outTs - 0) / total);
              onProgress(p, `${label} — ${Math.round(p * 100)}%`);
            } finally { sample.close(); }
          }
        }
        if (audioSource) {
          onProgress(Math.min(0.99, (offset + clipOutDur(o.clip)) / total), `${label} — mixing audio`);
          await mixClipAudio(doc, o, offset, total, sounds, audioSource, check);
        }
        offset += clipOutDur(o.clip);
      }

      videoSource?.close();
      audioSource?.close();
      onProgress(0.995, 'Finishing file…');
      await output.finalize();
      const mime = fmt === 'webm' ? 'video/webm' : fmt === 'wav' ? 'audio/wav' : 'video/mp4';
      const blob = new Blob([target.buffer!], { type: mime });
      const ext = fmt === 'webm' ? '.webm' : fmt === 'wav' ? '.wav' : '.mp4';
      const note = fmt === 'wav'
        ? 'Audio only, uncompressed WAV.'
        : `${size.w}×${size.h}, ${(vcodec ?? '').toUpperCase()}${acodec ? ' + ' + acodec.toUpperCase() : ', no audio'}.`;
      return { blob, name: base + ext, note };
    } catch (e) {
      if (output && output.state !== 'finalized') { try { await output.cancel(); } catch { /* ignore */ } }
      throw e;
    } finally {
      opened.forEach(o => o.input.dispose());
    }
  })();

  return { cancel: () => { cancelled = true; }, done };
}

function pickQuality(doc: Doc, total: number): Quality {
  const q = doc.output.quality;
  if (q === 'high') return QUALITY_HIGH;
  if (q === 'medium') return QUALITY_MEDIUM;
  if (q === 'small') return QUALITY_LOW;
  if (q === 'custom') return new Quality({ bitrate: Math.round(doc.output.customMbps * 1e6) });
  // 'match': aim for roughly the same bits per second as the source files,
  // so the export doesn't balloon past the originals.
  const bits = doc.clips.reduce((s, c) => s + c.size * 8, 0);
  const secs = doc.clips.reduce((s, c) => s + c.duration, 0) || total;
  const bps = Math.max(600_000, bits / secs * 0.95 - 128_000);
  return new Quality({ bitrate: Math.round(bps) });
}

async function mixClipAudio(
  doc: Doc, o: Opened, offset: number, total: number, sounds: Map<string, AudioBuffer>,
  dest: AudioBufferSource, check: () => void,
) {
  const c = o.clip;
  const len = clipOutDur(c);
  const a = doc.audio;
  const useClip = o.audio && !c.muted && c.volume > 0;
  const sink = useClip ? new AudioBufferSink(o.audio!) : null;
  for (let w0 = 0; w0 < len - 1e-6; w0 += WIN) {
    check();
    const w1 = Math.min(len, w0 + WIN);
    const frames = Math.max(1, Math.round((w1 - w0) * SR));
    const ctx = new OfflineAudioContext(2, frames, SR);

    if (sink) {
      const srcA = c.trimStart + w0 * c.speed, srcB = c.trimStart + w1 * c.speed;
      const gain = ctx.createGain();
      gain.gain.value = c.volume;
      gain.connect(ctx.destination);
      for await (const { buffer, timestamp } of sink.buffers(srcA, srcB)) {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = c.speed;
        node.connect(gain);
        const when = (timestamp - srcA) / c.speed;
        if (when >= 0) node.start(when); else node.start(0, -when * c.speed);
      }
    }

    // Added audio clips that overlap this window (output time g0..g1).
    const g0 = offset + w0, g1 = offset + w1;
    const duck = a.duck && useClip ? 0.35 : 1;
    for (const ac of a.clips) {
      const buf = sounds.get(ac.sourceId);
      if (!buf || ac.volume <= 0) continue;
      const s0 = Math.max(g0, ac.start), s1 = Math.min(g1, ac.start + ac.len);
      if (s1 <= s0) continue;
      let pos = ac.in + (s0 - ac.start);
      let dur = s1 - s0;
      if (ac.loop) pos %= buf.duration;
      else { if (pos >= buf.duration) continue; dur = Math.min(dur, buf.duration - pos); }
      const g = ctx.createGain();
      g.gain.value = ac.volume * duck;
      g.connect(ctx.destination);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.loop = ac.loop;
      node.connect(g);
      node.start(s0 - g0, pos, dur);
    }

    const out = await ctx.startRendering();
    // Fade in/out across the whole output.
    if (a.fadeIn > 0 || a.fadeOut > 0) {
      for (let ch = 0; ch < out.numberOfChannels; ch++) {
        const d = out.getChannelData(ch);
        for (let i = 0; i < d.length; i++) {
          const t = g0 + i / SR;
          let v = 1;
          if (a.fadeIn > 0 && t < a.fadeIn) v = t / a.fadeIn;
          if (a.fadeOut > 0 && total - t < a.fadeOut) v = Math.min(v, Math.max(0, (total - t) / a.fadeOut));
          if (v < 1) d[i] *= v;
        }
      }
    }
    await dest.add(out);
  }
}

async function renderGif(doc: Doc, opened: Opened[], total: number, onProgress: (p: number, m: string) => void, check: () => void) {
  const full = outputSize(doc, 0);
  const w = Math.min(doc.output.gifWidth, full.w) & ~1;
  const h = Math.max(2, Math.round(w * full.h / full.w) & ~1);
  const fps = doc.output.gifFps;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const renderer = createRenderer();
  const gif = GIFEncoder();
  let offset = 0;
  let nextEmit = 0;
  for (const o of opened) {
    const sink = new VideoSampleSink(o.video);
    for await (const sample of sink.samples(o.clip.trimStart, o.clip.trimEnd)) {
      try {
        check();
        const outTs = Math.max(offset, offset + (sample.timestamp - o.clip.trimStart) / o.clip.speed);
        if (outTs < nextEmit - 0.25 / fps) continue;
        nextEmit = Math.max(nextEmit + 1 / fps, outTs + 0.5 / fps);
        const src = { w: sample.displayWidth, h: sample.displayHeight, draw: (c: any, ww: number, hh: number) => sample.draw(c, 0, 0, ww, hh) };
        renderer.render(ctx, w, h, src, o.clip, doc, sample.timestamp, outTs, total);
        const { data } = ctx.getImageData(0, 0, w, h);
        const palette = quantize(data, 256);
        gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / fps) });
        const p = Math.min(0.99, outTs / total);
        onProgress(p, `Making GIF — ${Math.round(p * 100)}%`);
      } finally { sample.close(); }
    }
    offset += clipOutDur(o.clip);
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

/** Turn watermark text into something every OS accepts as a file name. */
function safeFileName(text: string) {
  return text.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80);
}
