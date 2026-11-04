import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { RAW_HEADER_SIZE, RAW_TYPE_AUDIO, RAW_TYPE_VIDEO, writeRawHeader } from '../../src/shared/rawProtocol';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const FFMPEG: string = require('ffmpeg-static') as string;
export const FFPROBE = 'ffprobe';

/** Simulates the renderer: sends I420 frames + PCM audio in real time over the capture link. */
export class SyntheticSender {
  private sock: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private start = 0;
  private sentFrames = 0;
  private sentSamples = 0;

  constructor(
    private width: number,
    private height: number,
    private fps: number,
    private sampleRate: number,
  ) {}

  async connect(port: number, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve());
      s.once('error', reject);
      this.sock = s;
    });
    this.sock!.on('error', () => undefined);
    this.sock!.write(`${token}\n`);
    this.start = Date.now();
    this.timer = setInterval(() => this.tick(), 5);
  }

  private send(type: number, tsUs: number, payload: Uint8Array) {
    const h = new Uint8Array(RAW_HEADER_SIZE);
    writeRawHeader(new DataView(h.buffer), type, payload.byteLength, tsUs);
    this.sock?.write(h);
    this.sock?.write(payload);
  }

  private tick() {
    const elapsed = (Date.now() - this.start) / 1000;
    const w = this.width;
    const h = this.height;
    while (this.sentSamples / this.sampleRate <= elapsed) {
      const n = 960;
      const a = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = 0.2 * Math.sin((2 * Math.PI * 440 * (this.sentSamples + i)) / this.sampleRate);
        a[2 * i] = v;
        a[2 * i + 1] = v;
      }
      this.send(RAW_TYPE_AUDIO, (this.sentSamples / this.sampleRate) * 1e6, new Uint8Array(a.buffer));
      this.sentSamples += n;
    }
    while (this.sentFrames / this.fps <= elapsed) {
      const f = new Uint8Array(w * h * 1.5);
      f.fill(40 + ((this.sentFrames * 5) % 180), 0, w * h);
      f.fill(128, w * h);
      const x0 = (this.sentFrames * 4) % w;
      for (let y = h / 4; y < h / 2; y++) for (let x = 0; x < 32; x++) f[y * w + ((x0 + x) % w)] = 235;
      this.send(RAW_TYPE_VIDEO, (this.sentFrames / this.fps) * 1e6, f);
      this.sentFrames++;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sock?.end();
    this.sock = null;
  }
}

/** A one-shot RTMP "server" (FFmpeg in listen mode) that saves what it receives. */
export function startRtmpListener(port: number, app: string, key: string, outFile: string): ChildProcess {
  return spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/${app}/${key}`, '-c', 'copy', '-f', 'flv', '-y', outFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export interface ProbeResult {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string }[];
  format: { duration?: string; format_name: string };
}

export function probe(file: string): ProbeResult {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate:format=duration,format_name', '-of', 'json', file]);
  return JSON.parse(out.toString()) as ProbeResult;
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
