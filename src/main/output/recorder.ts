import { EventEmitter } from 'node:events';
import type { RecordingFormat } from '../../shared/types';
import { buildRecorderArgs, friendlyFfmpegError } from '../../shared/ffmpegArgs';
import { FfmpegProcess } from './ffmpegProcess';
import type { StreamFanout, Subscription } from './streamFanout';

export interface RecorderOptions {
  path: string;
  format: RecordingFormat;
  ffmpegPath: string;
  verbose: boolean;
  hevc: boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Writes the encoded stream to a file (no re-encode). */
export class Recorder extends EventEmitter {
  readonly path: string;
  readonly startedAt = Date.now();
  private proc: FfmpegProcess;
  private sub: Subscription;
  private stopping = false;

  constructor(fanout: StreamFanout, o: RecorderOptions) {
    super();
    this.path = o.path;
    const args = buildRecorderArgs(o.path, o.format, o.verbose, o.hevc);
    o.log('info', `[recording] writing ${o.path}`);
    this.proc = new FfmpegProcess({ ffmpegPath: o.ffmpegPath, args, label: 'recording', log: o.log });
    // Recordings must never drop data because of a slow disk unless memory is at risk.
    this.sub = fanout.subscribe(
      { write: (d) => void this.proc.write(d), backlog: () => this.proc.backlog, end: () => this.proc.endInput() },
      { highWater: 512 * 1024 * 1024, lowWater: 64 * 1024 * 1024 },
    );
    this.proc.on('exit', (info: { code: number | null; stderrTail: string }) => {
      this.sub.unsubscribe();
      if (!this.stopping) {
        const msg = friendlyFfmpegError(info.stderrTail);
        o.log('error', `[recording] stopped unexpectedly: ${info.stderrTail}`);
        this.emit('failed', msg);
      }
      this.emit('closed', info.code === 0);
    });
  }

  get droppedFrames(): number {
    return this.sub.droppedFrames;
  }

  async stop(): Promise<boolean> {
    this.stopping = true;
    this.sub.unsubscribe();
    const info = await this.proc.stop(15000);
    return info.code === 0;
  }
}
