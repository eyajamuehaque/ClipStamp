// Shared data model. Everything in `Doc` is part of undo/redo history and gets autosaved.

export type Rotation = 0 | 90 | 180 | 270;

export interface Rect { x: number; y: number; w: number; h: number } // normalized 0..1

export interface Clip {
  id: string;
  file: File;
  url: string;          // object URL for the <video> preview
  name: string;
  size: number;
  duration: number;     // seconds, source
  width: number;        // native display width (before our rotation)
  height: number;
  hasAudio: boolean;
  thumb?: string;       // small JPEG data URL for the clip strip
  trimStart: number;
  trimEnd: number;
  rotation: Rotation;
  speed: number;        // 0.25..4
  volume: number;       // 0..2 (1 = original)
  muted: boolean;
  crop: Rect | null;    // normalized to the rotated source frame; each clip has its own
  cropLock: { w: number; h: number } | null;
}

export type Motion = 'none' | 'horizontal' | 'vertical' | 'bounce';
export type Entrance = 'none' | 'fade' | 'slide' | 'pop' | 'typewriter';

// Times on overlays are in OUTPUT seconds (after trimming and speed), so they line up
// with the final video. end = Infinity-like FULL_END means "until the end".
export const FULL_END = 1e6;

export interface TextOverlay {
  id: string;
  kind: 'text';
  text: string;
  font: string;         // key into FONTS
  size: number;         // px at 1080p (scaled to the output size)
  color: string;
  opacity: number;      // 0..100
  rotation: number;     // degrees
  x: number; y: number; // center, normalized to the output frame
  align: 'left' | 'center' | 'right';
  outline: number;      // stroke width at 1080p, 0 = off
  outlineColor: string;
  box: boolean;         // background box behind the text
  boxColor: string;
  boxOpacity: number;
  shadow: boolean;
  motion: Motion;
  speed: number;        // seconds per pass for motion
  entrance: Entrance;
  start: number;
  end: number;
}

export interface ImageOverlay {
  id: string;
  kind: 'image';
  name: string;
  dataUrl: string;
  aspect: number;       // natural width / height
  x: number; y: number;
  width: number;        // fraction of output width
  opacity: number;
  rotation: number;
  entrance: Entrance;
  start: number;
  end: number;
}

export type Overlay = TextOverlay | ImageOverlay;

export type HideMode = 'fill' | 'clone' | 'blur' | 'pixelate';
export interface HideSegment { id: string; start: number; end: number } // source seconds of the clip
export interface HideRegion extends Rect {
  id: string;
  mode: HideMode;
  grain: number;
  blur: number;
  feather: number;
  cloneFrom: 'auto' | 'above' | 'below' | 'left' | 'right';
  segments: HideSegment[];
}

export interface ColorSettings {
  preset: string;
  brightness: number;   // 100 = unchanged
  contrast: number;
  saturation: number;
  hue: number;          // degrees
  temperature: number;  // -100 cool .. 100 warm
  vignette: number;     // 0..100
  grayscale: number;    // 0..100
  sepia: number;
  blur: number;         // px at 1080p
}

export type CanvasAspect = 'source' | '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | '21:9';
export type BgFill = 'black' | 'color' | 'blur';

export interface Framing {
  flipH: boolean;
  flipV: boolean;
  aspect: CanvasAspect;         // output canvas shape (content is fitted inside)
  bg: BgFill;
  bgColor: string;
}

/** An imported audio file. Several audio clips can play the same source. */
export interface AudioSource { id: string; name: string; file: File; duration: number }

/** One placement of an audio source on the output timeline. */
export interface AudioClip {
  id: string;
  sourceId: string;
  start: number;        // output seconds where it begins
  in: number;           // seconds into the source where playback starts
  len: number;          // seconds it plays for
  volume: number;       // 0..2
  loop: boolean;        // repeat the source to fill `len`
}

export interface AudioSettings {
  sources: AudioSource[];
  clips: AudioClip[];
  duck: boolean;        // lower added audio while video clips have sound
  fadeIn: number;       // seconds, audio + video
  fadeOut: number;
  videoFade: boolean;   // also fade the picture from/to black
}

export type ExportFormat = 'mp4' | 'webm' | 'gif' | 'wav';
export type QualityMode = 'match' | 'high' | 'medium' | 'small' | 'custom';

export interface OutputSettings {
  format: ExportFormat;
  resolution: number;   // short side in px, 0 = keep
  quality: QualityMode;
  customMbps: number;
  fps: number;          // 0 = keep source
  gifWidth: number;
  gifFps: number;
}

export interface Doc {
  clips: Clip[];
  overlays: Overlay[];
  hides: HideRegion[];
  hidesEnabled: boolean;
  overlaysEnabled: boolean;
  color: ColorSettings;
  framing: Framing;
  audio: AudioSettings;
  output: OutputSettings;
}
