import type { CaptureRequest } from '@shared/types';
import type { StreamzarApi } from '@shared/ipc';
import type { AudioEngine } from './audio/audioEngine';
import type { Compositor } from './gl/compositor';

/**
 * Estimates the AudioContext render clock at any moment. `currentTime` only advances in audio
 * callback steps (and is always slightly stale when read), so the offset between the two clocks is
 * the maximum of recent (currentTime - performance.now()) samples. This gives smooth, monotonic
 * timestamps on the same clock as the captured audio samples, and tracks drift over time.
 */
export class AudioClock {
  private samples: { t: number; v: number }[] = [];
  private lastCtx = -1;
  private lastOut = 0;

  constructor(private readonly ctx: AudioContext) {}

  /** Seconds on the AudioContext clock corresponding to `perfNow` (ms). */
  now(perfNow = performance.now()): number {
    const ct = this.ctx.currentTime;
    if (ct !== this.lastCtx) {
      this.lastCtx = ct;
      this.samples.push({ t: perfNow, v: ct - perfNow / 1000 });
    }
    while (this.samples.length > 1 && this.samples[0].t < perfNow - 2000) this.samples.shift();
    let offset = ct - perfNow / 1000;
    for (const s of this.samples) if (s.v > offset) offset = s.v;
    let t = perfNow / 1000 + offset;
    if (t < this.lastOut) t = this.lastOut;
    this.lastOut = t;
    return t;
  }
}

export interface CaptureStats {
  framesSent: number;
  framesSkipped: number;
}

/** Streams the program output (I420 frames + PCM) to the main process while outputs are active. */
export class CaptureSession {
  private clock: AudioClock;
  private t0 = 0;
  private sampleRate: number;
  private running = false;
  private frameBytes: number;
  private frameIntervalUs: number;
  private nextFrameUs = 0;
  readonly stats: CaptureStats = { framesSent: 0, framesSkipped: 0 };

  constructor(
    private readonly api: StreamzarApi,
    private readonly compositor: Compositor,
    private readonly audio: AudioEngine,
    readonly req: CaptureRequest,
    private readonly scaleFilter: 'bilinear' | 'bicubic' | 'lanczos',
  ) {
    this.clock = new AudioClock(audio.ctx);
    this.sampleRate = audio.ctx.sampleRate;
    this.frameBytes = req.width * req.height * 1.5;
    this.frameIntervalUs = (1e6 * req.fpsDen) / req.fpsNum;
  }

  async start(): Promise<void> {
    if (this.sampleRate !== this.req.sampleRate) {
      throw new Error(`Audio runs at ${this.sampleRate} Hz but the output expects ${this.req.sampleRate} Hz. Restart Streamzar after changing the sample rate.`);
    }
    let lastErr: unknown = null;
    for (let i = 0; i < 20; i++) {
      try {
        await this.api.capture.open(this.req.port, this.req.token);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (lastErr) throw lastErr;
    this.compositor.configureOutput(this.req.width, this.req.height, this.scaleFilter);
    const startFrame = await this.audio.startCapture((frame, data) => this.onAudio(frame, data));
    this.t0 = startFrame / this.sampleRate;
    this.nextFrameUs = 0;
    this.running = true;
  }

  private onAudio(frame: number, data: Float32Array) {
    if (!this.running) return;
    const tsUs = ((frame / this.sampleRate) - this.t0) * 1e6;
    if (tsUs < 0) return;
    this.api.capture.writeAudio(tsUs, data);
  }

  /** Called every compositor tick after the program has been rendered. */
  onFrameRendered(perfNow: number): void {
    if (!this.running) return;
    // Send everything the GPU has finished.
    // Readbacks are normally collected when their fence signals (never blocking the UI). As a
    // safety net against lazily-updated fence status, an old readback is collected synchronously.
    const maxAge = Math.max(200, (this.frameIntervalUs / 1000) * 6);
    this.compositor.collectFrames(
      (ts, data) => {
        if (this.api.capture.writeVideo(ts, data)) this.stats.framesSent++;
      },
      perfNow,
      maxAge,
    );
    const tsUs = (this.clock.now(perfNow) - this.t0) * 1e6;
    if (tsUs < 0) return;
    // Pace captures to the output frame rate even if the tick clock jitters.
    if (tsUs < this.nextFrameUs - this.frameIntervalUs * 0.5) return;
    this.nextFrameUs = Math.max(this.nextFrameUs + this.frameIntervalUs, tsUs);
    // If the link to the encoder is backed up (encoder overloaded), skip instead of queueing;
    // timestamps keep A/V in sync and the encoder repeats the previous frame.
    if (this.api.capture.backlog() > this.frameBytes * 3 || !this.compositor.captureProgram(tsUs)) {
      this.stats.framesSkipped++;
    }
  }

  stop(): void {
    this.running = false;
    this.audio.stopCapture();
    this.api.capture.close();
    this.compositor.releaseOutput();
  }
}
