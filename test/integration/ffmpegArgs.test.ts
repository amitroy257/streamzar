import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEncoderArgs, buildEncoderProbeArgs, buildRecorderArgs, buildRemuxArgs, RECORDING_EXTENSIONS } from '../../src/shared/ffmpegArgs';
import { DEFAULT_STREAM_ENCODER } from '../../src/shared/defaults';
import type { EncoderId, QualityPreset, RateControl, RecordingFormat } from '../../src/shared/types';
import { buildClusterHeader, buildMkvHeader, AUDIO_TRACK, VIDEO_TRACK } from '../../src/main/output/mkv';
import { FFMPEG, probe } from './helpers';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streamzar-args-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const listed = execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString();
const software: EncoderId[] = (['libx264', 'libx265'] as EncoderId[]).filter((e) => listed.includes(` ${e} `));

describe('encoder arguments are accepted by FFmpeg', () => {
  for (const encoder of software) {
    for (const rateControl of ['cbr', 'vbr', 'cqp'] as RateControl[]) {
      for (const preset of ['speed', 'max_quality'] as QualityPreset[]) {
        it(`${encoder} ${rateControl} ${preset}`, () => {
          const args = buildEncoderProbeArgs({ ...DEFAULT_STREAM_ENCODER, encoder, rateControl, preset, profile: 'high' });
          const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
          expect(r.stderr).toBe('');
          expect(r.status).toBe(0);
        });
      }
    }
  }
  it('baseline profile', () => {
    const r = spawnSync(FFMPEG, buildEncoderProbeArgs({ ...DEFAULT_STREAM_ENCODER, profile: 'baseline' }), { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

/** 2 seconds of raw I420 + PCM in Streamzar's capture format. */
function rawInput(width: number, height: number, fps: number): Buffer {
  const parts = [buildMkvHeader({ width, height, fpsNum: fps, fpsDen: 1, sampleRate: 48000, channels: 2 })];
  const frame = Buffer.alloc(width * height * 1.5, 128);
  let samples = 0;
  for (let f = 0; f < fps * 2; f++) {
    const ts = (f / fps) * 1e6;
    while ((samples / 48000) * 1e6 <= ts) {
      const a = Buffer.alloc(1024 * 2 * 4);
      parts.push(buildClusterHeader(AUDIO_TRACK, (samples / 48000) * 1e6, a.length), a);
      samples += 1024;
    }
    frame.fill(16 + f, 0, width * height);
    parts.push(buildClusterHeader(VIDEO_TRACK, ts, frame.length), Buffer.from(frame));
  }
  return Buffer.concat(parts);
}

describe('every recording format', () => {
  const encodedPath = path.join(tmp, 'encoded.mkv');
  it('encodes the capture format', () => {
    const r = spawnSync(FFMPEG, buildEncoderArgs({ settings: { ...DEFAULT_STREAM_ENCODER, preset: 'speed', keyframeSec: 1 }, fpsNum: 30, fpsDen: 1, sampleRate: 48000 }), {
      input: rawInput(320, 180, 30),
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(r.status).toBe(0);
    writeFileSync(encodedPath, r.stdout);
    const p = probe(encodedPath);
    expect(p.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
  });

  for (const format of ['mp4', 'fmp4', 'mkv', 'mov', 'flv', 'ts'] as RecordingFormat[]) {
    it(`records ${format}`, () => {
      const out = path.join(tmp, `rec-${format}.${RECORDING_EXTENSIONS[format]}`);
      const r = spawnSync(FFMPEG, buildRecorderArgs(out, format), { input: readFileSync(encodedPath), encoding: 'buffer' });
      expect(r.status, r.stderr.toString()).toBe(0);
      expect(existsSync(out)).toBe(true);
      // ffprobe (system build) can read every container
      const p = probe(out);
      expect(p.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
      expect(Number(p.format.duration)).toBeGreaterThan(1.5);
    });
  }

  it('remuxes MKV to MP4', () => {
    const out = path.join(tmp, 'remuxed.mp4');
    const r = spawnSync(FFMPEG, buildRemuxArgs(path.join(tmp, 'rec-mkv.mkv'), out, 'mp4'));
    expect(r.status).toBe(0);
    expect(probe(out).streams.length).toBe(2);
  });
});
