import { EventEmitter } from 'node:events';
import type { EncoderSettings } from '../../shared/types';
import { buildEncoderArgs, friendlyFfmpegError } from '../../shared/ffmpegArgs';
import { FfmpegProcess, type Priority } from './ffmpegProcess';
import { AUDIO_TRACK, VIDEO_TRACK, buildClusterHeader, buildMkvHeader } from './mkv';
import type { HubFormat, RawListener } from './mediaHub';
import { StreamFanout } from './streamFanout';
import { MkvSegmenter } from './mkvSegmenter';

export interface EncoderPipelineOptions {
  id: string;
  label: string;
  settings: EncoderSettings;
  format: HubFormat;
  ffmpegPath: string;
  priority: Priority;
  verbose: boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * One FFmpeg encoder: raw Matroska in (from the MediaHub), encoded Matroska out (into a StreamFanout).
 * Consumers (pushers, recorder, replay buffer) subscribe to `fanout`.
 */
export class EncoderPipeline extends EventEmitter implements RawListener {
  readonly fanout = new StreamFanout();
  readonly id: string;
  readonly label: string;
  readonly settings: EncoderSettings;
  private proc: FfmpegProcess;
  private segmenter = new MkvSegmenter();
  private baseUs: number | null = null;
  private stopping = false;
  private frameBytes: number;
  skippedFrames = 0;
  framesIn = 0;
  fps = 0;
  speed = 0;
  kbps = 0;
  private outBytes = 0;
  private lastRateAt = Date.now();
  private lastOutBytes = 0;
  private slowSince = 0;

  constructor(o: EncoderPipelineOptions) {
    super();
    this.id = o.id;
    this.label = o.label;
    this.settings = o.settings;
    const { width, height } = o.format;
    this.frameBytes = width * height + 2 * ((width >> 1) * (height >> 1));
    const args = buildEncoderArgs({ settings: o.settings, fpsNum: o.format.fpsNum, fpsDen: o.format.fpsDen, sampleRate: o.format.sampleRate, verbose: o.verbose });
    o.log('info', `[${o.label}] starting encoder: ffmpeg ${args.join(' ')}`);
    this.proc = new FfmpegProcess({ ffmpegPath: o.ffmpegPath, args, label: o.label, priority: o.priority, log: o.log });
    this.proc.write(buildMkvHeader({ ...o.format, channels: 2 }));
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.outBytes += chunk.length;
      let pieces;
      try {
        pieces = this.segmenter.push(chunk);
      } catch (e) {
        o.log('error', `[${o.label}] invalid encoder output: ${(e as Error).message}`);
        this.proc.kill();
        return;
      }
      if (!this.fanout.header && this.segmenter.header) this.fanout.header = this.segmenter.header;
      for (const piece of pieces) this.fanout.push(piece);
    });
    this.proc.stdout.on('end', () => this.fanout.end());
    this.proc.on('stats', (s: { fps?: number; speed?: number }) => {
      if (s.fps !== undefined) this.fps = s.fps;
      if (s.speed !== undefined) this.speed = s.speed;
    });
    this.proc.on('exit', (info: { code: number | null; stderrTail: string }) => {
      if (!this.stopping) {
        const msg = friendlyFfmpegError(info.stderrTail);
        o.log('error', `[${o.label}] encoder exited unexpectedly (code ${info.code}): ${info.stderrTail}`);
        this.emit('failed', new Error(`Encoder stopped: ${msg}`));
      }
      this.emit('closed');
    });
  }

  get alive(): boolean {
    return this.proc.alive;
  }

  /** Encoder can't keep up with real time (overloaded CPU/GPU). */
  get lagging(): boolean {
    return this.slowSince > 0 && Date.now() - this.slowSince > 3000;
  }

  /** Called about once a second by the output manager. */
  updateRates(): void {
    const now = Date.now();
    const dt = (now - this.lastRateAt) / 1000;
    if (dt > 0) this.kbps = ((this.outBytes - this.lastOutBytes) * 8) / 1000 / dt;
    this.lastOutBytes = this.outBytes;
    this.lastRateAt = now;
    const backlogFrames = this.proc.backlog / this.frameBytes;
    if (backlogFrames > 2 || (this.speed > 0 && this.speed < 0.97)) {
      if (!this.slowSince) this.slowSince = now;
    } else {
      this.slowSince = 0;
    }
  }

  onVideo(tsUs: number, frame: Buffer): void {
    if (this.stopping || !this.proc.alive) return;
    if (this.baseUs === null) this.baseUs = tsUs;
    const rel = tsUs - this.baseUs;
    if (rel < 0) return;
    // Keep at most ~4 frames queued; beyond that the encoder is overloaded and frames are skipped
    // (timestamps keep audio and video in sync; the fps filter repeats the previous frame).
    if (this.proc.backlog > this.frameBytes * 4) {
      this.skippedFrames++;
      return;
    }
    this.framesIn++;
    this.proc.write(buildClusterHeader(VIDEO_TRACK, rel, frame.length));
    this.proc.write(frame);
  }

  onAudio(tsUs: number, samples: Buffer): void {
    if (this.stopping || !this.proc.alive || this.baseUs === null) return;
    const rel = tsUs - this.baseUs;
    if (rel < 0) return;
    if (this.proc.backlog > 256 * 1024 * 1024) return; // something is badly stuck; protect memory
    this.proc.write(buildClusterHeader(AUDIO_TRACK, rel, samples.length));
    this.proc.write(samples);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.proc.waitForExit();
      return;
    }
    this.stopping = true;
    await this.proc.stop(10000);
  }
}
