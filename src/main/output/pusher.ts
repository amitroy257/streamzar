import { EventEmitter } from 'node:events';
import type { Destination, DestinationState, DestinationStatus } from '../../shared/types';
import { buildIngestUrl, redactUrl } from '../../shared/platforms';
import { buildPusherArgs, friendlyFfmpegError } from '../../shared/ffmpegArgs';
import { FfmpegProcess } from './ffmpegProcess';
import type { StreamFanout, StreamSink, Subscription } from './streamFanout';

export interface PusherOptions {
  destination: Destination;
  ffmpegPath: string;
  autoReconnect: boolean;
  reconnectDelaySec: number;
  maxRetries: number;
  verbose: boolean;
  /** Approximate stream bitrate (kbps) used to size the congestion buffer. */
  bitrateKbps: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Sends the encoded stream to one platform (YouTube, Facebook, ...) with automatic reconnection. */
export class Pusher extends EventEmitter {
  readonly destination: Destination;
  state: DestinationState = 'idle';
  error: string | undefined;
  retries = 0;
  connectedAt: number | undefined;
  kbps = 0;
  private proc: FfmpegProcess | null = null;
  private sub: Subscription | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private droppedBase = 0;
  private lastBytes = 0;
  private lastRateAt = Date.now();
  private readonly url: string;
  private readonly protocol: 'rtmp' | 'srt';

  constructor(
    private readonly fanout: StreamFanout,
    private readonly o: PusherOptions,
  ) {
    super();
    this.destination = o.destination;
    const { url, protocol } = buildIngestUrl(o.destination.server, o.destination.streamKey);
    this.url = url;
    this.protocol = protocol;
  }

  get droppedFrames(): number {
    return this.droppedBase + (this.sub?.droppedFrames ?? 0);
  }

  status(): DestinationStatus {
    return {
      id: this.destination.id,
      name: this.destination.name,
      platform: this.destination.platform,
      state: this.state,
      error: this.error,
      kbps: Math.round(this.kbps),
      droppedFrames: this.droppedFrames,
      retries: this.retries,
      connectedAt: this.connectedAt,
    };
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  private setState(s: DestinationState, error?: string) {
    this.state = s;
    this.error = error;
    this.emit('state', this.status());
  }

  private spawn() {
    if (this.stopped) return;
    this.setState(this.retries > 0 ? 'reconnecting' : 'connecting', this.retries > 0 ? this.error : undefined);
    const args = buildPusherArgs(this.url, this.protocol, this.o.verbose);
    const safeUrl = redactUrl(this.url, this.destination.streamKey);
    this.o.log('info', `[${this.destination.name}] connecting to ${safeUrl}`);
    const proc = new FfmpegProcess({
      ffmpegPath: this.o.ffmpegPath,
      args,
      label: this.destination.name,
      log: (lvl, msg) => this.o.log(lvl, redactUrl(msg, this.destination.streamKey)),
    });
    this.proc = proc;
    const sink: StreamSink = {
      write: (d) => {
        proc.write(d);
      },
      backlog: () => proc.backlog,
      // Upstream finished (stream stopped, delay buffer drained): finish cleanly, no reconnect.
      end: () => {
        this.stopped = true;
        proc.endInput();
      },
    };
    // Allow ~4 seconds of video to queue before dropping GOPs (minimum 4 MiB).
    const highWater = Math.max(4 * 1024 * 1024, Math.round((this.o.bitrateKbps * 1000 * 4) / 8));
    this.sub = this.fanout.subscribe(sink, { highWater, lowWater: Math.round(highWater / 4) });
    this.lastBytes = 0;
    this.lastRateAt = Date.now();

    proc.on('stats', () => {
      // Only a connecting destination becomes live (FFmpeg also prints a last line while stopping).
      if (this.state === 'connecting' || this.state === 'reconnecting') {
        this.connectedAt = Date.now();
        this.retries = 0;
        this.setState('live');
        this.o.log('info', `[${this.destination.name}] live`);
      }
    });

    this.watchdog = setInterval(() => {
      // FFmpeg prints a progress line every second while data flows. If the network write blocks for
      // a long time the line stops coming: treat that as a dead connection and reconnect.
      if (this.state === 'live' && proc.lastStatsAt && Date.now() - proc.lastStatsAt > 20000) {
        this.o.log('warn', `[${this.destination.name}] connection stalled, reconnecting`);
        proc.kill();
      }
    }, 2000);

    proc.on('exit', (info: { code: number | null; stderrTail: string }) => {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      if (this.sub) {
        this.droppedBase += this.sub.droppedFrames;
        this.sub.unsubscribe();
        this.sub = null;
      }
      this.proc = null;
      this.kbps = 0;
      if (this.stopped) {
        this.setState('idle');
        this.emit('closed');
        return;
      }
      const msg = friendlyFfmpegError(redactUrl(info.stderrTail, this.destination.streamKey));
      this.o.log('warn', `[${this.destination.name}] disconnected (code ${info.code}): ${msg}`);
      const wasLive = this.state === 'live';
      if (this.o.autoReconnect && this.retries < this.o.maxRetries) {
        this.retries++;
        // Back off when a connection keeps failing straight away (wrong key etc.)
        const delay = Math.min(60, this.o.reconnectDelaySec * (wasLive ? 1 : Math.min(4, this.retries))) * 1000;
        this.setState('reconnecting', msg);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.spawn();
        }, delay);
      } else {
        this.setState('error', msg);
        this.emit('failed', msg);
      }
    });
  }

  updateRates(): void {
    const bytes = this.sub?.bytes ?? 0;
    const now = Date.now();
    const dt = (now - this.lastRateAt) / 1000;
    if (dt > 0 && this.proc) {
      // bytes actually consumed = delivered - still queued
      const consumed = bytes - this.proc.backlog;
      this.kbps = Math.max(0, ((consumed - this.lastBytes) * 8) / 1000 / dt);
      this.lastBytes = consumed;
    }
    this.lastRateAt = now;
  }

  /** Resolves once the FFmpeg process for this destination has exited. */
  waitClosed(timeoutMs = 15000): Promise<void> {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, timeoutMs);
      void proc.waitForExit().then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const proc = this.proc;
    if (!proc) {
      this.setState('idle');
      return;
    }
    this.setState('stopping');
    this.sub?.unsubscribe();
    await proc.stop(5000);
  }
}
