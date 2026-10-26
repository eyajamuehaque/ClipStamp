// One frame-rendering pipeline shared by the live preview, snapshots and every export format,
// so what you see is exactly what you get.
//
//   source ─► rotate/flip + color filter ─► remove-logo areas ─► crop ─► fit into output canvas
//          ─► background fill ─► temperature/vignette ─► text + logo overlays ─► fade to black
import type { Clip, ColorSettings, Doc, ImageOverlay, Overlay, TextOverlay } from '../types';
import { FONTS } from '../defaults';
import { applyHideRegions } from './hide';
import { rotatedDims, clamp } from './timeline';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Something that can paint a video frame at its display size (a <video>, or a decoded sample). */
export interface FrameSource { w: number; h: number; draw(ctx: Ctx2D, w: number, h: number): void }

export interface OverlayBounds { id: string; cx: number; cy: number; w: number; h: number; rot: number }

export function cssFilter(c: ColorSettings, unit: number) {
  const parts: string[] = [];
  if (c.brightness !== 100) parts.push(`brightness(${c.brightness}%)`);
  if (c.contrast !== 100) parts.push(`contrast(${c.contrast}%)`);
  if (c.saturation !== 100) parts.push(`saturate(${c.saturation}%)`);
  if (c.hue) parts.push(`hue-rotate(${c.hue}deg)`);
  if (c.grayscale) parts.push(`grayscale(${c.grayscale}%)`);
  if (c.sepia) parts.push(`sepia(${c.sepia}%)`);
  if (c.blur) parts.push(`blur(${(c.blur * unit).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// ---- Image cache for logo overlays ----
const images = new Map<string, HTMLImageElement>();
export function getImage(o: ImageOverlay): HTMLImageElement | null {
  let img = images.get(o.dataUrl);
  if (!img) { img = new Image(); img.src = o.dataUrl; images.set(o.dataUrl, img); }
  return img.complete && img.naturalWidth ? img : null;
}
export async function preloadImages(overlays: Overlay[]) {
  await Promise.all(overlays.filter((o): o is ImageOverlay => o.kind === 'image').map(async o => {
    getImage(o);
    try { await images.get(o.dataUrl)!.decode(); } catch { /* broken image is skipped */ }
  }));
}
export async function preloadFonts(overlays: Overlay[]) {
  await Promise.all(overlays.filter((o): o is TextOverlay => o.kind === 'text').map(o => {
    const f = FONTS[o.font] ?? FONTS.anton;
    return document.fonts.load(`${f.weight} 40px ${f.css}`).catch(() => {});
  }));
}

/** A renderer owns its scratch canvases so preview and export never fight over them. */
export function createRenderer() {
  let frame: OffscreenCanvas | null = null;
  let fctx: OffscreenCanvasRenderingContext2D | null = null;

  /** Draw the rotated, flipped, colour-graded source with remove-logo applied. Returns the frame canvas. */
  function drawFrame(src: FrameSource, clip: Clip, doc: Doc, srcTime: number, scale: number) {
    const rot = rotatedDims(src.w, src.h, clip.rotation);
    const FW = Math.max(2, Math.round(rot.w * scale)), FH = Math.max(2, Math.round(rot.h * scale));
    const NW = src.w * scale, NH = src.h * scale;
    if (!frame) { frame = new OffscreenCanvas(FW, FH); fctx = frame.getContext('2d', { willReadFrequently: false })!; }
    if (frame.width !== FW || frame.height !== FH) { frame.width = FW; frame.height = FH; }
    const c = fctx!;
    c.save();
    c.fillStyle = '#000';
    c.fillRect(0, 0, FW, FH);
    c.filter = cssFilter(doc.color, Math.min(FW, FH) / 1080);
    switch (clip.rotation) {
      case 90: c.translate(FW, 0); c.rotate(Math.PI / 2); break;
      case 180: c.translate(FW, FH); c.rotate(Math.PI); break;
      case 270: c.translate(0, FH); c.rotate(-Math.PI / 2); break;
    }
    c.translate(doc.framing.flipH ? NW : 0, doc.framing.flipV ? NH : 0);
    c.scale(doc.framing.flipH ? -1 : 1, doc.framing.flipV ? -1 : 1);
    src.draw(c, NW, NH);
    c.restore();
    if (doc.hidesEnabled) applyHideRegions(c, { x: 0, y: 0, w: FW, h: FH }, srcTime, doc.hides);
    return frame;
  }

  /**
   * Render a finished output frame.
   * outTime is on the output timeline (drives overlays and fades); total is the output length.
   */
  function render(
    out: Ctx2D, W: number, H: number, src: FrameSource, clip: Clip, doc: Doc,
    srcTime: number, outTime: number, total: number,
  ): OverlayBounds[] {
    const rot = rotatedDims(src.w, src.h, clip.rotation);
    const crop = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    // Only decode/process as many pixels as the output actually needs.
    const scale = Math.min(1, Math.max(W / (rot.w * crop.w), H / (rot.h * crop.h)) * 1.02);
    const f = drawFrame(src, clip, doc, srcTime, scale);
    const sx = crop.x * f.width, sy = crop.y * f.height, sw = crop.w * f.width, sh = crop.h * f.height;
    const k = Math.min(W / sw, H / sh);
    const dw = sw * k, dh = sh * k, dx = (W - dw) / 2, dy = (H - dh) / 2;
    const unit = Math.min(W, H) / 1080;

    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
    out.filter = 'none';
    const letterboxed = dw < W - 1 || dh < H - 1;
    if (letterboxed && doc.framing.bg === 'blur') {
      const kc = Math.max(W / sw, H / sh);
      out.filter = `blur(${Math.round(28 * unit)}px) brightness(0.7)`;
      out.drawImage(f, sx, sy, sw, sh, (W - sw * kc) / 2 - 20, (H - sh * kc) / 2 - 20, sw * kc + 40, sh * kc + 40);
      out.filter = 'none';
    } else {
      out.fillStyle = letterboxed && doc.framing.bg === 'color' ? doc.framing.bgColor : '#000';
      out.fillRect(0, 0, W, H);
    }
    out.imageSmoothingQuality = 'high';
    out.drawImage(f, sx, sy, sw, sh, dx, dy, dw, dh);

    const col = doc.color;
    if (col.temperature) {
      out.globalCompositeOperation = 'soft-light';
      out.globalAlpha = Math.abs(col.temperature) / 100 * 0.55;
      out.fillStyle = col.temperature > 0 ? '#ff8a1f' : '#2f8bff';
      out.fillRect(dx, dy, dw, dh);
      out.globalCompositeOperation = 'source-over';
      out.globalAlpha = 1;
    }
    if (col.vignette) {
      const cx = dx + dw / 2, cy = dy + dh / 2, r = Math.hypot(dw, dh) / 2;
      const g = out.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(col.vignette / 100) * 0.85})`);
      out.fillStyle = g;
      out.fillRect(dx, dy, dw, dh);
    }

    const bounds: OverlayBounds[] = [];
    if (doc.overlaysEnabled) {
      for (const o of doc.overlays) {
        const b = o.kind === 'text' ? drawText(out, o, W, H, outTime) : drawImage(out, o, W, H, outTime);
        if (b) bounds.push(b);
      }
    }

    const a = doc.audio;
    if (a.videoFade && (a.fadeIn > 0 || a.fadeOut > 0)) {
      let v = 1;
      if (a.fadeIn > 0) v = Math.min(v, outTime / a.fadeIn);
      if (a.fadeOut > 0) v = Math.min(v, (total - outTime) / a.fadeOut);
      v = clamp(v, 0, 1);
      if (v < 1) { out.globalAlpha = 1 - v; out.fillStyle = '#000'; out.fillRect(0, 0, W, H); }
    }
    out.restore();
    return bounds;
  }

  return { render, drawFrame };
}

// ---------------- Overlays ----------------
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeBack = (p: number) => { const c = 1.7; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

function ping(t: number, period: number) {
  if (!period || period <= 0) return 0;
  const phase = ((t % period) + period) % period / period;
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

function entranceState(entrance: string, t: number, start: number) {
  const p = clamp((t - start) / 0.6, 0, 1);
  return {
    alpha: entrance === 'fade' || entrance === 'slide' ? easeOut(p) : entrance === 'pop' ? Math.min(1, p * 2) : 1,
    shift: entrance === 'slide' ? (1 - easeOut(p)) : 0,
    scale: entrance === 'pop' ? 0.5 + 0.5 * easeBack(p) : 1,
  };
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawText(ctx: Ctx2D, o: TextOverlay, W: number, H: number, t: number): OverlayBounds | null {
  if (t < o.start || t >= o.end) return null;
  let text = o.text;
  if (o.entrance === 'typewriter') text = text.slice(0, Math.max(0, Math.floor((t - o.start) * 22)));
  const unit = Math.min(W, H) / 1080;
  const f = FONTS[o.font] ?? FONTS.anton;
  const px = o.size * unit;
  ctx.save();
  ctx.font = `${f.weight} ${px}px ${f.css}`;
  const lines = o.text.split('\n');
  const shown = text.split('\n');
  const lh = px * 1.15;
  const widths = lines.map(l => ctx.measureText(l).width);
  const tw = Math.max(1, ...widths);
  const th = lh * lines.length;
  const pad = o.box ? px * 0.35 : px * 0.1;
  const bw = tw + pad * 2, bh = th + pad * 2;

  const rad = o.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const mx = Math.min(0.45, Math.max(0.04, (bw / 2 * cos + bh / 2 * sin) / W));
  const my = Math.min(0.45, Math.max(0.04, (bw / 2 * sin + bh / 2 * cos) / H));
  let x = o.x, y = o.y;
  const lt = t - o.start;
  if (o.motion === 'horizontal') x = mx + ping(lt, o.speed) * (1 - 2 * mx);
  else if (o.motion === 'vertical') y = my + ping(lt, o.speed) * (1 - 2 * my);
  else if (o.motion === 'bounce') { x = mx + ping(lt, o.speed) * (1 - 2 * mx); y = my + ping(lt, o.speed * 0.77) * (1 - 2 * my); }

  const e = entranceState(o.entrance, t, o.start);
  const cx = x * W, cy = y * H + e.shift * px * 0.9;
  // Whole-pixel positions keep edges crisp, and moving text shifts by exact pixels,
  // which the encoder can copy between frames instead of re-coding it blurrily.
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.rotate(rad);
  ctx.scale(e.scale, e.scale);
  ctx.globalAlpha = (o.opacity / 100) * e.alpha;
  if (o.box) {
    ctx.fillStyle = hexA(o.boxColor, o.boxOpacity / 100);
    const r = Math.min(bh / 2, px * 0.25);
    ctx.beginPath();
    ctx.roundRect(-bw / 2, -bh / 2, bw, bh, r);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = o.align;
  const ax = o.align === 'left' ? -tw / 2 : o.align === 'right' ? tw / 2 : 0;
  if (o.shadow && !o.box) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = Math.max(2, px * 0.1); ctx.shadowOffsetY = px * 0.03; }
  shown.forEach((line, i) => {
    const ly = -th / 2 + lh * i + lh / 2;
    if (o.outline > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = o.outline * unit * 2;
      ctx.strokeStyle = o.outlineColor;
      ctx.strokeText(line, ax, ly);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = o.color;
    ctx.fillText(line, ax, ly);
  });
  ctx.restore();
  return { id: o.id, cx, cy, w: bw, h: bh, rot: rad };
}

function drawImage(ctx: Ctx2D, o: ImageOverlay, W: number, H: number, t: number): OverlayBounds | null {
  if (t < o.start || t >= o.end) return null;
  const img = getImage(o);
  const w = o.width * W, h = w / o.aspect;
  const e = entranceState(o.entrance, t, o.start);
  const cx = o.x * W, cy = o.y * H + e.shift * h * 0.3, rad = o.rotation * Math.PI / 180;
  if (img) {
    ctx.save();
    ctx.translate(Math.round(cx), Math.round(cy));
    ctx.rotate(rad);
    ctx.scale(e.scale, e.scale);
    ctx.globalAlpha = (o.opacity / 100) * e.alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const rw = Math.round(w), rh = Math.round(h);
    ctx.drawImage(img, -Math.round(rw / 2), -Math.round(rh / 2), rw, rh);
    ctx.restore();
  }
  return { id: o.id, cx, cy, w, h, rot: rad };
}
