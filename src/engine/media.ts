import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { Clip } from '../types';
import { uid } from '../defaults';

/** Read a video file's basics (size, length, audio) and grab a thumbnail, without uploading anything. */
export async function probeClip(file: File, id = uid()): Promise<Clip> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error(`"${file.name}" can't be opened in this browser.`));
  });
  const duration = isFinite(v.duration) ? v.duration : 0;
  let hasAudio = true;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    hasAudio = !!(await input.getPrimaryAudioTrack());
    input.dispose();
  } catch { /* keep the optimistic default */ }

  let thumb: string | undefined;
  try {
    v.currentTime = Math.min(1, duration / 3);
    await new Promise(r => { v.onseeked = r; setTimeout(r, 1500); });
    const c = document.createElement('canvas');
    const tw = 160, th = Math.round(tw * v.videoHeight / v.videoWidth) || 90;
    c.width = tw; c.height = th;
    c.getContext('2d')!.drawImage(v, 0, 0, tw, th);
    thumb = c.toDataURL('image/jpeg', 0.7);
  } catch { /* thumbnails are optional */ }

  return {
    id, file, url, name: file.name, size: file.size, duration,
    width: v.videoWidth, height: v.videoHeight, hasAudio, thumb,
    trimStart: 0, trimEnd: duration, rotation: 0, speed: 1, volume: 1, muted: false,
  };
}

export async function probeAudio(file: File) {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  a.src = URL.createObjectURL(file);
  await new Promise<void>((res, rej) => {
    a.onloadedmetadata = () => res();
    a.onerror = () => rej(new Error(`"${file.name}" isn't an audio file this browser can play.`));
  });
  const d = a.duration;
  URL.revokeObjectURL(a.src);
  return { id: uid(), name: file.name, file, duration: isFinite(d) ? d : 0 };
}

export function readImage(file: File): Promise<{ dataUrl: string; aspect: number }> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => res({ dataUrl: r.result as string, aspect: img.naturalWidth / img.naturalHeight });
      img.onerror = () => rej(new Error('That image could not be read.'));
      img.src = r.result as string;
    };
    r.readAsDataURL(file);
  });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
