// Preview playback: one <video> element that hops between clips, plus an <audio> per added audio clip.
import { useStore, currentClip, notify } from './store';
import { probeClip } from './engine/media';
import { clamp, fromOutputTime, toOutputTime } from './engine/timeline';
import type { Clip } from './types';

export const video = document.createElement('video');
video.playsInline = true;
video.preload = 'auto';
video.crossOrigin = 'anonymous';
(video as any).preservesPitch = false; // match the export, where speed changes pitch too

const audioEls = new Map<string, HTMLAudioElement>();   // per audio clip
const sourceUrls = new Map<string, string>();            // per audio source
let loadedClipId: string | null = null;
let loadedUrl: string | null = null;
let pendingSeek: number | null = null;
let autoplay = false;

export const videoReady = () => !!loadedClipId && video.readyState >= 2 && loadedClipId === useStore.getState().currentClipId;

function applyClipAudio(c: Clip) {
  video.muted = c.muted;
  video.volume = Math.min(1, c.volume);
  video.playbackRate = c.speed;
}

/** Keep the <video> pointed at the current clip; called every frame by the stage loop. */
export function syncPlayer() {
  const s = useStore.getState();
  const c = currentClip(s);
  if (!c) { if (loadedClipId) { video.removeAttribute('src'); video.load(); loadedClipId = null; loadedUrl = null; } return; }
  if (c.id !== loadedClipId || c.url !== loadedUrl) {
    loadedClipId = c.id;
    loadedUrl = c.url;
    video.src = c.url;
    const target = pendingSeek ?? c.trimStart;
    pendingSeek = null;
    video.onloadedmetadata = () => {
      video.currentTime = target;
      applyClipAudio(c);
      if (autoplay) { autoplay = false; video.play().catch(() => {}); }
    };
  }
  applyClipAudio(c);
  syncAudio();

  if (s.playing && !video.paused) {
    if (video.currentTime >= c.trimEnd - 0.03 || video.ended) advance();
  }
  if (Math.abs(s.time - video.currentTime) > 0.03) useStore.setState({ time: video.currentTime });
}

function advance() {
  const s = useStore.getState();
  const i = s.doc.clips.findIndex(c => c.id === s.currentClipId);
  const next = s.doc.clips[i + 1];
  if (next) {
    pendingSeek = next.trimStart;
    autoplay = true;
    useStore.setState({ currentClipId: next.id, time: next.trimStart });
  } else {
    pause();
  }
}

export function play() {
  const c = currentClip();
  if (!c) return;
  if (video.currentTime < c.trimStart - 0.01 || video.currentTime >= c.trimEnd - 0.05) video.currentTime = c.trimStart;
  video.play().catch(e => notify('Playback failed: ' + e.message, 'error'));
  useStore.setState({ playing: true });
}

export function pause() {
  video.pause();
  audioEls.forEach(el => el.pause());
  useStore.setState({ playing: false });
}

export const togglePlay = () => (useStore.getState().playing ? pause() : play());

export function seek(t: number) {
  const c = currentClip();
  if (!c) return;
  video.currentTime = Math.max(0, Math.min(c.duration, t));
  useStore.setState({ time: video.currentTime });
}

export function stepFrame(dir: 1 | -1) {
  pause();
  seek(video.currentTime + dir / 30);
}

/** Switch the editor to another clip, optionally at a source time. */
export function selectClip(id: string, at?: number) {
  const s = useStore.getState();
  const c = s.doc.clips.find(x => x.id === id);
  if (!c) return;
  if (s.currentClipId === id) { if (at != null) seek(at); return; }
  pause();
  pendingSeek = at ?? c.trimStart;
  useStore.setState({ currentClipId: id, time: pendingSeek });
}

/** Where the playhead is on the output timeline. */
export function outputNow() {
  const s = useStore.getState();
  const c = currentClip(s);
  if (!c) return 0;
  return toOutputTime(s.doc.clips, c, clamp(videoReady() ? video.currentTime : s.time, c.trimStart, c.trimEnd));
}

/** Jump to a point on the output timeline, switching clips if needed. */
export function seekOutput(t: number) {
  const hit = fromOutputTime(useStore.getState().doc.clips, t);
  if (hit) selectClip(hit.clip.id, hit.src);
}

// ---- Added audio preview, kept in sync with the output timeline every frame ----
function syncAudio() {
  const s = useStore.getState();
  const a = s.doc.audio;
  for (const [id, el] of audioEls) {
    if (!a.clips.some(x => x.id === id)) { el.pause(); el.removeAttribute('src'); audioEls.delete(id); }
  }
  for (const [id, url] of sourceUrls) {
    if (!a.sources.some(x => x.id === id)) { URL.revokeObjectURL(url); sourceUrls.delete(id); }
  }
  const c = currentClip(s);
  // While the next clip is still loading, leave the audio as it is.
  const t = c && videoReady() ? toOutputTime(s.doc.clips, c, video.currentTime) : null;
  const duck = a.duck && c && c.hasAudio && !c.muted ? 0.35 : 1;
  for (const ac of a.clips) {
    const src = a.sources.find(x => x.id === ac.sourceId);
    if (!src) continue;
    let url = sourceUrls.get(src.id);
    if (!url) { url = URL.createObjectURL(src.file); sourceUrls.set(src.id, url); }
    let el = audioEls.get(ac.id);
    if (!el) { el = new Audio(); el.preload = 'auto'; audioEls.set(ac.id, el); }
    if (el.src !== url) el.src = url;
    el.loop = ac.loop;
    el.volume = Math.min(1, ac.volume * duck);
    if (t == null) { if (!s.playing) el.pause(); continue; }
    const local = t - ac.start;
    let pos = ac.in + local;
    if (ac.loop && src.duration) pos %= src.duration;
    const active = s.playing && local >= 0 && local < ac.len && (ac.loop || pos < src.duration);
    if (!active) { if (!el.paused) el.pause(); continue; }
    let drift = Math.abs(el.currentTime - pos);
    if (ac.loop && src.duration) drift = Math.min(drift, src.duration - drift);
    if (drift > 0.25) el.currentTime = pos;
    if (el.paused) el.play().catch(() => {});
  }
}

// ---- Adding media ----
export async function addVideoFiles(files: File[]) {
  const vids = files.filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|ts)$/i.test(f.name));
  if (!vids.length) { notify('Those files aren’t videos. Drop an MP4, MOV, WebM or MKV.', 'error'); return; }
  for (const f of vids) {
    try {
      const clip = await probeClip(f);
      useStore.getState().edit(d => ({ ...d, clips: [...d.clips, clip] }));
      if (!useStore.getState().currentClipId) useStore.setState({ currentClipId: clip.id, time: 0 });
    } catch (e: any) {
      notify(e.message ?? String(e), 'error');
    }
  }
}
