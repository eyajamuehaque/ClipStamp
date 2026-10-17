// Autosave to this browser's IndexedDB — including the video files themselves, so a refresh
// (or reopening the installed app offline) brings the whole project back. Nothing leaves the device.
import type { AudioClip, AudioSettings, AudioSource, Doc } from '../types';
import { emptyDoc, uid } from '../defaults';
import { totalDuration } from './timeline';

const DB = 'clipsmith';
const STORE_DOC = 'doc';
const STORE_FILES = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(STORE_DOC);
      r.result.createObjectStore(STORE_FILES);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? (req as IDBRequest<T>).result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const savedFiles = new Set<string>();

/** Strip non-serialisable parts (File objects, object URLs). */
function toStored(doc: Doc) {
  return {
    ...doc,
    clips: doc.clips.map(({ file: _f, url: _u, ...rest }) => rest),
    audio: { ...doc.audio, sources: doc.audio.sources.map(({ file: _f, ...rest }) => rest) },
  };
}

export async function saveProject(doc: Doc) {
  const db = await open();
  const ids = new Set<string>();
  for (const c of doc.clips) {
    ids.add(c.id);
    if (!savedFiles.has(c.id)) { await tx(db, STORE_FILES, 'readwrite', s => s.put(c.file, c.id)); savedFiles.add(c.id); }
  }
  for (const m of doc.audio.sources) {
    ids.add(m.id);
    if (!savedFiles.has(m.id)) { await tx(db, STORE_FILES, 'readwrite', s => s.put(m.file, m.id)); savedFiles.add(m.id); }
  }
  await tx(db, STORE_DOC, 'readwrite', s => s.put(toStored(doc), 'current'));
  // Drop files that are no longer used anywhere.
  const keys = (await tx<IDBValidKey[]>(db, STORE_FILES, 'readonly', s => s.getAllKeys())) ?? [];
  for (const k of keys) if (!ids.has(String(k))) { await tx(db, STORE_FILES, 'readwrite', s => s.delete(k)); savedFiles.delete(String(k)); }
  db.close();
}

export async function loadProject(): Promise<Doc | null> {
  try {
    const db = await open();
    const stored = await tx<any>(db, STORE_DOC, 'readonly', s => s.get('current'));
    if (!stored) { db.close(); return null; }
    const base = emptyDoc();
    const clips = [];
    for (const c of stored.clips ?? []) {
      const file = await tx<File>(db, STORE_FILES, 'readonly', s => s.get(c.id));
      if (!file) continue;
      savedFiles.add(c.id);
      // Older saves kept one crop for the whole project; give it to every clip.
      clips.push({ crop: stored.framing?.crop ?? null, cropLock: stored.framing?.cropLock ?? null, ...c, file, url: URL.createObjectURL(file) });
    }
    const audio = migrateAudio(stored.audio ?? {}, totalDuration(clips));
    const sources: AudioSource[] = [];
    for (const m of audio.sources) {
      const file = await tx<File>(db, STORE_FILES, 'readonly', s => s.get(m.id));
      if (file) { savedFiles.add(m.id); sources.push({ ...m, file }); }
    }
    db.close();
    const { crop: _c, cropLock: _l, ...framing } = stored.framing ?? {};
    return {
      ...base, ...stored,
      color: { ...base.color, ...stored.color },
      framing: { ...base.framing, ...framing },
      output: { ...base.output, ...stored.output },
      audio: { ...base.audio, ...audio, sources, clips: audio.clips.filter(a => sources.some(src => src.id === a.sourceId)) },
      clips,
    };
  } catch (e) {
    console.warn('Could not restore the autosaved project', e);
    return null;
  }
}

/** Older saves had a single `music` track; turn it into one audio clip. */
function migrateAudio(a: any, total: number): Omit<AudioSettings, 'sources'> & { sources: any[] } {
  if (Array.isArray(a.sources)) return a;
  const { music, musicVolume, musicOffset, musicLoop, ...rest } = a;
  const clips: AudioClip[] = [];
  if (music) {
    const start = musicOffset ?? 0;
    const len = musicLoop !== false ? Math.max(0.1, total - start) : music.duration;
    clips.push({ id: uid(), sourceId: music.id, start, in: 0, len, volume: musicVolume ?? 0.6, loop: musicLoop !== false });
  }
  return { ...emptyDoc().audio, ...rest, sources: music ? [music] : [], clips };
}

export async function clearProject() {
  const db = await open();
  await tx(db, STORE_DOC, 'readwrite', s => s.clear());
  await tx(db, STORE_FILES, 'readwrite', s => s.clear());
  savedFiles.clear();
  db.close();
}

/** Portable settings file (no video data), re-matched to clips by file name + size. */
export function projectToJson(doc: Doc) {
  return JSON.stringify({ format: 'clipsmith', version: 1, savedAt: new Date().toISOString(), doc: toStored(doc) }, null, 2);
}

export function applyProjectJson(current: Doc, text: string): { doc: Doc; matched: number; wanted: number } {
  const data = JSON.parse(text);
  if (data?.format !== 'clipsmith' || !data.doc) throw new Error('That isn’t a Clipsmith project file.');
  const s = data.doc;
  const base = emptyDoc();
  const wanted: any[] = s.clips ?? [];
  let matched = 0;
  const clips = current.clips.map(c => {
    const m = wanted.find(w => w.name === c.name && w.size === c.size);
    if (!m) return c;
    matched++;
    return {
      ...c, trimStart: m.trimStart, trimEnd: m.trimEnd, rotation: m.rotation, speed: m.speed, volume: m.volume ?? 1, muted: !!m.muted,
      crop: m.crop ?? s.framing?.crop ?? null, cropLock: m.cropLock ?? s.framing?.cropLock ?? null,
    };
  });
  return {
    doc: {
      ...current,
      overlays: s.overlays ?? [], hides: s.hides ?? [],
      hidesEnabled: s.hidesEnabled ?? true, overlaysEnabled: s.overlaysEnabled ?? true,
      color: { ...base.color, ...s.color }, framing: { ...base.framing, flipH: !!s.framing?.flipH, flipV: !!s.framing?.flipV, aspect: s.framing?.aspect ?? base.framing.aspect, bg: s.framing?.bg ?? base.framing.bg, bgColor: s.framing?.bgColor ?? base.framing.bgColor },
      // Audio files aren't in the settings file, so keep the current audio and only take the mix settings.
      output: { ...base.output, ...s.output },
      audio: { ...current.audio, duck: s.audio?.duck ?? current.audio.duck, fadeIn: s.audio?.fadeIn ?? 0, fadeOut: s.audio?.fadeOut ?? 0, videoFade: s.audio?.videoFade ?? true },
      clips,
    },
    matched, wanted: wanted.length,
  };
}
