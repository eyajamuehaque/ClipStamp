import { useRef } from 'react';
import { useStore, useCurrentClip, patchClip, patchHide, patchAudioClip, patchOverlay } from '../store';
import { togglePlay, seek, seekOutput, stepFrame, pause, video } from '../player';
import { clipOffset, clipOutDur, fmtClock, totalDuration, clamp, outputSize, toOutputTime } from '../engine/timeline';
import { createRenderer } from '../engine/render';
import { download } from '../engine/media';
import { FULL_END, type Overlay } from '../types';
import { uid } from '../defaults';

const TRIM_GAP = 0.05;

export default function Timeline() {
  const clip = useCurrentClip();
  const time = useStore(s => s.time);
  const playing = useStore(s => s.playing);
  const clips = useStore(s => s.doc.clips);
  const trackRef = useRef<HTMLDivElement>(null);
  if (!clip) return null;
  const dur = clip.duration || 1;
  const total = totalDuration(clips);
  const span = Math.max(total, 0.1);
  const offset = clipOffset(clips, clip.id);
  const outNow = offset + (clamp(time, clip.trimStart, clip.trimEnd) - clip.trimStart) / clip.speed;
  const pct = (t: number) => clamp(t / span, 0, 1) * 100 + '%';
  const clipNo = clips.findIndex(c => c.id === clip.id) + 1;

  // The track spans the whole output video; scrubbing hops between clips.
  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * span;
  };

  const startScrub = (e: React.PointerEvent) => {
    pause();
    seekOutput(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seekOutput(timeAt(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Trim the current clip by dragging its edges. Uses drag distance at the scale from drag start,
  // because the whole layout shifts as the clip gets longer or shorter.
  const startTrim = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation();
    pause();
    const perPx = span / trackRef.current!.getBoundingClientRect().width, x0 = e.clientX;
    const c0 = useStore.getState().doc.clips.find(x => x.id === clip.id)!;
    const move = (ev: PointerEvent) => {
      const c = useStore.getState().doc.clips.find(x => x.id === clip.id)!;
      const ds = (ev.clientX - x0) * perPx * c0.speed;
      if (which === 'start') { const v = clamp(c0.trimStart + ds, 0, c.trimEnd - TRIM_GAP); patchClip(clip.id, { trimStart: v }, 'trim'); seek(v); }
      else { const v = clamp(c0.trimEnd + ds, c.trimStart + TRIM_GAP, dur); patchClip(clip.id, { trimEnd: v }, 'trim'); seek(v); }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const splitHere = () => {
    // Split = duplicate the clip and divide the trim range at the playhead.
    const t = video.currentTime;
    if (t <= clip.trimStart + TRIM_GAP || t >= clip.trimEnd - TRIM_GAP) return;
    const second = { ...clip, id: uid(), trimStart: t };
    useStore.getState().edit(d => {
      const i = d.clips.findIndex(c => c.id === clip.id);
      const clipsNext = [...d.clips];
      clipsNext[i] = { ...clip, trimEnd: t };
      clipsNext.splice(i + 1, 0, second);
      return { ...d, clips: clipsNext };
    });
  };

  const snapshot = async () => {
    const s = useStore.getState();
    const size = outputSize(s.doc);
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d')!;
    createRenderer().render(ctx, size.w, size.h,
      { w: video.videoWidth, h: video.videoHeight, draw: (c, w, h) => c.drawImage(video, 0, 0, w, h) },
      clip, s.doc, toOutputTime(s.doc.clips, clip, video.currentTime), total);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    download(blob, clip.name.replace(/\.[^.]+$/, '') + '-' + fmtClock(video.currentTime).replace(/:/g, '-') + '.png');
  };

  const ticks = buildTicks(span, trackRef.current?.clientWidth ?? 600);
  const trimmed = clip.trimStart > 0.01 || clip.trimEnd < dur - 0.01;

  return (
    <div className="timeline">
      <div className="transport">
        <button className="icon-btn play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
          {playing
            ? <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" /></svg>
            : <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
        </button>
        <button className="icon-btn" onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame (←)">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
        </button>
        <button className="icon-btn" onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame (→)">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
        </button>
        <span className="tc"><b>{fmtClock(outNow, true)}</b> / {fmtClock(total, true)}</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={splitHere} title="Split this clip at the playhead (S)">Split</button>
        <button className="btn ghost sm" onClick={snapshot} title="Save this frame as a PNG">Save frame</button>
      </div>

      <div className="track" ref={trackRef} onPointerDown={startScrub}>
        <div className="ruler">
          {ticks.map(t => <span key={t} className="tick" style={{ left: pct(t) }}><i>{fmtClock(t)}</i></span>)}
        </div>
        {clips.map((c, i) => {
          const off = clipOffset(clips, c.id);
          return (
            <div key={c.id} className={'clip-block' + (c.id === clip.id ? ' current' : '')}
              style={{ left: pct(off), width: `calc(${pct(off + clipOutDur(c))} - ${pct(off)})` }} title={`${i + 1}. ${c.name}`}>
              {clips.length > 1 && <span>{i + 1}</span>}
            </div>
          );
        })}
        <div className="trim-handle" style={{ left: pct(offset) }} onPointerDown={startTrim('start')} title="Drag to set where this clip starts" />
        <div className="trim-handle end" style={{ left: pct(offset + clipOutDur(clip)) }} onPointerDown={startTrim('end')} title="Drag to set where this clip ends" />
        <div className="playhead" style={{ left: pct(outNow) }} />
      </div>
      <div className="trim-info">
        <span>{clips.length > 1 && <>Clip {clipNo} of {clips.length} · </>}Keep <b>{fmtClock(clip.trimStart, true)}</b>–<b>{fmtClock(clip.trimEnd, true)}</b> of this clip
          {clip.speed !== 1 && <> · plays in {fmtClock(clipOutDur(clip), true)} at {clip.speed}×</>}</span>
        {trimmed && <button className="link" onClick={() => patchClip(clip.id, { trimStart: 0, trimEnd: dur })}>Reset trim</button>}
      </div>
      <OverlayLanes total={total} now={outNow} />
      <HideLayers total={total} now={outNow} />
      <AudioLanes total={total} now={outNow} />
    </div>
  );
}

/** One row per watermark (logo or text), over the whole output video. Drag to move, drag the ends to change when it shows. */
function OverlayLanes({ total, now }: { total: number; now: number }) {
  const overlays = useStore(s => s.doc.overlays);
  const selId = useStore(s => s.selectedOverlayId);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dur = Math.max(total, 0.1);

  const tAt = (x: number) => {
    const r = rowsRef.current!.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * dur;
  };

  const select = (o: Overlay) =>
    useStore.setState({ selectedOverlayId: o.id, selectedAudioId: null, selectedSeg: null, stageMode: 'output', tool: o.kind === 'text' ? 'text' : 'logo' });

  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    pause();
    const side = (e.target as HTMLElement).dataset.side;
    const o = useStore.getState().doc.overlays.find(x => x.id === id)!;
    const t0 = tAt(e.clientX), s0 = clamp(o.start, 0, dur), e0 = Math.min(o.end, dur);
    select(o);
    const move = (ev: PointerEvent) => {
      const dt = tAt(ev.clientX) - t0;
      if (side === 'l') { const v = clamp(s0 + dt, 0, e0 - 0.1); seekOutput(v); patchOverlay(id, { start: v }, 'overlay-drag'); }
      else if (side === 'r') { const v = clamp(e0 + dt, s0 + 0.1, dur); seekOutput(v - 0.001); patchOverlay(id, { end: v >= dur - 0.001 ? FULL_END : v }, 'overlay-drag'); }
      else {
        const len = e0 - s0, st = clamp(s0 + dt, 0, Math.max(0, dur - len));
        seekOutput(st);
        patchOverlay(id, { start: st, end: e0 >= dur - 0.001 && st + len >= dur - 0.001 ? FULL_END : st + len }, 'overlay-drag');
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="layers">
      <div className="layers-head">Watermark — logos and text, whole video</div>
      <div className="layer-rows" ref={rowsRef}>
        {!overlays.length && <div className="layer-row" onPointerDown={e => { pause(); seekOutput(tAt(e.clientX)); }}><span className="layer-empty">Add a logo or text in the Logo or Text panel. Its timing shows up here.</span></div>}
        {overlays.map(o => {
          const st = clamp(o.start, 0, dur), en = clamp(o.end, 0, dur);
          const label = o.kind === 'text' ? o.text || 'Text' : o.name;
          return (
            <div key={o.id} className={'layer-row' + (o.id === selId ? ' active' : '')}
              onPointerDown={e => { if (e.target === e.currentTarget) { pause(); seekOutput(tAt(e.clientX)); select(o); } }}>
              {st < dur && (
                <div className={'seg-piece overlay-piece' + (o.id === selId ? ' on' : '')} onPointerDown={startDrag(o.id)}
                  style={{ left: st / dur * 100 + '%', width: (en - st) / dur * 100 + '%' }}
                  title={`${label}: ${fmtClock(st, true)}–${o.end >= FULL_END ? 'end' : fmtClock(en, true)}`}>
                  <span data-side="l" className="seg-h l" />
                  <span className="seg-label">{o.kind === 'text' ? 'T ' : '◩ '}{label}</span>
                  <span data-side="r" className="seg-h r" />
                </div>
              )}
            </div>
          );
        })}
        <div className="layer-playhead" style={{ left: clamp(now / dur, 0, 1) * 100 + '%' }} />
      </div>
    </div>
  );
}

function buildTicks(dur: number, width: number) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  let iv = steps[steps.length - 1];
  for (const s of steps) if (s / dur * width >= 70) { iv = s; break; }
  const out: number[] = [];
  for (let t = 0; t <= dur; t += iv) out.push(t);
  return out;
}

/** One row per logo-removal area, over the whole output video: the pieces are when that area is active. */
function HideLayers({ total, now }: { total: number; now: number }) {
  const hides = useStore(s => s.doc.hides);
  const activeId = useStore(s => s.activeHideId);
  const sel = useStore(s => s.selectedSeg);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dur = Math.max(total, 0.1);

  const tAt = (x: number) => {
    const r = rowsRef.current!.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * dur;
  };

  const startSeg = (hideId: string, segId: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    pause();
    const side = (e.target as HTMLElement).dataset.side;
    const h = useStore.getState().doc.hides.find(x => x.id === hideId)!;
    const seg = h.segments.find(s => s.id === segId)!;
    const t0 = tAt(e.clientX), s0 = seg.start, e0 = Math.min(seg.end, dur);
    useStore.setState({ activeHideId: hideId, selectedSeg: { hideId, segId }, tool: 'remove' });
    const move = (ev: PointerEvent) => {
      const dt = tAt(ev.clientX) - t0;
      const cur = useStore.getState().doc.hides.find(x => x.id === hideId)!;
      const segs = cur.segments.map(s => {
        if (s.id !== segId) return s;
        if (side === 'l') { const v = clamp(s0 + dt, 0, e0 - 0.1); seekOutput(v); return { ...s, start: v }; }
        if (side === 'r') { let v = clamp(e0 + dt, s0 + 0.1, dur); seekOutput(v - 0.001); if (v >= dur - 0.001) v = FULL_END; return { ...s, end: v }; }
        const len = e0 - s0; const st = clamp(s0 + dt, 0, Math.max(0, dur - len)); seekOutput(st);
        return { ...s, start: st, end: e0 >= dur - 0.001 && st + len >= dur - 0.001 ? FULL_END : st + len };
      });
      patchHide(hideId, { segments: segs }, 'seg-drag');
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="layers">
      <div className="layers-head">Remove watermark — when each area is active</div>
      <div className="layer-rows" ref={rowsRef}>
        {!hides.length && <div className="layer-row" onPointerDown={e => { pause(); seekOutput(tAt(e.clientX)); }}><span className="layer-empty">Add an area in the Remove panel. Its timing shows up here.</span></div>}
        {hides.map((h, i) => (
          <div key={h.id} className={'layer-row' + (h.id === activeId ? ' active' : '')}
            onPointerDown={e => { if (e.target === e.currentTarget) { pause(); seekOutput(tAt(e.clientX)); useStore.setState({ activeHideId: h.id, selectedSeg: null, tool: 'remove' }); } }}>
            {h.segments.filter(s => s.start < dur).map(s => {
              const st = clamp(s.start, 0, dur), en = clamp(s.end, 0, dur);
              const on = sel?.hideId === h.id && sel.segId === s.id;
              return (
                <div key={s.id} className={'seg-piece' + (on ? ' on' : '')} onPointerDown={startSeg(h.id, s.id)}
                  style={{ left: st / dur * 100 + '%', width: (en - st) / dur * 100 + '%' }}
                  title={`Area ${i + 1}: ${fmtClock(st, true)}–${fmtClock(en, true)}`}>
                  <span data-side="l" className="seg-h l" />
                  <span className="seg-label">Area {i + 1}</span>
                  <span data-side="r" className="seg-h r" />
                </div>
              );
            })}
          </div>
        ))}
        <div className="layer-playhead" style={{ left: clamp(now / dur, 0, 1) * 100 + '%' }} />
      </div>
    </div>
  );
}

/** Pack audio clips into as few rows as possible without overlaps. */
function packRows<T extends { start: number; len: number }>(items: T[]) {
  const rows: T[][] = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const row = rows.find(r => r[r.length - 1].start + r[r.length - 1].len <= it.start + 1e-6);
    if (row) row.push(it); else rows.push([it]);
  }
  return rows;
}

/** The added audio, laid out over the whole output video. Drag to move, drag the edges to trim. */
function AudioLanes({ total, now }: { total: number; now: number }) {
  const audio = useStore(s => s.doc.audio);
  const selId = useStore(s => s.selectedAudioId);
  const rowsRef = useRef<HTMLDivElement>(null);
  const span = Math.max(total, 0.1);

  const tAt = (x: number) => {
    const r = rowsRef.current!.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * span;
  };

  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    pause();
    const side = (e.target as HTMLElement).dataset.side;
    const ac = useStore.getState().doc.audio.clips.find(x => x.id === id)!;
    const dur = audio.sources.find(x => x.id === ac.sourceId)?.duration || ac.len;
    const t0 = tAt(e.clientX), s0 = ac.start, in0 = ac.in, len0 = ac.len;
    useStore.setState({ selectedAudioId: id, selectedOverlayId: null, selectedSeg: null, tool: 'audio' });
    const move = (ev: PointerEvent) => {
      const dt = tAt(ev.clientX) - t0;
      if (side === 'l') {
        // Trim the front: the start and the in-point move together.
        const lo = ac.loop ? 0 : Math.max(0, s0 - in0);
        const st = clamp(s0 + dt, lo, s0 + len0 - 0.1);
        let nin = in0 + (st - s0);
        if (ac.loop) nin = ((nin % dur) + dur) % dur;
        patchAudioClip(id, { start: st, in: nin, len: len0 - (st - s0) }, 'audio-drag');
      } else if (side === 'r') {
        const max = ac.loop ? Math.max(0.1, span - s0) : dur - in0;
        patchAudioClip(id, { len: clamp(len0 + dt, 0.1, max) }, 'audio-drag');
      } else {
        patchAudioClip(id, { start: clamp(s0 + dt, 0, Math.max(0, span - 0.1)) }, 'audio-drag');
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onLane = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    pause();
    seekOutput(tAt(e.clientX));
    useStore.setState({ selectedAudioId: null });
  };

  const rows = packRows(audio.clips);
  return (
    <div className="layers">
      <div className="layers-head">Audio — whole video</div>
      <div className="layer-rows" ref={rowsRef}>
        {!rows.length && <div className="layer-row" onPointerDown={onLane}><span className="layer-empty">Add audio in the Audio panel. It lands at the playhead and shows up here.</span></div>}
        {rows.map((row, i) => (
          <div key={i} className="layer-row" onPointerDown={onLane}>
            {row.filter(ac => ac.start < span).map(ac => {
              const src = audio.sources.find(x => x.id === ac.sourceId);
              const st = clamp(ac.start, 0, span), en = clamp(ac.start + ac.len, 0, span);
              return (
                <div key={ac.id} className={'seg-piece audio-piece' + (ac.id === selId ? ' on' : '')} onPointerDown={startDrag(ac.id)}
                  style={{ left: st / span * 100 + '%', width: (en - st) / span * 100 + '%' }}
                  title={`${src?.name ?? 'Audio'}: ${fmtClock(ac.start, true)}–${fmtClock(ac.start + ac.len, true)}${ac.loop ? ' (loops)' : ''}`}>
                  <span data-side="l" className="seg-h l" />
                  <span className="seg-label">{ac.loop ? '↻ ' : '♪ '}{src?.name ?? 'Audio'}</span>
                  <span data-side="r" className="seg-h r" />
                </div>
              );
            })}
          </div>
        ))}
        <div className="layer-playhead" style={{ left: clamp(now / span, 0, 1) * 100 + '%' }} />
      </div>
    </div>
  );
}
