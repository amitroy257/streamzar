import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { parseStatsLine, type StatsLine } from '../../shared/ffmpegArgs';

export type Priority = 'normal' | 'above_normal' | 'high';

export interface FfmpegProcessOptions {
  ffmpegPath: string;
  args: string[];
  label: string;
  priority?: Priority;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface FfmpegExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

/**
 * Thin wrapper around an FFmpeg child process:
 *  - parses "-stats" progress lines into `stats` events,
 *  - keeps the last stderr lines for error reporting,
 *  - never throws on writes after the process died (EPIPE).
 */
export class FfmpegProcess extends EventEmitter {
  readonly label: string;
  private child: ChildProcessWithoutNullStreams;
  private tail: string[] = [];
  private stderrBuf = '';
  private exited = false;
  private exitInfo: FfmpegExit | null = null;
  private exitPromise: Promise<FfmpegExit>;
  lastStats: StatsLine | null = null;
  lastStatsAt = 0;
  bytesWritten = 0;

  constructor(private opts: FfmpegProcessOptions) {
    super();
    this.label = opts.label;
    this.child = spawn(opts.ffmpegPath, opts.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exitPromise = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exited) return;
        this.exited = true;
        this.flushStderr();
        this.exitInfo = { code, signal, stderrTail: this.tail.join('\n') };
        resolve(this.exitInfo);
        this.emit('exit', this.exitInfo);
      };
      this.child.on('exit', (code, signal) => done(code, signal));
      this.child.on('error', (err) => {
        this.pushTail(`spawn error: ${err.message}`);
        done(-1, null);
      });
    });
    this.child.stdin.on('error', () => {
      /* EPIPE when the process exits first - handled through the exit event */
    });
    this.child.stdout.on('error', () => undefined);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => this.onStderr(d));
    this.child.stdin.on('drain', () => this.emit('drain'));
    if (opts.priority && opts.priority !== 'normal' && this.child.pid) {
      try {
        os.setPriority(this.child.pid, opts.priority === 'high' ? os.constants.priority.PRIORITY_HIGH : os.constants.priority.PRIORITY_ABOVE_NORMAL);
      } catch {
        // Raising priority needs privileges on some systems - not fatal.
      }
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.child.stdout;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Bytes queued for the child's stdin. */
  get backlog(): number {
    return this.child.stdin.writableLength;
  }

  write(chunk: Buffer | Uint8Array): boolean {
    if (this.exited || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    this.bytesWritten += chunk.length;
    return this.child.stdin.write(chunk);
  }

  /** Close stdin so FFmpeg flushes and finalises its output. */
  endInput(): void {
    if (!this.child.stdin.writableEnded && !this.child.stdin.destroyed) this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!this.exited) {
      try {
        this.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Ask FFmpeg to finish gracefully, killing it if it does not exit in time. */
  async stop(timeoutMs = 8000): Promise<FfmpegExit> {
    if (this.exitInfo) return this.exitInfo;
    this.endInput();
    const timer = setTimeout(() => this.kill('SIGKILL'), timeoutMs);
    const info = await this.exitPromise;
    clearTimeout(timer);
    return info;
  }

  waitForExit(): Promise<FfmpegExit> {
    return this.exitPromise;
  }

  private pushTail(line: string) {
    this.tail.push(line);
    if (this.tail.length > 40) this.tail.shift();
  }

  private onStderr(d: string) {
    this.stderrBuf += d;
    // Progress lines end with \r, log lines with \n.
    const parts = this.stderrBuf.split(/[\r\n]/);
    this.stderrBuf = parts.pop() ?? '';
    if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192);
    for (const raw of parts) this.handleLine(raw);
  }

  private flushStderr() {
    if (this.stderrBuf) this.handleLine(this.stderrBuf);
    this.stderrBuf = '';
  }

  private handleLine(raw: string) {
    const line = raw.trim();
    if (!line) return;
    const stats = parseStatsLine(line);
    if (stats && /^(frame|size)=/.test(line)) {
      this.lastStats = stats;
      this.lastStatsAt = Date.now();
      this.emit('stats', stats);
      return;
    }
    this.pushTail(line);
    this.opts.log?.('warn', `[${this.label}] ${line}`);
  }
}
