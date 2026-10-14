import { useRef } from 'react';
import { useStore, useCurrentClip, patchClip, patchHide } from '../store';
import { togglePlay, seek, stepFrame, pause, video } from '../player';
import { clipOffset, clipOutDur, fmtClock, totalDuration, clamp, outputSize, toOutputTime } from '../engine/timeline';
import { createRenderer } from '../engine/render';
import { download } from '../engine/media';
import { FULL_END } from '../types';
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
  const outNow = clipOffset(clips, clip.id) + (clamp(time, clip.trimStart, clip.trimEnd) - clip.trimStart) / clip.speed;
  const pct = (t: number) => clamp(t / dur, 0, 1) * 100 + '%';

  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * dur;
  };

  const startScrub = (e: React.PointerEvent) => {
    pause();
    seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startTrim = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation();
    pause();
    const move = (ev: PointerEvent) => {
      const c = useStore.getState().doc.clips.find(x => x.id === clip.id)!;
      const t = timeAt(ev.clientX);
      if (which === 'start') { const v = clamp(t, 0, c.trimEnd - TRIM_GAP); patchClip(clip.id, { trimStart: v }, 'trim'); seek(v); }
      else { const v = clamp(t, c.trimStart + TRIM_GAP, dur); patchClip(clip.id, { trimEnd: v }, 'trim'); seek(v); }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e.nativeEvent);
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
      clip, s.doc, video.currentTime, toOutputTime(s.doc.clips, clip, video.currentTime), total);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    download(blob, clip.name.replace(/\.[^.]+$/, '') + '-' + fmtClock(video.currentTime).replace(/:/g, '-') + '.png');
  };

  const ticks = buildTicks(dur, trackRef.current?.clientWidth ?? 600);
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
        <div className="trim-mask" style={{ left: 0, width: pct(clip.trimStart) }} />
        <div className="trim-mask" style={{ left: pct(clip.trimEnd), right: 0 }} />
        <div className="trim-range" style={{ left: pct(clip.trimStart), width: `calc(${pct(clip.trimEnd)} - ${pct(clip.trimStart)})` }} />
        <div className="trim-handle" style={{ left: pct(clip.trimStart) }} onPointerDown={startTrim('start')} title="Drag to set where this clip starts" />
        <div className="trim-handle end" style={{ left: pct(clip.trimEnd) }} onPointerDown={startTrim('end')} title="Drag to set where this clip ends" />
        <div className="playhead" style={{ left: pct(time) }} />
      </div>
      <div className="trim-info">
        <span>Keep <b>{fmtClock(clip.trimStart, true)}</b>–<b>{fmtClock(clip.trimEnd, true)}</b> of this clip
          {clip.speed !== 1 && <> · plays in {fmtClock(clipOutDur(clip), true)} at {clip.speed}×</>}</span>
        {trimmed && <button className="link" onClick={() => patchClip(clip.id, { trimStart: 0, trimEnd: dur })}>Reset trim</button>}
      </div>
      <HideLayers dur={dur} />
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

/** One row per logo-removal area: the pieces are when that area is active. */
function HideLayers({ dur }: { dur: number }) {
  const hides = useStore(s => s.doc.hides);
  const activeId = useStore(s => s.activeHideId);
  const sel = useStore(s => s.selectedSeg);
  const time = useStore(s => s.time);
  const tool = useStore(s => s.tool);
  const rowsRef = useRef<HTMLDivElement>(null);
  if (!hides.length && tool !== 'remove') return null;

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
        if (side === 'l') { const v = clamp(s0 + dt, 0, e0 - 0.1); seek(v); return { ...s, start: v }; }
        if (side === 'r') { let v = clamp(e0 + dt, s0 + 0.1, dur); seek(v - 0.001); if (v >= dur - 0.001) v = FULL_END; return { ...s, end: v }; }
        const len = e0 - s0; const st = clamp(s0 + dt, 0, Math.max(0, dur - len)); seek(st);
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
      <div className="layers-head">Logo areas — when each one is active</div>
      <div className="layer-rows" ref={rowsRef}>
        {!hides.length && <div className="layer-row"><span className="layer-empty">Draw a box in “Logo areas” view to add one. Its timing shows up here.</span></div>}
        {hides.map((h, i) => (
          <div key={h.id} className={'layer-row' + (h.id === activeId ? ' active' : '')}
            onPointerDown={e => { if (e.target === e.currentTarget) { pause(); seek(tAt(e.clientX)); useStore.setState({ activeHideId: h.id, selectedSeg: null, tool: 'remove' }); } }}>
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
        <div className="layer-playhead" style={{ left: clamp(time / dur, 0, 1) * 100 + '%' }} />
      </div>
    </div>
  );
}
