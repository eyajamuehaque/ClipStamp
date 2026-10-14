// Autosave to this browser's IndexedDB — including the video files themselves, so a refresh
// (or reopening the installed app offline) brings the whole project back. Nothing leaves the device.
import type { Doc } from '../types';
import { emptyDoc } from '../defaults';

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
    audio: { ...doc.audio, music: doc.audio.music ? { ...doc.audio.music, file: undefined } : null },
  };
}

export async function saveProject(doc: Doc) {
  const db = await open();
  const ids = new Set<string>();
  for (const c of doc.clips) {
    ids.add(c.id);
    if (!savedFiles.has(c.id)) { await tx(db, STORE_FILES, 'readwrite', s => s.put(c.file, c.id)); savedFiles.add(c.id); }
  }
  const m = doc.audio.music;
  if (m) {
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
      clips.push({ ...c, file, url: URL.createObjectURL(file) });
    }
    let music = null;
    if (stored.audio?.music) {
      const file = await tx<File>(db, STORE_FILES, 'readonly', s => s.get(stored.audio.music.id));
      if (file) { savedFiles.add(stored.audio.music.id); music = { ...stored.audio.music, file }; }
    }
    db.close();
    return {
      ...base, ...stored,
      color: { ...base.color, ...stored.color },
      framing: { ...base.framing, ...stored.framing },
      output: { ...base.output, ...stored.output },
      audio: { ...base.audio, ...stored.audio, music },
      clips,
    };
  } catch (e) {
    console.warn('Could not restore the autosaved project', e);
    return null;
  }
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
    return { ...c, trimStart: m.trimStart, trimEnd: m.trimEnd, rotation: m.rotation, speed: m.speed, volume: m.volume ?? 1, muted: !!m.muted };
  });
  return {
    doc: {
      ...current,
      overlays: s.overlays ?? [], hides: s.hides ?? [],
      hidesEnabled: s.hidesEnabled ?? true, overlaysEnabled: s.overlaysEnabled ?? true,
      color: { ...base.color, ...s.color }, framing: { ...base.framing, ...s.framing },
      output: { ...base.output, ...s.output }, audio: { ...current.audio, ...s.audio, music: current.audio.music },
      clips,
    },
    matched, wanted: wanted.length,
  };
}
