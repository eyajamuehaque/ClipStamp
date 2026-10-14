import type { ColorSettings, Doc, HideRegion, ImageOverlay, TextOverlay } from './types';
import { FULL_END } from './types';

export const uid = () => Math.random().toString(36).slice(2, 10);

// All fonts are bundled with the app (via @fontsource), so text renders the same online and offline.
export const FONTS: Record<string, { label: string; css: string; weight: number; group: string }> = {
  anton: { label: 'Anton', css: '"Anton", sans-serif', weight: 400, group: 'Bold display' },
  bebas: { label: 'Bebas Neue', css: '"Bebas Neue", sans-serif', weight: 400, group: 'Bold display' },
  oswald: { label: 'Oswald', css: '"Oswald", sans-serif', weight: 700, group: 'Bold display' },
  bricolage: { label: 'Bricolage', css: '"Bricolage Grotesque Variable", sans-serif', weight: 700, group: 'Clean' },
  plex: { label: 'Plex Mono', css: '"IBM Plex Mono", monospace', weight: 500, group: 'Clean' },
  marker: { label: 'Permanent Marker', css: '"Permanent Marker", cursive', weight: 400, group: 'Hand drawn' },
  georgia: { label: 'Georgia', css: 'Georgia, serif', weight: 700, group: 'System' },
  arial: { label: 'Arial Black', css: '"Arial Black", Arial, sans-serif', weight: 900, group: 'System' },
  courier: { label: 'Courier', css: '"Courier New", monospace', weight: 700, group: 'System' },
};

export const DEFAULT_COLOR: ColorSettings = {
  preset: 'none', brightness: 100, contrast: 100, saturation: 100, hue: 0,
  temperature: 0, vignette: 0, grayscale: 0, sepia: 0, blur: 0,
};

export const COLOR_PRESETS: { id: string; label: string; v: Partial<ColorSettings> }[] = [
  { id: 'none', label: 'Original', v: {} },
  { id: 'vivid', label: 'Vivid', v: { contrast: 112, saturation: 140 } },
  { id: 'warm', label: 'Golden', v: { temperature: 45, saturation: 112, brightness: 104 } },
  { id: 'cool', label: 'Nordic', v: { temperature: -45, saturation: 90, contrast: 106 } },
  { id: 'mono', label: 'Mono', v: { grayscale: 100, contrast: 118 } },
  { id: 'vintage', label: 'Vintage', v: { sepia: 45, contrast: 92, saturation: 85, vignette: 45 } },
  { id: 'cine', label: 'Cinema', v: { contrast: 118, saturation: 85, temperature: -12, vignette: 35 } },
  { id: 'faded', label: 'Faded', v: { contrast: 82, brightness: 110, saturation: 78 } },
  { id: 'drama', label: 'Drama', v: { contrast: 135, brightness: 92, saturation: 110, vignette: 55 } },
  { id: 'teal', label: 'Teal & orange', v: { temperature: 25, hue: -8, saturation: 125, contrast: 110 } },
];

export function newText(n: number): TextOverlay {
  return {
    id: uid(), kind: 'text', text: n === 1 ? '© your name' : 'Text ' + n, font: 'anton', size: 64,
    color: '#ffffff', opacity: 90, rotation: 0, x: 0.5, y: n === 1 ? 0.88 : 0.5, align: 'center',
    outline: 0, outlineColor: '#000000', box: false, boxColor: '#000000', boxOpacity: 55,
    shadow: true, motion: 'none', speed: 8, entrance: 'none', start: 0, end: FULL_END,
  };
}

export function newImage(name: string, dataUrl: string, aspect: number): ImageOverlay {
  return {
    id: uid(), kind: 'image', name, dataUrl, aspect, x: 0.86, y: 0.12, width: 0.18,
    opacity: 90, rotation: 0, entrance: 'none', start: 0, end: FULL_END,
  };
}

export function newHide(x: number, y: number, w: number, h: number, base?: HideRegion): HideRegion {
  return {
    id: uid(), x, y, w, h,
    mode: base?.mode ?? 'fill', grain: base?.grain ?? 60, blur: base?.blur ?? 14,
    feather: base?.feather ?? 8, cloneFrom: base?.cloneFrom ?? 'auto',
    segments: [{ id: uid(), start: 0, end: FULL_END }],
  };
}

export function emptyDoc(): Doc {
  return {
    clips: [],
    overlays: [],
    hides: [],
    hidesEnabled: true,
    overlaysEnabled: true,
    color: { ...DEFAULT_COLOR },
    framing: { flipH: false, flipV: false, crop: null, cropLock: null, aspect: 'source', bg: 'blur', bgColor: '#101418' },
    audio: { music: null, musicVolume: 0.6, musicOffset: 0, musicLoop: true, duck: true, fadeIn: 0, fadeOut: 0, videoFade: true },
    output: { format: 'mp4', resolution: 0, quality: 'match', customMbps: 8, fps: 0, gifWidth: 480, gifFps: 12 },
  };
}
