import { useState } from 'react';
import { useStore, useCurrentClip, patchClip, patchOverlay, patchHide, patchDoc, patchAudioClip, removeAudioClip, edit, notify } from '../store';
import { Section, Slider, Seg, Toggle, Field, ColorInput, Note } from './ui';
import { FONTS, COLOR_PRESETS, DEFAULT_COLOR, newText, newImage, newHide, uid, emptyDoc } from '../defaults';
import { readImage, probeAudio, download } from '../engine/media';
import { clipOutDur, fmtClock, fmtBytes, outputSize, totalDuration, clamp } from '../engine/timeline';
import { startExport, ExportCanceled, type ExportJob } from '../engine/export';
import { projectToJson, applyProjectJson, clearProject } from '../engine/persist';
import { addVideoFiles, video, seek, outputNow } from '../player';
import { FULL_END } from '../types';
import type { AudioClip, AudioSource, Rect, CanvasAspect, ExportFormat, HideMode, ImageOverlay, Rotation, TextOverlay, Entrance, Motion } from '../types';

const ENTRANCES: { value: Entrance; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'fade', label: 'Fade' }, { value: 'slide', label: 'Slide' },
  { value: 'pop', label: 'Pop' }, { value: 'typewriter', label: 'Type' },
];

/** "Show from … to …" on the output timeline, with buttons to grab the playhead. */
function Timing({ start, end, onChange }: { start: number; end: number; onChange: (p: { start?: number; end?: number }) => void }) {
  const clips = useStore(s => s.doc.clips);
  const cur = useCurrentClip();
  const total = totalDuration(clips);
  const now = () => {
    if (!cur) return 0;
    let off = 0;
    for (const c of clips) { if (c.id === cur.id) break; off += clipOutDur(c); }
    return off + (clamp(video.currentTime, cur.trimStart, cur.trimEnd) - cur.trimStart) / cur.speed;
  };
  const full = start <= 0 && end >= FULL_END;
  return (
    <div className="timing">
      <Toggle label="Show for the whole video" checked={full} onChange={v => onChange(v ? { start: 0, end: FULL_END } : { start: now(), end: Math.min(total, now() + 3) })} />
      {!full && (
        <div className="timing-row">
          <span>From <b>{fmtClock(start, true)}</b></span>
          <button className="btn ghost sm" onClick={() => onChange({ start: Math.min(now(), end - 0.1) })}>Set to playhead</button>
          <span>to <b>{end >= FULL_END ? 'end' : fmtClock(end, true)}</b></span>
          <button className="btn ghost sm" onClick={() => onChange({ end: Math.max(now(), start + 0.1) })}>Set to playhead</button>
        </div>
      )}
    </div>
  );
}

function OverlayChips({ kind }: { kind: 'text' | 'image' }) {
  const all = useStore(s => s.doc.overlays);
  const overlays = all.filter(o => o.kind === kind);
  const sel = useStore(s => s.selectedOverlayId);
  if (!overlays.length) return null;
  return (
    <div className="chips">
      {overlays.map((o, i) => (
        <button key={o.id} className={'chip' + (o.id === sel ? ' on' : '')} onClick={() => useStore.setState({ selectedOverlayId: o.id, stageMode: 'output' })}>
          {o.kind === 'text' ? (o.text.trim().split('\n')[0] || `Text ${i + 1}`) : o.name}
        </button>
      ))}
    </div>
  );
}

function OverlayActions({ id }: { id: string }) {
  return (
    <div className="row-actions">
      <button className="btn ghost sm" onClick={() => {
        const o = useStore.getState().doc.overlays.find(x => x.id === id)!;
        const copy = { ...o, id: uid(), x: clamp(o.x + 0.04, 0, 1), y: clamp(o.y + 0.04, 0, 1) };
        edit(d => ({ ...d, overlays: [...d.overlays, copy] }));
        useStore.setState({ selectedOverlayId: copy.id });
      }}>Duplicate</button>
      <button className="btn ghost sm" onClick={() => edit(d => {
        const i = d.overlays.findIndex(o => o.id === id);
        if (i >= d.overlays.length - 1) return d;
        const l = [...d.overlays]; [l[i], l[i + 1]] = [l[i + 1], l[i]];
        return { ...d, overlays: l };
      })}>Bring forward</button>
      <button className="btn danger sm" onClick={() => { edit(d => ({ ...d, overlays: d.overlays.filter(o => o.id !== id) })); useStore.setState({ selectedOverlayId: null }); }}>Delete</button>
    </div>
  );
}

const POSITIONS: [string, number, number][] = [
  ['Top left', 0.14, 0.1], ['Top', 0.5, 0.1], ['Top right', 0.86, 0.1],
  ['Left', 0.14, 0.5], ['Center', 0.5, 0.5], ['Right', 0.86, 0.5],
  ['Bottom left', 0.14, 0.9], ['Bottom', 0.5, 0.9], ['Bottom right', 0.86, 0.9],
];
function PositionGrid({ onPick }: { onPick: (x: number, y: number) => void }) {
  return (
    <div className="posgrid" role="group" aria-label="Quick position">
      {POSITIONS.map(([l, x, y]) => <button key={l} title={l} aria-label={l} onClick={() => onPick(x, y)}><i /></button>)}
    </div>
  );
}

// ================= Media (clip settings) =================
export function MediaPanel() {
  const clip = useCurrentClip();
  if (!clip) return (
    <Section title="Everything here is free">
      <ul className="free-list">
        <li>Export in up to 4K, with no watermark and no length limit</li>
        <li>Remove a logo or watermark that's already in a video</li>
        <li>Join clips, trim, split, change speed and rotate</li>
        <li>Text with outlines, boxes and animations, plus your own logo</li>
        <li>Colour looks, background music and fades</li>
        <li>Reframe for Reels, Shorts and TikTok with a blurred background</li>
        <li>MP4, WebM, GIF or audio-only export</li>
      </ul>
      <Note>Nothing is uploaded. ClipStamp edits on your device and keeps working offline once it has loaded.</Note>
    </Section>
  );
  const set = (p: Parameters<typeof patchClip>[1], key?: string) => patchClip(clip.id, p, key);
  return (
    <>
      <Section title="This clip">
        <p className="meta">{clip.name}<br />{clip.width}×{clip.height} · {fmtClock(clip.duration, true)} · {fmtBytes(clip.size)}</p>
      </Section>
      <Section title="Speed">
        <Seg value={clip.speed} onChange={v => set({ speed: v })}
          options={[0.25, 0.5, 1, 1.5, 2, 4].map(v => ({ value: v, label: v + '×' }))} />
        <Slider label="Exact speed" value={clip.speed} min={0.25} max={4} step={0.05} format={v => v.toFixed(2) + '×'} onChange={v => set({ speed: v }, 'speed')} />
        <Note>Plays in {fmtClock(clipOutDur(clip), true)}. Pitch moves with speed, like a tape.</Note>
      </Section>
      <Section title="Rotate">
        <Seg value={clip.rotation} onChange={v => set({ rotation: v as Rotation })}
          options={[0, 90, 180, 270].map(v => ({ value: v, label: v + '°' }))} />
        <Note>Turning 90° swaps width and height — a landscape clip becomes portrait.</Note>
      </Section>
      <Section title="Clip sound">
        <Toggle label="Mute this clip" checked={clip.muted} onChange={v => set({ muted: v })} />
        <Slider label="Volume" value={Math.round(clip.volume * 100)} min={0} max={200} format={v => v + '%'} disabled={clip.muted}
          onChange={v => set({ volume: v / 100 }, 'vol')} />
        {!clip.hasAudio && <Note>This clip has no sound track.</Note>}
      </Section>
      <Section title="More clips">
        <label className="btn">
          Add videos
          <input type="file" accept="video/*" multiple hidden onChange={e => { addVideoFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </label>
        <Note>Clips play in the order of the strip below. Drag to reorder; each clip keeps its own trim, speed, rotation and volume.</Note>
      </Section>
    </>
  );
}

// ================= Text =================
export function TextPanel() {
  const sel = useStore(s => s.doc.overlays.find(o => o.id === s.selectedOverlayId && o.kind === 'text') as TextOverlay | undefined);
  const count = useStore(s => s.doc.overlays.filter(o => o.kind === 'text').length);
  const enabled = useStore(s => s.doc.overlaysEnabled);
  const add = () => {
    const t = newText(count + 1);
    edit(d => ({ ...d, overlays: [...d.overlays, t] }));
    useStore.setState({ selectedOverlayId: t.id, stageMode: 'output' });
  };
  const set = (p: Partial<TextOverlay>, key?: string) => sel && patchOverlay(sel.id, p, key);
  return (
    <>
      <Section title="Text and watermarks" aside={<Toggle label="Show" checked={enabled} onChange={v => edit(d => ({ ...d, overlaysEnabled: v }))} hint="Turn all text and logos on or off" />}>
        <OverlayChips kind="text" />
        <button className="btn primary" onClick={add}>Add text</button>
        {!sel && count > 0 && <Note>Pick a text above, or click it on the preview.</Note>}
      </Section>
      {sel && (
        <>
          <Section>
            <Field label="Text">
              <textarea rows={2} value={sel.text} onChange={e => set({ text: e.target.value }, 'text-' + sel.id)} />
            </Field>
            <Field label="Font">
              <select value={sel.font} onChange={e => set({ font: e.target.value })}>
                {Object.entries(FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
              </select>
            </Field>
            <Slider label="Size" value={sel.size} min={12} max={260} onChange={v => set({ size: v }, 'size')} />
            <div className="row">
              <ColorInput label="Colour" value={sel.color} onChange={v => set({ color: v }, 'color')} />
              <Seg value={sel.align} onChange={v => set({ align: v })} options={[{ value: 'left', label: 'L', title: 'Align left' }, { value: 'center', label: 'C', title: 'Center' }, { value: 'right', label: 'R', title: 'Align right' }]} />
            </div>
            <Slider label="Opacity" value={sel.opacity} min={5} max={100} format={v => v + '%'} onChange={v => set({ opacity: v }, 'op')} />
            <Slider label="Rotation" value={sel.rotation} min={-180} max={180} format={v => v + '°'} onChange={v => set({ rotation: v }, 'rot')} />
          </Section>
          <Section title="Style">
            <Toggle label="Drop shadow" checked={sel.shadow} onChange={v => set({ shadow: v })} />
            <Slider label="Outline" value={sel.outline} min={0} max={16} onChange={v => set({ outline: v }, 'ol')} />
            {sel.outline > 0 && <ColorInput label="Outline colour" value={sel.outlineColor} onChange={v => set({ outlineColor: v }, 'olc')} />}
            <Toggle label="Background box" checked={sel.box} onChange={v => set({ box: v })} />
            {sel.box && <div className="row">
              <ColorInput label="Box colour" value={sel.boxColor} onChange={v => set({ boxColor: v }, 'bc')} />
              <Slider label="Box opacity" value={sel.boxOpacity} min={5} max={100} format={v => v + '%'} onChange={v => set({ boxOpacity: v }, 'bo')} />
            </div>}
          </Section>
          <Section title="Position">
            <PositionGrid onPick={(x, y) => set({ x, y, motion: 'none' })} />
            <Note>Or drag the text on the preview.</Note>
          </Section>
          <Section title="Animation">
            <Seg label="Entrance" value={sel.entrance} onChange={v => set({ entrance: v })} options={ENTRANCES} />
            <Field label="Movement">
              <select value={sel.motion} onChange={e => set({ motion: e.target.value as Motion })}>
                <option value="none">Stays put</option>
                <option value="horizontal">Slides left and right</option>
                <option value="vertical">Slides up and down</option>
                <option value="bounce">Bounces around (hard to crop out)</option>
              </select>
            </Field>
            {sel.motion !== 'none' && <Slider label="One pass takes" value={sel.speed} min={2} max={60} format={v => v + 's'} onChange={v => set({ speed: v }, 'msp')} />}
          </Section>
          <Section title="Timing"><Timing start={sel.start} end={sel.end} onChange={p => set(p)} /></Section>
          <Section><OverlayActions id={sel.id} /></Section>
        </>
      )}
    </>
  );
}

// ================= Logo / image =================
export function LogoPanel() {
  const sel = useStore(s => s.doc.overlays.find(o => o.id === s.selectedOverlayId && o.kind === 'image') as ImageOverlay | undefined);
  const set = (p: Partial<ImageOverlay>, key?: string) => sel && patchOverlay(sel.id, p, key);
  const add = async (f?: File) => {
    if (!f) return;
    try {
      const { dataUrl, aspect } = await readImage(f);
      const o = newImage(f.name, dataUrl, aspect);
      edit(d => ({ ...d, overlays: [...d.overlays, o] }));
      useStore.setState({ selectedOverlayId: o.id, stageMode: 'output' });
    } catch (e: any) { notify(e.message, 'error'); }
  };
  return (
    <>
      <Section title="Logos and images">
        <OverlayChips kind="image" />
        <label className="btn primary">
          Add a logo or image
          <input type="file" accept="image/*" hidden onChange={e => { add(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <Note>PNG logos keep their transparency. Use it as a brand watermark, a sticker or a frame.</Note>
      </Section>
      {sel && (
        <>
          <Section>
            <Slider label="Size" value={Math.round(sel.width * 100)} min={3} max={100} format={v => v + '% wide'} onChange={v => set({ width: v / 100 }, 'w')} />
            <Slider label="Opacity" value={sel.opacity} min={5} max={100} format={v => v + '%'} onChange={v => set({ opacity: v }, 'op')} />
            <Slider label="Rotation" value={sel.rotation} min={-180} max={180} format={v => v + '°'} onChange={v => set({ rotation: v }, 'rot')} />
          </Section>
          <Section title="Position"><PositionGrid onPick={(x, y) => set({ x, y })} /></Section>
          <Section title="Animation"><Seg label="Entrance" value={sel.entrance} onChange={v => set({ entrance: v })} options={ENTRANCES.filter(e => e.value !== 'typewriter')} /></Section>
          <Section title="Timing"><Timing start={sel.start} end={sel.end} onChange={p => set(p)} /></Section>
          <Section><OverlayActions id={sel.id} /></Section>
        </>
      )}
    </>
  );
}

// ================= Remove logo / blur =================
const MODE_NOTES: Record<HideMode, string> = {
  fill: 'Rebuilds the area from the pixels around it. Best on plain or gently changing backgrounds — sky, walls, soft focus.',
  clone: 'Copies real, moving detail from next to the box. Best on grass, water, fabric or crowds. The white dashed box shows where it copies from.',
  blur: 'A soft smudge. Simple, but usually noticeable.',
  pixelate: 'Mosaic squares, for hiding faces, number plates or screens.',
};

export function RemovePanel() {
  const hides = useStore(s => s.doc.hides);
  const enabled = useStore(s => s.doc.hidesEnabled);
  const active = useStore(s => s.doc.hides.find(h => h.id === s.activeHideId));
  const sel = useStore(s => s.selectedSeg);
  const set = (p: Parameters<typeof patchHide>[1], key?: string) => active && patchHide(active.id, p, key);
  const dur = useCurrentClip()?.duration ?? 0;

  const add = () => {
    const r = newHide(0.4, 0.46, 0.2, 0.08, active);
    edit(d => ({ ...d, hides: [...d.hides, r] }));
    useStore.setState({ activeHideId: r.id, stageMode: 'hide' });
  };
  const segAtPlayhead = () => {
    const t = video.currentTime;
    return active?.segments.find(s => t > s.start + 0.05 && t < Math.min(s.end, dur) - 0.05) ?? null;
  };

  return (
    <>
      <Section title="Remove a logo" aside={<Toggle label="On" checked={enabled} onChange={v => edit(d => ({ ...d, hidesEnabled: v }))} hint="Compare before and after" />}>
        <Note>Covers a watermark, logo or caption that's already burned into the video. Switch the preview to “Logo areas” and drag a box over it.</Note>
        <div className="chips">
          {hides.map((h, i) => (
            <button key={h.id} className={'chip' + (h.id === active?.id ? ' on' : '')} onClick={() => useStore.setState({ activeHideId: h.id, stageMode: 'hide' })}>Area {i + 1}</button>
          ))}
        </div>
        <div className="row-actions">
          <button className="btn primary" onClick={add}>Add area</button>
          {active && <button className="btn danger" onClick={() => { edit(d => ({ ...d, hides: d.hides.filter(h => h.id !== active.id) })); useStore.setState({ activeHideId: null, selectedSeg: null }); }}>Delete area</button>}
        </div>
      </Section>
      {active && (
        <>
          <Section title="Method">
            <Seg value={active.mode} onChange={v => set({ mode: v })}
              options={[{ value: 'fill', label: 'Smart fill' }, { value: 'clone', label: 'Clone' }, { value: 'blur', label: 'Blur' }, { value: 'pixelate', label: 'Pixelate' }]} />
            <Note>{MODE_NOTES[active.mode]}</Note>
            {active.mode === 'fill' && <Slider label="Grain" value={active.grain} min={0} max={100} format={v => v + '%'} onChange={v => set({ grain: v }, 'grain')} />}
            {active.mode === 'clone' && (
              <Field label="Copy from">
                <select value={active.cloneFrom} onChange={e => set({ cloneFrom: e.target.value as any })}>
                  <option value="auto">Best matching side</option><option value="above">Above</option>
                  <option value="below">Below</option><option value="left">Left</option><option value="right">Right</option>
                </select>
              </Field>
            )}
            {(active.mode === 'blur' || active.mode === 'pixelate') && <Slider label={active.mode === 'blur' ? 'Blur strength' : 'Block size'} value={active.blur} min={2} max={60} onChange={v => set({ blur: v }, 'blur')} />}
            {(active.mode === 'blur' || active.mode === 'clone') && <Slider label="Edge softness" value={active.feather} min={0} max={40} onChange={v => set({ feather: v }, 'feather')} />}
          </Section>
          <Section title="When it's active">
            <Note>Each area has a row under the timeline. Drag its pieces to move them, drag their ends to change when they start and stop.</Note>
            <div className="row-actions">
              <button className="btn ghost sm" onClick={() => {
                const len = Math.min(3, dur), st = clamp(video.currentTime, 0, Math.max(0, dur - len));
                const seg = { id: uid(), start: st, end: st + len };
                set({ segments: [...active.segments, seg] });
                useStore.setState({ selectedSeg: { hideId: active.id, segId: seg.id } });
              }}>Add 3s at playhead</button>
              <button className="btn ghost sm" disabled={!segAtPlayhead()} onClick={() => {
                const seg = segAtPlayhead(); if (!seg) return;
                const t = video.currentTime, second = { id: uid(), start: t, end: seg.end };
                set({ segments: [...active.segments.map(s => s.id === seg.id ? { ...s, end: t } : s), second] });
              }}>Split at playhead</button>
              <button className="btn ghost sm" onClick={() => set({ segments: [{ id: uid(), start: 0, end: FULL_END }] })}>Whole video</button>
              <button className="btn danger sm" disabled={!sel || sel.hideId !== active.id} onClick={() => {
                set({ segments: active.segments.filter(s => s.id !== sel!.segId) });
                useStore.setState({ selectedSeg: null });
              }}>Delete piece</button>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

// ================= Adjust: crop, flip, canvas =================
const RATIOS: { label: string; v: { w: number; h: number } | null | 'free' }[] = [
  { label: 'None', v: null }, { label: 'Free', v: 'free' }, { label: '9:16', v: { w: 9, h: 16 } },
  { label: '16:9', v: { w: 16, h: 9 } }, { label: '1:1', v: { w: 1, h: 1 } }, { label: '4:5', v: { w: 4, h: 5 } },
];

export function AdjustPanel() {
  const fr = useStore(s => s.doc.framing);
  const clip = useCurrentClip();
  const doc = useStore(s => s.doc);
  const size = outputSize(doc);
  const setCrop = (crop: Rect | null, cropLock: { w: number; h: number } | null) => { if (clip) patchClip(clip.id, { crop, cropLock }); };
  const pickRatio = (v: (typeof RATIOS)[number]['v']) => {
    if (!clip) return;
    if (!v) { setCrop(null, null); useStore.setState({ stageMode: 'output' }); return; }
    if (v === 'free') setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, null);
    else {
      const vw = clip.rotation % 180 ? clip.height : clip.width;
      const vh = clip.rotation % 180 ? clip.width : clip.height;
      const target = v.w / v.h, srcR = vw / vh;
      let w = 1, h = 1;
      if (target > srcR) h = (vw / target) / vh; else w = (vh * target) / vw;
      setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h }, v);
    }
    useStore.setState({ stageMode: 'crop' });
  };
  const applyToAll = () => {
    if (!clip) return;
    edit(d => ({ ...d, clips: d.clips.map(c => ({ ...c, crop: clip.crop, cropLock: clip.cropLock })) }));
    notify('Crop copied to every clip.');
  };
  const idx = doc.clips.findIndex(c => c.id === clip?.id);
  return (
    <>
      <Section title={doc.clips.length > 1 && idx >= 0 ? `Crop — clip ${idx + 1}` : 'Crop'}>
        <div className="chips">
          {RATIOS.map(r => {
            const crop = clip?.crop ?? null, lock = clip?.cropLock ?? null;
            const on = r.v === null ? !crop : r.v === 'free' ? !!crop && !lock : !!lock && lock.w === r.v.w && lock.h === r.v.h;
            return <button key={r.label} className={'chip' + (on ? ' on' : '')} disabled={!clip} onClick={() => pickRatio(r.v)}>{r.label}</button>;
          })}
        </div>
        <Note>Cuts the picture down for the selected clip only. Adjust the box in the “Crop” preview, then pick another clip in the strip to crop it differently.</Note>
        {doc.clips.length > 1 && <button className="link" onClick={applyToAll}>Use this crop on every clip</button>}
      </Section>
      <Section title="Canvas shape">
        <Seg value={fr.aspect} onChange={v => patchDoc('framing', { aspect: v as CanvasAspect })}
          options={(['source', '9:16', '16:9', '1:1', '4:5'] as CanvasAspect[]).map(a => ({ value: a, label: a === 'source' ? 'Same' : a }))} />
        <Note>Fits the whole picture into a new shape without cutting anything — turn a landscape video into a Reel or Short.</Note>
        <Seg label="Fill the empty space with" value={fr.bg} onChange={v => patchDoc('framing', { bg: v })}
          options={[{ value: 'blur', label: 'Blurred video' }, { value: 'black', label: 'Black' }, { value: 'color', label: 'Colour' }]} />
        {fr.bg === 'color' && <ColorInput label="Background colour" value={fr.bgColor} onChange={v => patchDoc('framing', { bgColor: v }, 'bgc')} />}
      </Section>
      <Section title="Mirror">
        <div className="row">
          <Toggle label="Flip sideways" checked={fr.flipH} onChange={v => patchDoc('framing', { flipH: v })} />
          <Toggle label="Flip upside down" checked={fr.flipV} onChange={v => patchDoc('framing', { flipV: v })} />
        </div>
      </Section>
      <Note>Output frame: {size.w}×{size.h}</Note>
    </>
  );
}

// ================= Colour =================
export function ColorPanel() {
  const c = useStore(s => s.doc.color);
  const set = (p: Partial<typeof c>, key?: string) => patchDoc('color', { ...p, preset: p.preset ?? 'custom' }, key);
  return (
    <>
      <Section title="Looks">
        <div className="looks">
          {COLOR_PRESETS.map(p => (
            <button key={p.id} className={'look' + (c.preset === p.id ? ' on' : '')} onClick={() => patchDoc('color', { ...DEFAULT_COLOR, ...p.v, preset: p.id })}>
              <span className={'look-swatch look-' + p.id} />{p.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Fine tune" aside={<button className="link" onClick={() => patchDoc('color', { ...DEFAULT_COLOR })}>Reset</button>}>
        <Slider label="Brightness" value={c.brightness} min={30} max={180} format={v => v + '%'} onChange={v => set({ brightness: v }, 'cb')} />
        <Slider label="Contrast" value={c.contrast} min={30} max={180} format={v => v + '%'} onChange={v => set({ contrast: v }, 'cc')} />
        <Slider label="Saturation" value={c.saturation} min={0} max={250} format={v => v + '%'} onChange={v => set({ saturation: v }, 'cs')} />
        <Slider label="Temperature" value={c.temperature} min={-100} max={100} format={v => (v > 0 ? 'warm +' : v < 0 ? 'cool ' : '') + v} onChange={v => set({ temperature: v }, 'ct')} />
        <Slider label="Hue shift" value={c.hue} min={-180} max={180} format={v => v + '°'} onChange={v => set({ hue: v }, 'ch')} />
        <Slider label="Vignette" value={c.vignette} min={0} max={100} onChange={v => set({ vignette: v }, 'cv')} />
        <Slider label="Fade to grey" value={c.grayscale} min={0} max={100} format={v => v + '%'} onChange={v => set({ grayscale: v }, 'cg')} />
        <Slider label="Sepia" value={c.sepia} min={0} max={100} format={v => v + '%'} onChange={v => set({ sepia: v }, 'cse')} />
        <Slider label="Soften" value={c.blur} min={0} max={20} onChange={v => set({ blur: v }, 'cbl')} />
      </Section>
      <Note>Colour applies to every clip, so a multi-clip edit looks consistent.</Note>
    </>
  );
}

// ================= Audio =================
export function AudioPanel() {
  const a = useStore(s => s.doc.audio);
  const total = useStore(s => totalDuration(s.doc.clips));
  const selId = useStore(s => s.selectedAudioId);
  useStore(s => s.time); // re-render as the playhead moves, for the "at playhead" buttons
  const set = (p: Partial<typeof a>, key?: string) => patchDoc('audio', p, key);
  const sel = a.clips.find(x => x.id === selId) ?? null;
  const selSrc = sel ? a.sources.find(x => x.id === sel.sourceId) ?? null : null;
  const now = outputNow();

  const place = (src: AudioSource, at: number) => {
    const ac: AudioClip = { id: uid(), sourceId: src.id, start: at, in: 0, len: Math.max(0.1, src.duration), volume: 0.8, loop: false };
    edit(d => ({ ...d, audio: { ...d.audio, clips: [...d.audio.clips, ac] } }));
    useStore.setState({ selectedAudioId: ac.id, selectedOverlayId: null, selectedSeg: null });
  };
  const addFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        const src = await probeAudio(f);
        edit(d => ({ ...d, audio: { ...d.audio, sources: [...d.audio.sources, src] } }));
        place(src, outputNow());
      } catch (err: any) { notify(err.message, 'error'); }
    }
  };
  const copyTo = (at: number) => {
    if (!sel) return;
    const ac = { ...sel, id: uid(), start: at };
    edit(d => ({ ...d, audio: { ...d.audio, clips: [...d.audio.clips, ac] } }));
    useStore.setState({ selectedAudioId: ac.id });
  };
  const splitAt = (t: number) => {
    if (!sel || !selSrc || t <= sel.start + 0.1 || t >= sel.start + sel.len - 0.1) return;
    const cut = t - sel.start;
    let nextIn = sel.in + cut;
    if (sel.loop && selSrc.duration) nextIn %= selSrc.duration;
    const second = { ...sel, id: uid(), start: t, in: nextIn, len: sel.len - cut };
    edit(d => ({ ...d, audio: { ...d.audio, clips: d.audio.clips.flatMap(x => x.id === sel.id ? [{ ...x, len: cut }, second] : [x]) } }));
  };
  const setLoop = (loop: boolean) => {
    if (!sel || !selSrc) return;
    const len = loop ? Math.max(sel.len, total - sel.start) : Math.min(sel.len, Math.max(0.1, selSrc.duration - sel.in));
    patchAudioClip(sel.id, { loop, len });
  };
  const inside = sel && now > sel.start + 0.1 && now < sel.start + sel.len - 0.1;

  return (
    <>
      <Section title="Music and sound">
        <label className="btn primary">
          Add audio at playhead
          <input type="file" accept="audio/*" multiple hidden onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; addFiles(f); }} />
        </label>
        <Note>MP3, WAV, M4A or OGG from your device. Each one appears in the Audio lane under the timeline — drag it to move it, drag its edges to trim.</Note>
        {a.sources.length > 0 && (
          <ul className="audio-src">
            {a.sources.map(src => {
              const n = a.clips.filter(x => x.sourceId === src.id).length;
              return (
                <li key={src.id}>
                  <span className="meta">{src.name} · {fmtClock(src.duration)}{n > 1 ? ` · used ${n}×` : ''}</span>
                  <button className="link" onClick={() => place(src, now)}>Add at {fmtClock(now, true)}</button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {sel && selSrc ? (
        <Section title="Selected audio" aside={<button className="link" onClick={() => useStore.setState({ selectedAudioId: null })}>Done</button>}>
          <p className="meta">{selSrc.name} · plays {fmtClock(sel.start, true)}–{fmtClock(sel.start + sel.len, true)}{sel.in > 0.05 ? ` (from ${fmtClock(sel.in, true)} into the file)` : ''}</p>
          <Slider label="Volume" value={Math.round(sel.volume * 100)} min={0} max={200} format={v => v + '%'} onChange={v => patchAudioClip(sel.id, { volume: v / 100 }, 'av')} />
          <Slider label="Starts at" value={sel.start} min={0} max={Math.max(1, total)} step={0.1} format={v => fmtClock(v, true)} onChange={v => patchAudioClip(sel.id, { start: v }, 'as')} />
          <Toggle label="Repeat to fill (loop)" checked={sel.loop} onChange={setLoop} />
          <div className="row">
            <button className="btn sm" onClick={() => patchAudioClip(sel.id, { start: now })}>Move to playhead</button>
            <button className="btn sm" onClick={() => copyTo(now)}>Copy to playhead</button>
            <button className="btn sm" disabled={!inside} onClick={() => splitAt(now)}>Split at playhead</button>
          </div>
          <button className="btn danger sm" onClick={() => removeAudioClip(sel.id)}>Remove this audio</button>
        </Section>
      ) : a.clips.length > 0 && <Note>Click an audio block in the timeline to change its volume, move it, copy it to another spot, or split it.</Note>}
      <Section title="Mix">
        <Toggle label="Lower added audio under clips that have sound" checked={a.duck} onChange={v => set({ duck: v })} />
      </Section>
      <Section title="Fade in and out">
        <Slider label="Fade in" value={a.fadeIn} min={0} max={5} step={0.25} format={v => v ? v + 's' : 'off'} onChange={v => set({ fadeIn: v }, 'fi')} />
        <Slider label="Fade out" value={a.fadeOut} min={0} max={5} step={0.25} format={v => v ? v + 's' : 'off'} onChange={v => set({ fadeOut: v }, 'fo')} />
        <Toggle label="Fade the picture from and to black too" checked={a.videoFade} onChange={v => set({ videoFade: v })} />
      </Section>
      <Note>Per-clip volume and mute are under Clip.</Note>
    </>
  );
}

// ================= Export + project =================
let job: ExportJob | null = null;

export function ExportPanel() {
  const o = useStore(s => s.doc.output);
  const doc = useStore(s => s.doc);
  const exporting = useStore(s => s.exporting);
  const [prog, setProg] = useState<{ p: number; msg: string } | null>(null);
  const [result, setResult] = useState<{ url: string; name: string; size: number; note: string; secs: number } | null>(null);
  const set = (p: Partial<typeof o>, key?: string) => patchDoc('output', p, key);
  const size = outputSize(doc);
  const total = totalDuration(doc.clips);

  const run = async () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    useStore.setState({ exporting: true });
    const t0 = performance.now();
    job = startExport(useStore.getState().doc, (p, msg) => setProg({ p, msg }));
    try {
      const r = await job.done;
      setResult({ url: URL.createObjectURL(r.blob), name: r.name, size: r.blob.size, note: r.note, secs: (performance.now() - t0) / 1000 });
      notify('Export finished.');
    } catch (e: any) {
      if (e instanceof ExportCanceled) notify('Export canceled.');
      else { console.error(e); notify('Export failed: ' + (e?.message ?? e), 'error'); }
    } finally {
      job = null;
      setProg(null);
      useStore.setState({ exporting: false });
    }
  };

  const fmtOptions: { value: ExportFormat; label: string; title: string }[] = [
    { value: 'mp4', label: 'MP4', title: 'Plays everywhere' },
    { value: 'webm', label: 'WebM', title: 'Open format, good for the web' },
    { value: 'gif', label: 'GIF', title: 'Animated GIF, no sound' },
    { value: 'wav', label: 'Audio', title: 'Just the sound, as WAV' },
  ];

  return (
    <>
      <Section title="Export">
        <Seg value={o.format} onChange={v => set({ format: v })} options={fmtOptions} />
        {(o.format === 'mp4' || o.format === 'webm') && (
          <>
            <Field label="Resolution">
              <select value={o.resolution} onChange={e => set({ resolution: +e.target.value })}>
                <option value={0}>Same as source</option><option value={480}>480p</option><option value={720}>720p</option>
                <option value={1080}>1080p (Full HD)</option><option value={1440}>1440p (2K)</option><option value={2160}>2160p (4K)</option>
              </select>
            </Field>
            <Field label="Quality">
              <select value={o.quality} onChange={e => set({ quality: e.target.value as any })}>
                <option value="match">Match the original file size</option><option value="high">High</option>
                <option value="medium">Balanced</option><option value="small">Small file</option><option value="custom">Custom bitrate</option>
              </select>
            </Field>
            {o.quality === 'custom' && <Slider label="Bitrate" value={o.customMbps} min={1} max={60} format={v => v + ' Mbps'} onChange={v => set({ customMbps: v }, 'mbps')} />}
            <Seg label="Frame rate" value={o.fps} onChange={v => set({ fps: v })} options={[{ value: 0, label: 'Source' }, { value: 24, label: '24' }, { value: 30, label: '30' }, { value: 60, label: '60' }]} />
            <Seg label="Encoding" value={o.compact ? 1 : 0} onChange={v => set({ compact: v === 1 })} options={[{ value: 0, label: 'Most compatible' }, { value: 1, label: 'Smallest file (slower)' }]} />
            {o.compact && <Note>Uses AV1, HEVC or VP9 when your browser can. Files are much smaller, but some older devices and editors can't play them.</Note>}
            <Note>{size.w}×{size.h}, {fmtClock(total, true)} long. No watermark, no length limit.</Note>
          </>
        )}
        {o.format === 'gif' && (
          <>
            <Slider label="Width" value={o.gifWidth} min={160} max={960} step={16} format={v => v + 'px'} onChange={v => set({ gifWidth: v }, 'gw')} />
            <Slider label="Frames per second" value={o.gifFps} min={5} max={25} onChange={v => set({ gifFps: v }, 'gf')} />
            <Note>GIFs get big fast — keep them short and small.</Note>
          </>
        )}
        {o.format === 'wav' && <Note>Exports the mixed sound (clips + music + fades) as an uncompressed WAV.</Note>}
        {!exporting
          ? <button className="btn primary big" disabled={!doc.clips.length} onClick={run}>Export {o.format === 'wav' ? 'audio' : o.format.toUpperCase()}</button>
          : <button className="btn danger big" onClick={() => job?.cancel()}>Cancel export</button>}
        {prog && (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(prog.p * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="bar"><i style={{ width: prog.p * 100 + '%' }} /></div>
            <span>{prog.msg}</span>
          </div>
        )}
        {result && (
          <div className="result">
            <p><b>{result.name}</b><br />{fmtBytes(result.size)} · made in {result.secs.toFixed(1)}s<br />{result.note}</p>
            <a className="btn primary" href={result.url} download={result.name}>Download</a>
          </div>
        )}
      </Section>
      <ProjectSection />
    </>
  );
}

function ProjectSection() {
  return (
    <Section title="Project">
      <Note>Your edit and videos are saved in this browser automatically, so a refresh picks up where you left off — even offline.</Note>
      <div className="row-actions">
        <button className="btn ghost sm" onClick={() => download(new Blob([projectToJson(useStore.getState().doc)], { type: 'application/json' }), 'edit.clipstamp')}>Save settings file</button>
        <label className="btn ghost sm">
          Load settings file
          <input type="file" accept=".clipstamp,.clipsmith,.json" hidden onChange={async e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            try {
              const r = applyProjectJson(useStore.getState().doc, await f.text());
              useStore.getState().edit(() => r.doc);
              notify(r.wanted ? `Settings loaded. Matched ${r.matched} of ${r.wanted} clips by file name.` : 'Settings loaded.');
            } catch (err: any) { notify(err.message, 'error'); }
          }} />
        </label>
        <button className="btn danger sm" onClick={async () => {
          if (!confirm('Start a new project? This clears the current edit from this browser.')) return;
          await clearProject();
          useStore.getState().replaceDoc(emptyDoc());
          useStore.setState({ currentClipId: null, selectedOverlayId: null, activeHideId: null, stageMode: 'output', playing: false });
          seek(0);
        }}>New project</button>
      </div>
    </Section>
  );
}
