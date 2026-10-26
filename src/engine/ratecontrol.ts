// Single-pass size control that keeps variable bitrate.
//
// Browser encoders overshoot a variable bitrate target, sometimes by several times, while a
// constant bitrate starves fast motion. So we run the WebCodecs encoder ourselves in variable
// mode and, every couple of seconds, re-aim its target so the bits spent so far plus the bits
// left add up to the budget. Busy scenes can borrow bits from calm ones, the encoder's
// overshoot is measured and corrected for, and the file still lands on its size.
import { EncodedPacket, EncodedVideoPacketSource, type VideoCodec } from 'mediabunny';

// Codec strings to try, best first. Levels are ceilings, so a high one is safe.
const CODEC_STRINGS: Partial<Record<VideoCodec, string[]>> = {
  avc: ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E01F'],
  hevc: ['hvc1.1.6.L156.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L123.B0'],
  vp9: ['vp09.00.51.08', 'vp09.00.41.08', 'vp09.00.31.08'],
  av1: ['av01.0.13M.08', 'av01.0.12M.08', 'av01.0.08M.08'],
  vp8: ['vp8'],
};

const RETARGET_EVERY = 2;   // seconds of output between bitrate updates
const KEY_EVERY = 5;        // seconds between keyframes

export class RateControlledVideo {
  readonly source: EncodedVideoPacketSource;
  private encoder: VideoEncoder | null = null;
  private config: VideoEncoderConfig | null = null;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  private request: number;          // bitrate currently asked of the encoder
  private compliance = 1;           // how many bits the encoder actually spends per bit asked
  private bytes = 0;                // all video bytes produced so far
  private winBytes = 0;             // bytes since the last retarget
  private winStart = 0;             // output time of the last retarget
  private lastPacketTs = 0;
  private lastKey = -Infinity;

  private codec: VideoCodec;
  private w: number;
  private h: number;
  private fps: number;
  private budgetBps: number;
  private total: number;

  constructor(codec: VideoCodec, w: number, h: number, fps: number, budgetBps: number, total: number) {
    this.codec = codec; this.w = w; this.h = h; this.fps = fps; this.budgetBps = budgetBps; this.total = total;
    this.source = new EncodedVideoPacketSource(codec);
    this.request = budgetBps;
  }

  /** Finds a working encoder config. False means this browser can't do it; use another path. */
  async init(): Promise<boolean> {
    if (typeof VideoEncoder === 'undefined') return false;
    for (const codec of CODEC_STRINGS[this.codec] ?? []) {
      const config: VideoEncoderConfig = {
        codec, width: this.w, height: this.h, bitrate: this.request, bitrateMode: 'variable',
        framerate: this.fps, latencyMode: 'quality',
        ...(this.codec === 'avc' ? { avc: { format: 'avc' } } : {}),
        ...(this.codec === 'hevc' ? { hevc: { format: 'hevc' } } as object : {}),
      };
      try {
        const r = await VideoEncoder.isConfigSupported(config);
        if (r.supported) { this.config = { ...config, ...r.config, bitrate: this.request }; return true; }
      } catch { /* try the next one */ }
    }
    return false;
  }

  /** Call after the track is added and output.start() has run. */
  start() {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.bytes += chunk.byteLength;
        this.winBytes += chunk.byteLength;
        this.lastPacketTs = chunk.timestamp / 1e6;
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        this.pending = this.pending.then(() => this.source.add(packet, meta)).catch(e => { this.failure ??= e; });
      },
      error: e => { this.failure ??= e; },
    });
    this.encoder.configure(this.config!);
  }

  /** Encode what's on the canvas now, as the frame at `ts` seconds. */
  async add(canvas: OffscreenCanvas, ts: number, dur: number) {
    if (this.failure) throw this.failure;
    const enc = this.encoder!;
    this.retarget();
    const frame = new VideoFrame(canvas, { timestamp: Math.round(ts * 1e6), duration: Math.round(dur * 1e6) });
    const keyFrame = ts - this.lastKey >= KEY_EVERY - 1e-3;
    if (keyFrame) this.lastKey = ts;
    try { enc.encode(frame, { keyFrame }); } finally { frame.close(); }
    // Don't let decoded frames pile up in front of the encoder.
    while (enc.encodeQueueSize > 6) await new Promise(r => enc.addEventListener('dequeue', r, { once: true }));
  }

  async finish() {
    await this.encoder!.flush();
    await this.pending;
    if (this.failure) throw this.failure;
    this.encoder!.close();
    this.source.close();
  }

  cancel() { try { this.encoder?.close(); } catch { /* already closed */ } }

  private retarget() {
    const t = this.lastPacketTs;
    if (t - this.winStart < RETARGET_EVERY) return;
    // How far off the encoder was from what we asked, smoothed so one big scene doesn't whipsaw it.
    const observed = this.winBytes * 8 / (t - this.winStart);
    const ratio = Math.min(8, Math.max(0.25, observed / this.request));
    this.compliance = this.compliance * 0.5 + ratio * 0.5;
    this.winBytes = 0;
    this.winStart = t;

    // Spread whatever budget is left over the time that's left. Busy stretches may borrow
    // up to 1.6x the average; calm ones never drop below half of it.
    const left = Math.max(0.5, this.total - t);
    const bitsLeft = this.budgetBps * this.total - this.bytes * 8;
    const want = Math.min(this.budgetBps * 1.6, Math.max(this.budgetBps * 0.5, bitsLeft / left));
    const next = Math.round(Math.min(this.budgetBps * 3, Math.max(this.budgetBps * 0.15, want / this.compliance)));
    if (Math.abs(next - this.request) / this.request < 0.08) return;
    this.request = next;
    // Bitrate-only changes are applied in place; the encoder isn't reset and no keyframe is forced.
    this.encoder!.configure({ ...this.config!, bitrate: next });
  }
}
