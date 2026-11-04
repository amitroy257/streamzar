import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_STREAM_ENCODER } from '../../shared/defaults';
import { ENCODERS, buildEncoderProbeArgs, encoderFamily } from '../../shared/ffmpegArgs';
import type { EncoderId, EncoderInfo } from '../../shared/types';

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function bundledFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null;
    if (!p) return null;
    // Inside a packaged app the binary is unpacked next to the asar archive.
    const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (existsSync(unpacked)) return unpacked;
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function fromPath(): string | null {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface FfmpegInfo {
  path: string;
  version: string;
}

export class FfmpegLocator {
  private resolved: FfmpegInfo | null = null;
  private resolvedFor: string | null = null;
  private encoderCache: { path: string; list: EncoderInfo[] } | null = null;
  private encoderPromise: Promise<EncoderInfo[]> | null = null;

  constructor(private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void) {}

  /** Find a working FFmpeg binary (custom path → bundled → system PATH). */
  async resolve(customPath: string): Promise<FfmpegInfo> {
    if (this.resolved && this.resolvedFor === customPath) return this.resolved;
    const candidates = [customPath.trim(), bundledFfmpeg(), fromPath()].filter((p): p is string => !!p);
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      const r = await run(c, ['-hide_banner', '-version'], 15000);
      if (r.code === 0) {
        const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
        this.resolved = { path: c, version };
        this.resolvedFor = customPath;
        this.log('info', `using ffmpeg ${version} at ${c}`);
        return this.resolved;
      }
    }
    throw new Error('FFmpeg was not found. Reinstall Streamzar or set a custom FFmpeg path in Settings → Advanced.');
  }

  /** Encoders that are compiled in *and* actually work on this machine. */
  async encoders(customPath: string, refresh = false): Promise<EncoderInfo[]> {
    const ff = await this.resolve(customPath);
    if (!refresh && this.encoderCache?.path === ff.path) return this.encoderCache.list;
    if (this.encoderPromise && !refresh) return this.encoderPromise;
    this.encoderPromise = this.detect(ff.path).finally(() => {
      this.encoderPromise = null;
    });
    return this.encoderPromise;
  }

  private async detect(ffmpegPath: string): Promise<EncoderInfo[]> {
    const listed = await run(ffmpegPath, ['-hide_banner', '-encoders'], 15000);
    const names = new Set<string>();
    for (const line of listed.stdout.split(/\r?\n/)) {
      const m = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
      if (m) names.add(m[1]);
    }
    const platformOk = (id: EncoderId): boolean => {
      const fam = encoderFamily(id);
      if (fam === 'videotoolbox') return process.platform === 'darwin';
      if (fam === 'vaapi') return process.platform === 'linux' && existsSync('/dev/dri/renderD128');
      if (fam === 'amf') return process.platform === 'win32';
      if (fam === 'nvenc' || fam === 'qsv') return process.platform === 'win32' || process.platform === 'linux';
      return true;
    };
    const results: EncoderInfo[] = [];
    for (const e of ENCODERS) {
      let available = names.has(e.id) && platformOk(e.id);
      if (available && e.hardware) {
        const probe = await run(ffmpegPath, buildEncoderProbeArgs({ ...DEFAULT_STREAM_ENCODER, encoder: e.id }), 20000);
        available = probe.code === 0;
        if (!available) this.log('info', `encoder ${e.id} not usable: ${probe.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ''}`);
      }
      results.push({ ...e, available });
    }
    this.encoderCache = { path: ffmpegPath, list: results };
    this.log('info', `available encoders: ${results.filter((r) => r.available).map((r) => r.id).join(', ')}`);
    return results;
  }
}
