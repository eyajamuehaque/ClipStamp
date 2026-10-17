import { useEffect, useRef, useState } from 'react';
import { useStore, currentClip, patchOverlay, patchHide, edit, patchClip } from '../store';
import { video, syncPlayer, videoReady, addVideoFiles } from '../player';
import { createRenderer, type OverlayBounds, type FrameSource } from '../engine/render';
import { outputSize, rotatedDims, toOutputTime, totalDuration, clamp } from '../engine/timeline';
import { cloneSourceRect, hideActiveAt } from '../engine/hide';
import { newHide } from '../defaults';
import type { Rect } from '../types';

const MAX_PREVIEW = 1280;
const CROP_MIN = 0.06;
const HIDE_MIN = 0.01;

type Drag =
  | { kind: 'overlay'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'crop'; clipId: string; handle: string; sx: number; sy: number; rect: Rect }
  | { kind: 'hide'; id: string; handle: string; sx: number; sy: number; rect: Rect }
  | { kind: 'hide-new'; id: string; ax: number; ay: number };

export default function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bounds = useRef<OverlayBounds[]>([]);
  const drag = useRef<Drag | null>(null);
  const hasClips = useStore(s => s.doc.clips.length > 0);
  const stageMode = useStore(s => s.stageMode);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const renderer = createRenderer();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      syncPlayer();
      const canvas = canvasRef.current;
      const s = useStore.getState();
      const clip = currentClip(s);
      if (!canvas || !clip || !videoReady()) return;
      const ctx = canvas.getContext('2d')!;
      const src: FrameSource = { w: video.videoWidth, h: video.videoHeight, draw: (c, w, h) => c.drawImage(video, 0, 0, w, h) };
      const doc = s.doc;

      if (s.stageMode === 'output') {
        const full = outputSize(doc, 0);
        const k = Math.min(1, MAX_PREVIEW / Math.max(full.w, full.h));
        const W = Math.round(full.w * k), H = Math.round(full.h * k);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        const outT = toOutputTime(doc.clips, clip, video.currentTime);
        bounds.current = renderer.render(ctx, W, H, src, clip, doc, video.currentTime, outT, totalDuration(doc.clips));
        const sel = bounds.current.find(b => b.id === s.selectedOverlayId);
        if (sel && !s.playing) drawSelection(ctx, sel);
      } else {
        const rot = rotatedDims(src.w, src.h, clip.rotation);
        const k = Math.min(1, MAX_PREVIEW / Math.max(rot.w, rot.h));
        const f = renderer.drawFrame(src, clip, doc, video.currentTime, k);
        if (canvas.width !== f.width || canvas.height !== f.height) { canvas.width = f.width; canvas.height = f.height; }
        ctx.drawImage(f, 0, 0);
        if (s.stageMode === 'crop') drawCrop(ctx, canvas.width, canvas.height, clip.crop, !!clip.cropLock);
        else drawHides(ctx, canvas.width, canvas.height, video.currentTime);
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------- Pointer interactions ----------
  const toCanvas = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * c.width, y: (e.clientY - r.top) / r.height * c.height, scale: c.width / r.width };
  };

  const onDown = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const c = canvasRef.current!;
    const p = toCanvas(e);
    const W = c.width, H = c.height;
    if (s.stageMode === 'output') {
      const hit = [...bounds.current].reverse().find(b => inBounds(b, p.x, p.y));
      if (!hit) { useStore.setState({ selectedOverlayId: null }); return; }
      const o = s.doc.overlays.find(x => x.id === hit.id)!;
      useStore.setState({ selectedOverlayId: hit.id, tool: o.kind === 'text' ? 'text' : 'logo' });
      drag.current = { kind: 'overlay', id: hit.id, sx: p.x / W, sy: p.y / H, ox: o.x, oy: o.y };
    } else if (s.stageMode === 'crop') {
      const clip = currentClip(s);
      const crop = clip?.crop;
      if (!clip || !crop) return;
      const handle = hitHandles(crop, p.x, p.y, W, H, 16 * p.scale, !!clip.cropLock);
      if (!handle) return;
      drag.current = { kind: 'crop', clipId: clip.id, handle, sx: p.x / W, sy: p.y / H, rect: { ...crop } };
    } else {
      const active = s.doc.hides.find(h => h.id === s.activeHideId);
      let handle = active ? hitHandles(active, p.x, p.y, W, H, 16 * p.scale, false) : null;
      let target = handle ? active! : null;
      if (!target) {
        target = [...s.doc.hides].reverse().find(h => p.x >= h.x * W && p.x <= (h.x + h.w) * W && p.y >= h.y * H && p.y <= (h.y + h.h) * H) ?? null;
        if (target) handle = 'move';
      }
      if (target && handle) {
        useStore.setState({ activeHideId: target.id, selectedSeg: null, tool: 'remove' });
        drag.current = { kind: 'hide', id: target.id, handle, sx: p.x / W, sy: p.y / H, rect: { x: target.x, y: target.y, w: target.w, h: target.h } };
      } else {
        const ax = clamp(p.x / W, 0, 1), ay = clamp(p.y / H, 0, 1);
        const r = newHide(ax, ay, 0, 0, active);
        edit(d => ({ ...d, hides: [...d.hides, r] }));
        useStore.setState({ activeHideId: r.id, selectedSeg: null, tool: 'remove' });
        drag.current = { kind: 'hide-new', id: r.id, ax, ay };
      }
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const c = canvasRef.current;
    if (!d || !c) {
      if (c) c.style.cursor = cursorFor(toCanvas(e));
      return;
    }
    const p = toCanvas(e);
    const nx = p.x / c.width, ny = p.y / c.height;
    if (d.kind === 'overlay') {
      patchOverlay(d.id, { x: clamp(d.ox + nx - d.sx, 0, 1), y: clamp(d.oy + ny - d.sy, 0, 1) }, 'drag-' + d.id);
    } else if (d.kind === 'crop') {
      const dx = nx - d.sx, dy = ny - d.sy;
      const lock = !!useStore.getState().doc.clips.find(x => x.id === d.clipId)?.cropLock;
      const rect = d.handle === 'move' ? moveRect(d.rect, dx, dy)
        : lock ? resizeLocked(d.handle, d.rect, dx) : resizeFree(d.handle, d.rect, dx, dy, CROP_MIN);
      patchClip(d.clipId, { crop: rect }, 'crop-drag');
    } else if (d.kind === 'hide') {
      const dx = nx - d.sx, dy = ny - d.sy;
      const rect = d.handle === 'move' ? moveRect(d.rect, dx, dy) : resizeFree(d.handle, d.rect, dx, dy, HIDE_MIN);
      patchHide(d.id, rect, 'hide-drag');
    } else {
      const cx = clamp(nx, 0, 1), cy = clamp(ny, 0, 1);
      patchHide(d.id, { x: Math.min(d.ax, cx), y: Math.min(d.ay, cy), w: Math.abs(cx - d.ax), h: Math.abs(cy - d.ay) }, 'hide-drag');
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'hide-new') {
      const r = useStore.getState().doc.hides.find(h => h.id === d.id);
      if (r && (r.w < HIDE_MIN * 2 || r.h < HIDE_MIN * 2)) {
        // A click instead of a drag: drop a default-sized box centred there.
        const w = 0.2, h = 0.08;
        patchHide(d.id, { w, h, x: clamp(d.ax - w / 2, 0, 1 - w), y: clamp(d.ay - h / 2, 0, 1 - h) }, 'hide-drag');
      }
    }
  };

  const cursorFor = (p: { x: number; y: number; scale: number }) => {
    const s = useStore.getState();
    const c = canvasRef.current!;
    if (s.stageMode === 'output') return bounds.current.some(b => inBounds(b, p.x, p.y)) ? 'move' : 'default';
    if (s.stageMode === 'crop') {
      const cl = currentClip(s);
      const h = cl?.crop && hitHandles(cl.crop, p.x, p.y, c.width, c.height, 16 * p.scale, !!cl.cropLock);
      return h ? HANDLE_CURSOR[h] : 'default';
    }
    const a = s.doc.hides.find(h => h.id === s.activeHideId);
    const h = a && hitHandles(a, p.x, p.y, c.width, c.height, 16 * p.scale, false);
    return h ? HANDLE_CURSOR[h] : 'crosshair';
  };

  if (!hasClips) {
    return (
      <div className={'drop' + (over ? ' over' : '')}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); addVideoFiles([...e.dataTransfer.files]); }}>
        <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden><rect x="6" y="10" width="36" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M20 18v12l10-6z" fill="currentColor" /></svg>
        <h2>Drop videos to start editing</h2>
        <p>MP4, MOV, WebM or MKV. Pick several to join them into one video. Your files stay on this device — nothing is uploaded.</p>
        <label className="btn primary">
          Choose videos
          <input type="file" accept="video/*" multiple hidden onChange={e => { addVideoFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </label>
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="stage-modes" role="tablist" aria-label="What the preview shows">
        {([['output', 'Final video'], ['crop', 'Crop'], ['hide', 'Logo areas']] as const).map(([m, label]) => (
          <button key={m} role="tab" aria-selected={stageMode === m} className={stageMode === m ? 'on' : ''}
            onClick={() => {
              const cl = currentClip();
              if (m === 'crop' && cl && !cl.crop) patchClip(cl.id, { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, cropLock: null });
              useStore.setState({ stageMode: m, tool: m === 'crop' ? 'adjust' : m === 'hide' ? 'remove' : useStore.getState().tool });
            }}>{label}</button>
        ))}
      </div>
      <div className="canvas-box"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); addVideoFiles([...e.dataTransfer.files]); }}>
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
      {stageMode === 'hide' && <p className="stage-hint">Drag a box over the old logo. Make it a little bigger than the logo so its shadow is covered too.</p>}
      {stageMode === 'crop' && <p className="stage-hint">Drag inside the box to move it, or drag a corner to resize. This crop only changes the selected clip.</p>}
    </div>
  );
}

// ---------- drawing helpers ----------
const ACCENT = '#f2c14e';
const HANDLE_CURSOR: Record<string, string> = { move: 'move', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function inBounds(b: OverlayBounds, x: number, y: number) {
  const dx = x - b.cx, dy = y - b.cy;
  const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= b.w / 2 + 6 && Math.abs(ly) <= b.h / 2 + 6;
}

function drawSelection(ctx: CanvasRenderingContext2D, b: OverlayBounds) {
  ctx.save();
  ctx.translate(b.cx, b.cy);
  ctx.rotate(b.rot);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(-b.w / 2 - 4, -b.h / 2 - 4, b.w + 8, b.h + 8);
  ctx.restore();
}

function handlePoints(r: Rect, W: number, H: number, edges: boolean) {
  const x0 = r.x * W, y0 = r.y * H, x1 = (r.x + r.w) * W, y1 = (r.y + r.h) * H, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const pts: Record<string, [number, number]> = { nw: [x0, y0], ne: [x1, y0], se: [x1, y1], sw: [x0, y1] };
  if (edges) Object.assign(pts, { n: [mx, y0], s: [mx, y1], w: [x0, my], e: [x1, my] });
  return pts;
}

function hitHandles(r: Rect, x: number, y: number, W: number, H: number, rad: number, locked: boolean) {
  const pts = handlePoints(r, W, H, !locked);
  for (const k in pts) if (Math.abs(x - pts[k][0]) <= rad && Math.abs(y - pts[k][1]) <= rad) return k;
  if (x >= r.x * W && x <= (r.x + r.w) * W && y >= r.y * H && y <= (r.y + r.h) * H) return 'move';
  return null;
}

function drawHandles(ctx: CanvasRenderingContext2D, r: Rect, W: number, H: number, edges: boolean) {
  const hs = Math.max(9, Math.min(W, H) * 0.016);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.lineWidth = 1;
  for (const [x, y] of Object.values(handlePoints(r, W, H, edges))) {
    ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
    ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
  }
}

function drawCrop(ctx: CanvasRenderingContext2D, W: number, H: number, crop: Rect | null, locked: boolean) {
  if (!crop) return;
  const x = crop.x * W, y = crop.y * H, w = crop.w * W, h = crop.h * H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(x, y, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fill('evenodd');
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + w * i / 3, y); ctx.lineTo(x + w * i / 3, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + h * i / 3); ctx.lineTo(x + w, y + h * i / 3); ctx.stroke();
  }
  drawHandles(ctx, crop, W, H, !locked);
  ctx.restore();
}

function drawHides(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const s = useStore.getState();
  const lw = Math.max(2, Math.min(W, H) * 0.003);
  const fs = Math.max(12, Math.round(Math.min(W, H) * 0.022));
  ctx.save();
  s.doc.hides.forEach((r, i) => {
    const active = r.id === s.activeHideId;
    const on = hideActiveAt(r, t);
    ctx.globalAlpha = on ? 1 : 0.45;
    if (active && r.mode === 'clone' && on) {
      const cs = cloneSourceRect(r, W, H);
      if (cs) {
        ctx.setLineDash([lw * 3, lw * 3]);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = Math.max(1, lw * 0.75);
        ctx.strokeRect(cs.x, cs.y, cs.w, cs.h);
      }
    }
    ctx.setLineDash(active ? [] : [lw * 4, lw * 3]);
    ctx.strokeStyle = active ? ACCENT : 'rgba(242,193,78,.6)';
    ctx.lineWidth = lw;
    const x = r.x * W, y = r.y * H, w = r.w * W, h = r.h * H;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    const label = 'Area ' + (i + 1) + (on ? '' : ' (off here)');
    ctx.font = `600 ${fs}px "Bricolage Grotesque Variable", sans-serif`;
    const tw = ctx.measureText(label).width + fs * 0.7, th = fs * 1.4;
    const ty = y >= th + lw ? y - th - lw / 2 : y + h + lw / 2;
    ctx.fillStyle = active ? ACCENT : 'rgba(242,193,78,.6)';
    ctx.fillRect(x, ty, tw, th);
    ctx.fillStyle = '#1a1d24';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + fs * 0.35, ty + th / 2);
    if (active) drawHandles(ctx, r, W, H, true);
  });
  ctx.restore();
}

// ---------- rect math (normalized 0..1) ----------
function moveRect(r: Rect, dx: number, dy: number): Rect {
  return { x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h), w: r.w, h: r.h };
}

function resizeFree(handle: string, r: Rect, dx: number, dy: number, min: number): Rect {
  let x = r.x, y = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (handle.includes('w')) x = clamp(r.x + dx, 0, x2 - min);
  if (handle.includes('e')) x2 = clamp(x2 + dx, x + min, 1);
  if (handle.includes('n')) y = clamp(r.y + dy, 0, y2 - min);
  if (handle.includes('s')) y2 = clamp(y2 + dy, y + min, 1);
  return { x, y, w: x2 - x, h: y2 - y };
}

function resizeLocked(handle: string, r: Rect, dx: number): Rect {
  const right = handle.includes('e'), down = handle.includes('s');
  const ax = right ? r.x : r.x + r.w, ay = down ? r.y : r.y + r.h;
  const desired = right ? r.w + dx : r.w - dx;
  const maxByX = right ? 1 - ax : ax;
  const maxByY = (down ? 1 - ay : ay) * (r.w / r.h);
  const sMax = Math.min(maxByX, maxByY) / r.w;
  const sMin = CROP_MIN / Math.min(r.w, r.h);
  const s = clamp(desired / r.w, sMin, Math.max(sMin, sMax));
  const w = r.w * s, h = r.h * s;
  return { x: right ? ax : ax - w, y: down ? ay : ay - h, w, h };
}
