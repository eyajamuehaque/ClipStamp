import { create } from 'zustand';
import type { Clip, Doc, HideRegion, Overlay } from './types';
import { emptyDoc } from './defaults';

export type Tool = 'media' | 'text' | 'logo' | 'remove' | 'adjust' | 'color' | 'audio' | 'export';
export type StageMode = 'output' | 'crop' | 'hide';

interface UI {
  tool: Tool;
  stageMode: StageMode;
  currentClipId: string | null;
  selectedOverlayId: string | null;
  activeHideId: string | null;
  selectedSeg: { hideId: string; segId: string } | null;
  playing: boolean;
  time: number;              // source time of the current clip
  exporting: boolean;
  notice: { text: string; kind: 'info' | 'error' } | null;
}

interface State extends UI {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  lastKey: string | null;
  lastAt: number;
  /** Change the document. Edits with the same `key` within 700ms merge into one undo step (slider drags). */
  edit: (fn: (d: Doc) => Doc, key?: string) => void;
  undo: () => void;
  redo: () => void;
  replaceDoc: (d: Doc) => void;
  setUI: (p: Partial<UI>) => void;
}

const HISTORY = 80;

export const useStore = create<State>((set, get) => ({
  tool: 'media',
  stageMode: 'output',
  currentClipId: null,
  selectedOverlayId: null,
  activeHideId: null,
  selectedSeg: null,
  playing: false,
  time: 0,
  exporting: false,
  notice: null,

  doc: emptyDoc(),
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,

  edit: (fn, key) => {
    const s = get();
    const next = fn(s.doc);
    if (next === s.doc) return;
    const now = performance.now();
    const merge = key != null && key === s.lastKey && now - s.lastAt < 700;
    set({
      doc: next,
      past: merge ? s.past : [...s.past.slice(-HISTORY), s.doc],
      future: [],
      lastKey: key ?? null,
      lastAt: now,
    });
  },
  undo: () => {
    const s = get();
    if (!s.past.length) return;
    const prev = s.past[s.past.length - 1];
    set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], lastKey: null });
    fixSelection();
  },
  redo: () => {
    const s = get();
    if (!s.future.length) return;
    set({ doc: s.future[0], future: s.future.slice(1), past: [...s.past, s.doc], lastKey: null });
    fixSelection();
  },
  replaceDoc: (d) => { set({ doc: d, past: [], future: [], lastKey: null }); fixSelection(); },
  setUI: (p) => set(p),
}));

// After undo/redo, make sure selections still point at things that exist.
function fixSelection() {
  const s = useStore.getState();
  const p: Partial<UI> = {};
  if (!s.doc.clips.find(c => c.id === s.currentClipId)) p.currentClipId = s.doc.clips[0]?.id ?? null;
  if (s.selectedOverlayId && !s.doc.overlays.find(o => o.id === s.selectedOverlayId)) p.selectedOverlayId = null;
  if (s.activeHideId && !s.doc.hides.find(h => h.id === s.activeHideId)) { p.activeHideId = null; p.selectedSeg = null; }
  if (Object.keys(p).length) useStore.setState(p);
}

// ---- Small, typed update helpers ----
export const edit = (fn: (d: Doc) => Doc, key?: string) => useStore.getState().edit(fn, key);

export function patchClip(id: string, patch: Partial<Clip>, key?: string) {
  edit(d => ({ ...d, clips: d.clips.map(c => c.id === id ? { ...c, ...patch } : c) }), key);
}
export function patchOverlay(id: string, patch: Partial<Overlay>, key?: string) {
  edit(d => ({ ...d, overlays: d.overlays.map(o => o.id === id ? ({ ...o, ...patch } as Overlay) : o) }), key);
}
export function patchHide(id: string, patch: Partial<HideRegion>, key?: string) {
  edit(d => ({ ...d, hides: d.hides.map(h => h.id === id ? { ...h, ...patch } : h) }), key);
}
export function patchDoc<K extends keyof Doc>(k: K, patch: Partial<Doc[K]>, key?: string) {
  edit(d => ({ ...d, [k]: { ...(d[k] as object), ...(patch as object) } }), key);
}

export const currentClip = (s: State = useStore.getState()) =>
  s.doc.clips.find(c => c.id === s.currentClipId) ?? null;
export const useCurrentClip = () => useStore(s => s.doc.clips.find(c => c.id === s.currentClipId) ?? null);

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: 'info' | 'error' = 'info') {
  useStore.setState({ notice: { text, kind } });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => useStore.setState({ notice: null }), kind === 'error' ? 7000 : 3500);
}
