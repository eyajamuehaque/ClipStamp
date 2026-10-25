import { useState } from 'react';
import { useStore } from '../store';
import { selectClip, addVideoFiles } from '../player';
import { clipOutDur, fmtClock, totalDuration } from '../engine/timeline';
import { uid } from '../defaults';

/** The film strip: every clip in play order. Drag to reorder. */
export default function ClipStrip() {
  const clips = useStore(s => s.doc.clips);
  const current = useStore(s => s.currentClipId);
  const edit = useStore(s => s.edit);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (!clips.length) return null;
  const total = totalDuration(clips);

  const move = (from: string, to: string) => edit(d => {
    const list = [...d.clips];
    const i = list.findIndex(c => c.id === from), j = list.findIndex(c => c.id === to);
    const [c] = list.splice(i, 1);
    list.splice(j, 0, c);
    return { ...d, clips: list };
  });

  const remove = (id: string) => {
    const s = useStore.getState();
    const i = s.doc.clips.findIndex(c => c.id === id);
    edit(d => ({ ...d, clips: d.clips.filter(c => c.id !== id) }));
    if (s.currentClipId === id) {
      const rest = useStore.getState().doc.clips;
      useStore.setState({ currentClipId: rest[Math.min(i, rest.length - 1)]?.id ?? null, playing: false });
    }
  };

  const removeAll = () => {
    if (!confirm(`Remove all ${clips.length} clips? You can undo this.`)) return;
    edit(d => ({ ...d, clips: [] }));
    useStore.setState({ currentClipId: null, playing: false });
  };

  return (
    <div className="strip-wrap">
      <div className="strip-head">
        <span>{clips.length} clip{clips.length > 1 ? 's' : ''} · {fmtClock(total, true)} total</span>
        <span className="strip-actions">
          <button className="link" onClick={removeAll}>Remove all</button>
          <label className="link">
            Add videos
            <input type="file" accept="video/*" multiple hidden onChange={e => { addVideoFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </label>
        </span>
      </div>
      <ol className="strip" aria-label="Clips in play order">
        {clips.map((c, i) => {
          const w = Math.max(96, Math.min(240, clipOutDur(c) / Math.max(total, 1) * 900));
          return (
            <li key={c.id} draggable
              className={'frame' + (c.id === current ? ' current' : '') + (overId === c.id && dragId !== c.id ? ' drop-target' : '')}
              style={{ width: w }}
              onDragStart={e => { setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={e => { if (dragId) { e.preventDefault(); setOverId(c.id); } }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDrop={e => { e.preventDefault(); if (dragId && dragId !== c.id) move(dragId, c.id); setDragId(null); setOverId(null); }}>
              <button className="frame-body" onClick={() => selectClip(c.id)} title={c.name}>
                <span className="frame-img" style={c.thumb ? { backgroundImage: `url(${c.thumb})` } : undefined} />
                <span className="frame-meta">
                  <span className="frame-no">{i + 1}</span>
                  <span className="frame-name">{c.name}</span>
                  <span className="frame-dur">{fmtClock(clipOutDur(c), true)}{c.speed !== 1 ? ` · ${c.speed}×` : ''}{c.muted ? ' · muted' : ''}</span>
                </span>
              </button>
              <span className="frame-tools">
                <button title="Duplicate clip" aria-label={`Duplicate ${c.name}`}
                  onClick={() => edit(d => { const l = [...d.clips]; l.splice(i + 1, 0, { ...c, id: uid() }); return { ...d, clips: l }; })}>⧉</button>
                <button title="Remove clip" aria-label={`Remove ${c.name}`} onClick={() => remove(c.id)}>×</button>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
