// Preview playback: one <video> element that hops between clips, plus an <audio> for background music.
import { useStore, currentClip, notify } from './store';
import { probeClip } from './engine/media';
import { toOutputTime } from './engine/timeline';
import type { Clip } from './types';

export const video = document.createElement('video');
video.playsInline = true;
video.preload = 'auto';
video.crossOrigin = 'anonymous';
(video as any).preservesPitch = false; // match the export, where speed changes pitch too

const music = document.createElement('audio');
let musicUrl: string | null = null;
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
      if (autoplay) { autoplay = false; video.play().catch(() => {}); syncMusic(true); }
    };
  }
  applyClipAudio(c);
  syncMusicSource();

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
  video.play().then(() => syncMusic(true)).catch(e => notify('Playback failed: ' + e.message, 'error'));
  useStore.setState({ playing: true });
}

export function pause() {
  video.pause();
  music.pause();
  useStore.setState({ playing: false });
}

export const togglePlay = () => (useStore.getState().playing ? pause() : play());

export function seek(t: number) {
  const c = currentClip();
  if (!c) return;
  video.currentTime = Math.max(0, Math.min(c.duration, t));
  useStore.setState({ time: video.currentTime });
  syncMusic(false);
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

// ---- Music preview, kept roughly in sync with the output timeline ----
function syncMusicSource() {
  const m = useStore.getState().doc.audio.music;
  if (!m) { if (musicUrl) { music.pause(); music.removeAttribute('src'); URL.revokeObjectURL(musicUrl); musicUrl = null; } return; }
  if (!musicUrl || music.dataset.id !== m.id) {
    if (musicUrl) URL.revokeObjectURL(musicUrl);
    musicUrl = URL.createObjectURL(m.file);
    music.src = musicUrl;
    music.dataset.id = m.id;
  }
  const s = useStore.getState();
  const c = currentClip(s);
  const a = s.doc.audio;
  music.volume = Math.min(1, a.musicVolume * (a.duck && c && c.hasAudio && !c.muted ? 0.35 : 1));
  music.loop = a.musicLoop;
}

function syncMusic(start: boolean) {
  const s = useStore.getState();
  const m = s.doc.audio.music;
  const c = currentClip(s);
  if (!m || !c || !musicUrl) return;
  const mt = toOutputTime(s.doc.clips, c, video.currentTime) - s.doc.audio.musicOffset;
  if (mt < 0 || (!s.doc.audio.musicLoop && mt >= m.duration)) { music.pause(); return; }
  music.currentTime = s.doc.audio.musicLoop && m.duration ? mt % m.duration : mt;
  if (start || s.playing) music.play().catch(() => {});
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
