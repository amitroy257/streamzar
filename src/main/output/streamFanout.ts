import type { StreamPiece } from './mkvSegmenter';

export interface StreamSink {
  write(data: Buffer): void;
  /** Bytes queued but not yet consumed by the sink. */
  backlog(): number;
  /** Called when the upstream ends. */
  end(): void;
}

interface Subscriber {
  sink: StreamSink;
  started: boolean;
  /** Waiting for a GOP entry point (initial join or recovering from congestion). */
  waiting: boolean;
  congested: boolean;
  highWater: number;
  lowWater: number;
  droppedFrames: number;
  bytes: number;
}

export interface SubscribeOptions {
  /** Start dropping whole GOPs when this many bytes are queued in the sink (default 8 MiB). */
  highWater?: number;
  /** Resume (at the next GOP) once the backlog falls below this (default 1 MiB). */
  lowWater?: number;
}

export interface Subscription {
  readonly droppedFrames: number;
  readonly bytes: number;
  readonly congested: boolean;
  unsubscribe(): void;
}

/**
 * Distributes the encoded Matroska stream to any number of sinks. A sink that joins late receives
 * the stream header and then starts at the next keyframe; a sink that cannot keep up (slow upload)
 * drops whole GOPs instead of receiving a corrupted stream.
 */
export class StreamFanout {
  header: Buffer | null = null;
  private subs = new Set<Subscriber>();
  private taps = new Set<{ onPiece: (p: StreamPiece) => void; onEnd: () => void }>();
  private ended = false;

  /** Observe every piece unfiltered (replay & delay buffers manage GOPs themselves). */
  tap(onPiece: (p: StreamPiece) => void, onEnd: () => void = () => undefined): () => void {
    const t = { onPiece, onEnd };
    if (this.ended) {
      queueMicrotask(onEnd);
      return () => undefined;
    }
    this.taps.add(t);
    return () => {
      this.taps.delete(t);
    };
  }

  subscribe(sink: StreamSink, opts: SubscribeOptions = {}): Subscription {
    const sub: Subscriber = {
      sink,
      started: false,
      waiting: true,
      congested: false,
      highWater: opts.highWater ?? 8 * 1024 * 1024,
      lowWater: opts.lowWater ?? 1024 * 1024,
      droppedFrames: 0,
      bytes: 0,
    };
    if (this.ended) queueMicrotask(() => sink.end());
    else this.subs.add(sub);
    return {
      get droppedFrames() {
        return sub.droppedFrames;
      },
      get bytes() {
        return sub.bytes;
      },
      get congested() {
        return sub.congested;
      },
      unsubscribe: () => {
        this.subs.delete(sub);
      },
    };
  }

  get subscriberCount(): number {
    return this.subs.size + this.taps.size;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  push(piece: StreamPiece): void {
    if (this.ended) return;
    for (const t of this.taps) t.onPiece(piece);
    for (const sub of this.subs) {
      const backlog = sub.sink.backlog();
      if (piece.gopStart) {
        if (!sub.started) {
          if (!this.header) continue;
          sub.started = true;
          sub.waiting = false;
          sub.bytes += this.header.length;
          sub.sink.write(this.header);
        } else {
          // Drop decisions are taken per GOP so the sink never receives a partial picture.
          const limit = sub.congested ? sub.lowWater : sub.highWater;
          if (backlog > limit) {
            sub.congested = true;
            sub.waiting = true;
            sub.droppedFrames += piece.videoFrames;
            continue;
          }
          sub.congested = false;
          sub.waiting = false;
        }
      } else if (sub.waiting) {
        if (sub.congested) sub.droppedFrames += piece.videoFrames;
        continue;
      } else if (backlog > sub.highWater * 4) {
        // Pathological stall in the middle of a GOP: protect memory, resume at the next GOP.
        sub.congested = true;
        sub.waiting = true;
        sub.droppedFrames += piece.videoFrames;
        continue;
      }
      sub.bytes += piece.data.length;
      sub.sink.write(piece.data);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const subs = [...this.subs];
    this.subs.clear();
    for (const s of subs) s.sink.end();
    const taps = [...this.taps];
    this.taps.clear();
    for (const t of taps) t.onEnd();
  }
}
