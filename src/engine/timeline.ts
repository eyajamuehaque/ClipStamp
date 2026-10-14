import type { CanvasAspect, Clip, Doc, Rotation } from '../types';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const clipOutDur = (c: Clip) => Math.max(0, c.trimEnd - c.trimStart) / c.speed;
export const totalDuration = (clips: Clip[]) => clips.reduce((s, c) => s + clipOutDur(c), 0);

export function clipOffset(clips: Clip[], id: string) {
  let t = 0;
  for (const c of clips) { if (c.id === id) return t; t += clipOutDur(c); }
  return t;
}

/** Output-timeline seconds for a source time inside a clip. */
export function toOutputTime(clips: Clip[], clip: Clip, srcTime: number) {
  return clipOffset(clips, clip.id) + (srcTime - clip.trimStart) / clip.speed;
}

/** Which clip (and source time) a point on the output timeline falls in. */
export function fromOutputTime(clips: Clip[], t: number): { clip: Clip; src: number } | null {
  let acc = 0;
  for (const c of clips) {
    const d = clipOutDur(c);
    if (t < acc + d || c === clips[clips.length - 1]) {
      return { clip: c, src: clamp(c.trimStart + (t - acc) * c.speed, c.trimStart, c.trimEnd) };
    }
    acc += d;
  }
  return null;
}

export const rotatedDims = (w: number, h: number, r: Rotation) =>
  r === 90 || r === 270 ? { w: h, h: w } : { w, h };

const ASPECTS: Record<Exclude<CanvasAspect, 'source'>, number> = {
  '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '21:9': 21 / 9,
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output frame size, derived from the first clip: rotate → crop → canvas shape → resolution.
 * Every other clip is fitted inside this frame.
 */
export function outputSize(doc: Doc, resolution = doc.output.resolution) {
  const ref = doc.clips[0];
  if (!ref) return { w: 1280, h: 720 };
  const rd = rotatedDims(ref.width, ref.height, ref.rotation);
  const crop = doc.framing.crop;
  let w = crop ? rd.w * crop.w : rd.w;
  let h = crop ? rd.h * crop.h : rd.h;
  if (doc.framing.aspect !== 'source') {
    const r = ASPECTS[doc.framing.aspect];
    if (w / h > r) h = w / r; else w = h * r;
  }
  if (resolution) {
    const s = resolution / Math.min(w, h);
    w *= s; h *= s;
  }
  return { w: even(w), h: even(h) };
}

export function fmtClock(sec: number, tenths = false) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + ss;
}

export function fmtBytes(b: number) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
