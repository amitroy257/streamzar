import { StreamFanout } from './streamFanout';
import type { StreamPiece } from './mkvSegmenter';

/** Holds the encoded stream back by a fixed delay before it reaches the platforms (anti stream-sniping). */
export class DelayBuffer {
  readonly output = new StreamFanout();
  private queue: StreamPiece[] = [];
  private untap: (() => void) | null;
  private timer: NodeJS.Timeout;
  private draining = false;
  private onDrained: (() => void) | null = null;

  constructor(
    private readonly source: StreamFanout,
    private readonly delayMs: number,
  ) {
    this.untap = source.tap(
      (p) => {
        if (!this.output.header && this.source.header) this.output.header = this.source.header;
        this.queue.push({ ...p, time: Date.now() });
      },
      () => this.drain(),
    );
    this.timer = setInterval(() => this.release(), 50);
  }

  private release() {
    const now = Date.now();
    while (this.queue.length && now - this.queue[0].time >= this.delayMs) {
      this.output.push(this.queue.shift()!);
    }
    if (this.draining && !this.queue.length) this.finish();
  }

  /** Seconds of buffered content still to be sent. */
  get remainingSec(): number {
    if (!this.queue.length) return 0;
    return Math.max(0, (this.queue[this.queue.length - 1].time + this.delayMs - Date.now()) / 1000);
  }

  /** Stop taking new data, keep sending what is buffered, resolve when everything went out. */
  drain(): Promise<void> {
    this.untap?.();
    this.untap = null;
    this.draining = true;
    return new Promise((resolve) => {
      this.onDrained = resolve;
      this.release();
    });
  }

  /** Drop everything immediately. */
  abort(): void {
    this.queue = [];
    this.untap?.();
    this.untap = null;
    this.finish();
  }

  private finish() {
    clearInterval(this.timer);
    this.output.end();
    const cb = this.onDrained;
    this.onDrained = null;
    cb?.();
  }
}
