// "Remove logo" — covers an area of the source frame. Ported from the original Stamp tool.
//   fill     — push-pull inpainting: rebuild the hole from its surroundings, then add matched grain
//   clone    — copy a neighbouring patch with feathered edges (keeps real texture and motion)
//   blur     — soft blur with feathered edges
//   pixelate — mosaic, for censoring faces, plates, screens
import type { HideRegion, Rect } from '../types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function hideActiveAt(r: HideRegion, t: number | null) {
  if (t == null) return true;
  return r.segments.some(s => t >= s.start && t < s.end);
}

interface Geo {
  rx0: number; ry0: number; rx1: number; ry1: number;
  ax0: number; ay0: number; aw: number; ah: number;
  F: number; blurR: number; ox: number; oy: number; fitsFrame: boolean;
}

// Auto clone-side choice is cached per region + geometry so it doesn't flicker frame to frame.
const autoPick = new Map<string, { key: string; side: string | null }>();

export function hideGeometry(r: HideRegion, box: Rect, cw: number, ch: number, sideOverride?: string): Geo | null {
  const bx0 = Math.max(0, Math.ceil(box.x)), by0 = Math.max(0, Math.ceil(box.y));
  const bx1 = Math.min(cw, Math.floor(box.x + box.w)), by1 = Math.min(ch, Math.floor(box.y + box.h));
  if (bx1 - bx0 < 4 || by1 - by0 < 4) return null;
  const rx0 = clamp(Math.round(box.x + r.x * box.w), bx0, bx1);
  const ry0 = clamp(Math.round(box.y + r.y * box.h), by0, by1);
  const rx1 = clamp(Math.round(box.x + (r.x + r.w) * box.w), bx0, bx1);
  const ry1 = clamp(Math.round(box.y + (r.y + r.h) * box.h), by0, by1);
  if (rx1 - rx0 < 2 || ry1 - ry0 < 2) return null;
  // Slider values are "pixels at 1080p", scaled to the size this frame is drawn at.
  const unit = Math.max(0.25, Math.min(box.w, box.h) / 1080);
  const F = r.mode === 'fill' || r.mode === 'pixelate' ? 0 : Math.round((r.feather || 0) * unit);
  const blurR = Math.max(1, Math.round((r.blur || 14) * unit));
  let M: number;
  if (r.mode === 'fill') M = Math.max(6, Math.round(12 * unit));
  else if (r.mode === 'blur') M = Math.max(F, blurR * 2, 2);
  else if (r.mode === 'pixelate') M = 0;
  else M = Math.max(F, 1);
  const ax0 = Math.max(bx0, rx0 - M), ay0 = Math.max(by0, ry0 - M);
  const ax1 = Math.min(bx1, rx1 + M), ay1 = Math.min(by1, ry1 + M);
  const aw = ax1 - ax0, ah = ay1 - ay0;
  let ox = 0, oy = 0, fitsFrame = true;
  if (r.mode === 'clone') {
    const rw = rx1 - rx0, rh = ry1 - ry0;
    const opts: Record<string, [number, number]> = { above: [0, -(rh + F)], below: [0, rh + F], left: [-(rw + F), 0], right: [rw + F, 0] };
    const fits = ([dx, dy]: [number, number]) => ax0 + dx >= bx0 && ax1 + dx <= bx1 && ay0 + dy >= by0 && ay1 + dy <= by1;
    const dist = ([dx, dy]: [number, number]) => Math.abs(dx) + Math.abs(dy);
    const side = sideOverride || (r.cloneFrom !== 'auto' ? r.cloneFrom : autoPick.get(r.id)?.side);
    let pick = side ? opts[side] : null;
    if (!pick) {
      const all = ['left', 'right', 'above', 'below'].map(k => opts[k]);
      const fitting = all.filter(fits);
      pick = fitting[0] || all.sort((a, b) => dist(a) - dist(b))[0];
    }
    fitsFrame = fits(pick);
    ox = clamp(ax0 + pick[0], bx0, bx1 - aw) - ax0;
    oy = clamp(ay0 + pick[1], by0, by1 - ah) - ay0;
  }
  return { rx0, ry0, rx1, ry1, ax0, ay0, aw, ah, F, blurR, ox, oy, fitsFrame };
}

let patch: OffscreenCanvas | null = null;
let patchCtx: OffscreenCanvasRenderingContext2D | null = null;
function getPatch(w: number, h: number) {
  if (!patch) { patch = new OffscreenCanvas(w, h); patchCtx = patch.getContext('2d', { willReadFrequently: true })!; }
  if (patch.width !== w || patch.height !== h) { patch.width = w; patch.height = h; }
  return patchCtx!;
}

function chooseCloneSide(target: Ctx2D, r: HideRegion, box: Rect, cw: number, ch: number) {
  const geos = ['left', 'right', 'above', 'below']
    .map(side => ({ side, g: hideGeometry(r, box, cw, ch, side) }))
    .filter((o): o is { side: string; g: Geo } => !!o.g);
  if (!geos.length) return null;
  const fitting = geos.filter(o => o.g.fitsFrame);
  const cands = fitting.length ? fitting : geos;
  if (cands.length === 1) return cands[0].side;
  const g0 = cands[0].g;
  const band = Math.max(3, g0.F);
  const hx0 = g0.rx0 - g0.ax0, hy0 = g0.ry0 - g0.ay0, hx1 = g0.rx1 - g0.ax0, hy1 = g0.ry1 - g0.ay0;
  const read = (ox: number, oy: number) => {
    const p = getPatch(g0.aw, g0.ah);
    p.clearRect(0, 0, g0.aw, g0.ah);
    p.drawImage(target.canvas, g0.ax0 + ox, g0.ay0 + oy, g0.aw, g0.ah, 0, 0, g0.aw, g0.ah);
    return p.getImageData(0, 0, g0.aw, g0.ah).data;
  };
  const dest = read(0, 0);
  let best = cands[0].side, bestScore = Infinity;
  for (const { side, g } of cands) {
    const src = read(g.ox, g.oy);
    let sum = 0, count = 0;
    for (let y = 0; y < g0.ah; y++) {
      const dy = y < hy0 ? hy0 - y : (y >= hy1 ? y - hy1 + 1 : 0);
      for (let x = 0; x < g0.aw; x++) {
        const dx = x < hx0 ? hx0 - x : (x >= hx1 ? x - hx1 + 1 : 0);
        if ((dx === 0 && dy === 0) || dx > band || dy > band) continue;
        const p = (y * g0.aw + x) * 4;
        sum += Math.abs(dest[p] - src[p]) + Math.abs(dest[p + 1] - src[p + 1]) + Math.abs(dest[p + 2] - src[p + 2]);
        count++;
      }
    }
    const score = count ? sum / count : Infinity;
    if (score < bestScore) { bestScore = score; best = side; }
  }
  return best;
}

export function applyHideRegions(target: Ctx2D, box: Rect, t: number | null, regions: HideRegion[]) {
  if (!regions.length) return;
  const cw = target.canvas.width, ch = target.canvas.height;
  for (const r of regions) {
    if (!hideActiveAt(r, t)) continue;
    if (r.mode === 'clone' && r.cloneFrom === 'auto') {
      const key = [r.x, r.y, r.w, r.h, r.feather, Math.round(box.w)].map(v => (+v).toFixed(4)).join(',');
      if (autoPick.get(r.id)?.key !== key) autoPick.set(r.id, { key, side: chooseCloneSide(target, r, box, cw, ch) });
    }
    const g = hideGeometry(r, box, cw, ch);
    if (!g || g.aw < 2 || g.ah < 2) continue;
    const p = getPatch(g.aw, g.ah);
    p.clearRect(0, 0, g.aw, g.ah);
    p.drawImage(target.canvas, g.ax0 + g.ox, g.ay0 + g.oy, g.aw, g.ah, 0, 0, g.aw, g.ah);
    const img = p.getImageData(0, 0, g.aw, g.ah);
    const d = img.data;
    const hx0 = g.rx0 - g.ax0, hy0 = g.ry0 - g.ay0, hx1 = g.rx1 - g.ax0, hy1 = g.ry1 - g.ay0;
    if (r.mode === 'fill') pushPullFill(d, g.aw, g.ah, hx0, hy0, hx1, hy1, (r.grain ?? 60) / 100);
    else if (r.mode === 'blur') boxBlurRGB(d, g.aw, g.ah, g.blurR);
    else if (r.mode === 'pixelate') pixelate(d, g.aw, g.ah, Math.max(4, g.blurR));
    applyHideAlpha(d, g.aw, g.ah, hx0, hy0, hx1, hy1, g.F);
    p.putImageData(img, 0, 0);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
    target.filter = 'none';
    target.drawImage(patch!, g.ax0, g.ay0);
    target.restore();
  }
}

/** Where a clone area copies from (for drawing the dashed preview box). */
export function cloneSourceRect(r: HideRegion, w: number, h: number) {
  const g = hideGeometry(r, { x: 0, y: 0, w, h }, w, h);
  if (!g) return null;
  return { x: g.rx0 + g.ox, y: g.ry0 + g.oy, w: g.rx1 - g.rx0, h: g.ry1 - g.ry0 };
}

function applyHideAlpha(d: Uint8ClampedArray, W: number, H: number, hx0: number, hy0: number, hx1: number, hy1: number, F: number) {
  for (let y = 0; y < H; y++) {
    const cy = y + 0.5;
    const dy = cy < hy0 ? hy0 - cy : (cy > hy1 ? cy - hy1 : 0);
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5;
      const dx = cx < hx0 ? hx0 - cx : (cx > hx1 ? cx - hx1 : 0);
      let a: number;
      if (dx === 0 && dy === 0) a = 1;
      else if (F <= 0) a = 0;
      else {
        const t = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / F);
        a = t * t * (3 - 2 * t);
      }
      d[(y * W + x) * 4 + 3] = Math.round(a * 255);
    }
  }
}

function pushPullFill(d: Uint8ClampedArray, W: number, H: number, hx0: number, hy0: number, hx1: number, hy1: number, grain: number) {
  const n = W * H;
  const c0 = new Float32Array(n * 3), w0 = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const inY = y >= hy0 && y < hy1;
    for (let x = 0; x < W; x++) {
      if (inY && x >= hx0 && x < hx1) continue;
      const i = y * W + x, p = i * 4;
      c0[i * 3] = d[p]; c0[i * 3 + 1] = d[p + 1]; c0[i * 3 + 2] = d[p + 2];
      w0[i] = 1;
    }
  }
  let diffSum = 0, diffCount = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (!w0[i] || !w0[i + 1]) continue;
      const l1 = 0.299 * c0[i * 3] + 0.587 * c0[i * 3 + 1] + 0.114 * c0[i * 3 + 2];
      const l2 = 0.299 * c0[i * 3 + 3] + 0.587 * c0[i * 3 + 4] + 0.114 * c0[i * 3 + 5];
      diffSum += Math.abs(l1 - l2);
      diffCount++;
    }
  }
  type Level = { W: number; H: number; c: Float32Array; w: Float32Array };
  const levels: Level[] = [{ W, H, c: c0, w: w0 }];
  for (;;) {
    const f = levels[levels.length - 1];
    if (f.W === 1 && f.H === 1) break;
    const nW = Math.ceil(f.W / 2), nH = Math.ceil(f.H / 2);
    const c = new Float32Array(nW * nH * 3), w = new Float32Array(nW * nH);
    for (let y = 0; y < nH; y++) {
      for (let x = 0; x < nW; x++) {
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let dy = 0; dy < 2; dy++) {
          const fy = y * 2 + dy;
          if (fy >= f.H) break;
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx;
            if (fx >= f.W) break;
            const fi = fy * f.W + fx, ww = f.w[fi];
            if (ww > 0) { sw += ww; sr += ww * f.c[fi * 3]; sg += ww * f.c[fi * 3 + 1]; sb += ww * f.c[fi * 3 + 2]; }
          }
        }
        if (sw > 0) {
          const i = y * nW + x;
          c[i * 3] = sr / sw; c[i * 3 + 1] = sg / sw; c[i * 3 + 2] = sb / sw;
          w[i] = Math.min(1, sw);
        }
      }
    }
    levels.push({ W: nW, H: nH, c, w });
  }
  const top = levels[levels.length - 1];
  if (top.w[0] <= 0) { top.c[0] = top.c[1] = top.c[2] = 128; }
  top.w[0] = 1;
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], co = levels[l + 1];
    for (let y = 0; y < f.H; y++) {
      const gy = clamp((y + 0.5) / 2 - 0.5, 0, co.H - 1);
      const y0 = Math.floor(gy), y1 = Math.min(co.H - 1, y0 + 1), ty = gy - y0;
      for (let x = 0; x < f.W; x++) {
        const i = y * f.W + x, ww = f.w[i];
        if (ww >= 1) continue;
        const gx = clamp((x + 0.5) / 2 - 0.5, 0, co.W - 1);
        const x0 = Math.floor(gx), x1 = Math.min(co.W - 1, x0 + 1), tx = gx - x0;
        const a = (y0 * co.W + x0) * 3, b = (y0 * co.W + x1) * 3;
        const e = (y1 * co.W + x0) * 3, h = (y1 * co.W + x1) * 3;
        for (let k = 0; k < 3; k++) {
          const t0 = co.c[a + k] + (co.c[b + k] - co.c[a + k]) * tx;
          const t1 = co.c[e + k] + (co.c[h + k] - co.c[e + k]) * tx;
          f.c[i * 3 + k] = ww * f.c[i * 3 + k] + (1 - ww) * (t0 + (t1 - t0) * ty);
        }
        f.w[i] = 1;
      }
    }
  }
  const sigma = diffCount ? Math.min(9, 0.886 * diffSum / diffCount) : 0;
  const amp = sigma * grain;
  for (let y = hy0; y < hy1; y++) {
    for (let x = hx0; x < hx1; x++) {
      const i = y * W + x, p = i * 4;
      const nz = amp ? (Math.random() + Math.random() + Math.random() - 1.5) * 2 * amp : 0;
      d[p] = c0[i * 3] + nz; d[p + 1] = c0[i * 3 + 1] + nz; d[p + 2] = c0[i * 3 + 2] + nz;
    }
  }
}

function boxBlurRGB(d: Uint8ClampedArray, W: number, H: number, r: number) {
  const n = W * H;
  const a = new Float32Array(n * 3), b = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = d[i * 4]; a[i * 3 + 1] = d[i * 4 + 1]; a[i * 3 + 2] = d[i * 4 + 2]; }
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += a[(row + clamp(j, 0, W - 1)) * 3 + k];
        for (let x = 0; x < W; x++) {
          b[(row + x) * 3 + k] = s * norm;
          s += a[(row + Math.min(W - 1, x + r + 1)) * 3 + k] - a[(row + Math.max(0, x - r)) * 3 + k];
        }
      }
    }
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += b[(clamp(j, 0, H - 1) * W + x) * 3 + k];
        for (let y = 0; y < H; y++) {
          a[(y * W + x) * 3 + k] = s * norm;
          s += b[(Math.min(H - 1, y + r + 1) * W + x) * 3 + k] - b[(Math.max(0, y - r) * W + x) * 3 + k];
        }
      }
    }
  }
  for (let i = 0; i < n; i++) { d[i * 4] = a[i * 3]; d[i * 4 + 1] = a[i * 3 + 1]; d[i * 4 + 2] = a[i * 3 + 2]; }
}

function pixelate(d: Uint8ClampedArray, W: number, H: number, block: number) {
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      let r = 0, g = 0, b = 0, n = 0;
      const ey = Math.min(H, by + block), ex = Math.min(W, bx + block);
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const p = (y * W + x) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
      }
      r /= n; g /= n; b /= n;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const p = (y * W + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b;
      }
    }
  }
}
