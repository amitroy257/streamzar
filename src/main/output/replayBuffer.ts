import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { RecordingFormat } from '../../shared/types';
import { buildRemuxArgs } from '../../shared/ffmpegArgs';
import type { StreamFanout } from './streamFanout';
import type { StreamPiece } from './mkvSegmenter';

/**
 * Keeps the last N seconds of the encoded stream in memory (as whole GOPs) so the streamer can
 * save "that just happened" moments as a clip.
 */
export class ReplayBuffer {
  private pieces: StreamPiece[] = [];
  private bytes = 0;
  private untap: () => void;
  readonly startedAt = Date.now();

  constructor(
    private readonly fanout: StreamFanout,
    private readonly durationSec: number,
    private readonly ffmpegPath: string,
    private readonly hevc: boolean,
  ) {
    this.untap = fanout.tap((p) => this.add(p));
  }

  add(piece: StreamPiece): void {
    if (!this.pieces.length && !piece.gopStart) return;
    this.pieces.push(piece);
    this.bytes += piece.data.length;
    this.trim(piece.time);
  }

  private trim(now: number) {
    // Keep whole GOPs: drop the oldest GOP while the next one still starts early enough to cover
    // the requested duration.
    const keepFrom = now - this.durationSec * 1000;
    for (;;) {
      let nextGop = -1;
      for (let i = 1; i < this.pieces.length; i++) {
        if (this.pieces[i].gopStart) {
          nextGop = i;
          break;
        }
      }
      if (nextGop < 0 || this.pieces[nextGop].time > keepFrom) break;
      for (let i = 0; i < nextGop; i++) this.bytes -= this.pieces[i].data.length;
      this.pieces.splice(0, nextGop);
    }
  }

  get seconds(): number {
    if (!this.pieces.length) return 0;
    return (this.pieces[this.pieces.length - 1].time - this.pieces[0].time) / 1000;
  }

  get memoryBytes(): number {
    return this.bytes;
  }

  /** Write the buffered clip to `outPath` (container chosen by `format`). */
  async save(outPath: string, format: RecordingFormat): Promise<string> {
    const snapshot = this.pieces.slice();
    if (!snapshot.length) throw new Error('The replay buffer is still empty. Wait a few seconds and try again.');
    const header = this.fanout.header;
    if (!header) throw new Error('The replay buffer is still empty. Wait a few seconds and try again.');
    const tmp = path.join(os.tmpdir(), `streamzar-replay-${process.pid}-${Date.now()}.mkv`);
    await fs.writeFile(tmp, Buffer.concat([header, ...snapshot.map((p) => p.data)]));
    try {
      await runFfmpeg(this.ffmpegPath, buildRemuxArgs(tmp, outPath, format, this.hevc));
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return outPath;
  }

  stop(): void {
    this.untap();
    this.pieces = [];
    this.bytes = 0;
  }
}

export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`))));
  });
}
