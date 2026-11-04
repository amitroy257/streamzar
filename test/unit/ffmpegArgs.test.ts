import { describe, expect, it } from 'vitest';
import {
  buildEncoderArgs,
  buildPusherArgs,
  buildRecorderArgs,
  buildRemuxArgs,
  buildVideoEncoderArgs,
  encoderSettingsKey,
  friendlyFfmpegError,
  keyframeInterval,
  parseStatsLine,
  recordingEncoderSettings,
} from '../../src/shared/ffmpegArgs';
import { DEFAULT_STREAM_ENCODER, defaultSettings } from '../../src/shared/defaults';
import type { EncoderSettings } from '../../src/shared/types';

const enc = (p: Partial<EncoderSettings> = {}): EncoderSettings => ({ ...DEFAULT_STREAM_ENCODER, ...p });
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('video encoder arguments', () => {
  it('x264 CBR is strict CBR with fixed GOP and BT.709 tags', () => {
    const a = buildVideoEncoderArgs(enc({ videoBitrate: 6000 }), { fpsNum: 30, fpsDen: 1 });
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-b:v')).toBe('6000k');
    expect(after(a, '-maxrate')).toBe('6000k');
    expect(after(a, '-bufsize')).toBe('6000k');
    expect(after(a, '-x264-params')).toBe('nal-hrd=cbr:force-cfr=1');
    expect(after(a, '-g')).toBe('60');
    expect(after(a, '-keyint_min')).toBe('60');
    expect(after(a, '-sc_threshold')).toBe('0');
    expect(after(a, '-pix_fmt')).toBe('yuv420p');
    expect(after(a, '-colorspace')).toBe('bt709');
    expect(after(a, '-color_range')).toBe('tv');
    expect(after(a, '-preset')).toBe('veryfast');
  });

  it('keyframe interval follows the frame rate', () => {
    expect(keyframeInterval(enc({ keyframeSec: 2 }), { fpsNum: 60000, fpsDen: 1001 })).toBe(120);
    expect(keyframeInterval(enc({ keyframeSec: 2 }), { fpsNum: 25, fpsDen: 1 })).toBe(50);
    expect(keyframeInterval(enc({ keyframeSec: 0 }), { fpsNum: 30, fpsDen: 1 })).toBe(60);
  });

  it('x264 constant quality uses CRF and no bitrate caps', () => {
    const a = buildVideoEncoderArgs(enc({ rateControl: 'cqp', cq: 18 }), { fpsNum: 60, fpsDen: 1 });
    expect(after(a, '-crf')).toBe('18');
    expect(a).not.toContain('-b:v');
    expect(after(a, '-x264-params')).toBe('force-cfr=1');
  });

  it('VBR uses a peak bitrate and a 2x buffer', () => {
    const a = buildVideoEncoderArgs(enc({ rateControl: 'vbr', videoBitrate: 4000, maxBitrate: 6000 }), { fpsNum: 30, fpsDen: 1 });
    expect(after(a, '-maxrate')).toBe('6000k');
    expect(after(a, '-bufsize')).toBe('12000k');
  });

  it('NVENC uses p-presets, rc modes and no scene-cut keyframes', () => {
    const cbr = buildVideoEncoderArgs(enc({ encoder: 'h264_nvenc', preset: 'quality' }), { fpsNum: 60, fpsDen: 1 });
    expect(after(cbr, '-preset')).toBe('p5');
    expect(after(cbr, '-rc')).toBe('cbr');
    expect(after(cbr, '-no-scenecut')).toBe('1');
    const cq = buildVideoEncoderArgs(enc({ encoder: 'h264_nvenc', rateControl: 'cqp', cq: 20 }), { fpsNum: 60, fpsDen: 1 });
    expect(after(cq, '-rc')).toBe('vbr');
    expect(after(cq, '-cq')).toBe('20');
    expect(after(cq, '-b:v')).toBe('0');
  });

  it('QSV / AMF / VideoToolbox use NV12 input', () => {
    for (const e of ['h264_qsv', 'h264_amf', 'h264_videotoolbox'] as const) {
      expect(after(buildVideoEncoderArgs(enc({ encoder: e }), { fpsNum: 30, fpsDen: 1 }), '-pix_fmt')).toBe('nv12');
    }
    expect(after(buildVideoEncoderArgs(enc({ encoder: 'h264_amf', rateControl: 'vbr' }), { fpsNum: 30, fpsDen: 1 }), '-rc')).toBe('vbr_peak');
  });

  it('HEVC always uses the main profile and the hvc1 tag', () => {
    const a = buildVideoEncoderArgs(enc({ encoder: 'hevc_nvenc', profile: 'high' }), { fpsNum: 30, fpsDen: 1 });
    expect(after(a, '-profile:v')).toBe('main');
    expect(after(a, '-tag:v')).toBe('hvc1');
  });

  it('baseline profile disables B-frames', () => {
    expect(after(buildVideoEncoderArgs(enc({ profile: 'baseline', bframes: 3 }), { fpsNum: 30, fpsDen: 1 }), '-bf')).toBe('0');
  });
});

describe('process command lines', () => {
  it('encoder reads raw Matroska and writes joinable Matroska', () => {
    const a = buildEncoderArgs({ settings: enc(), fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 });
    expect(a.slice(a.indexOf('-f'), a.indexOf('-f') + 4)).toEqual(['-f', 'matroska', '-i', 'pipe:0']);
    expect(after(a, '-vf')).toBe('fps=30000/1001');
    expect(after(a, '-c:a')).toBe('aac');
    expect(after(a, '-ar')).toBe('48000');
    expect(after(a, '-cluster_size_limit')).toBe('1');
    expect(a[a.length - 1]).toBe('pipe:1');
    expect(a[a.length - 2]).toBe('1'); // -flush_packets 1
  });

  it('VA-API adds the device and an upload filter', () => {
    const a = buildEncoderArgs({ settings: enc({ encoder: 'h264_vaapi' }), fpsNum: 30, fpsDen: 1, sampleRate: 48000 });
    expect(after(a, '-vaapi_device')).toBe('/dev/dri/renderD128');
    expect(after(a, '-vf')).toBe('fps=30,format=nv12,hwupload');
  });

  it('pusher copies streams into FLV for RTMP and MPEG-TS for SRT', () => {
    const r = buildPusherArgs('rtmp://h/app/key', 'rtmp');
    expect(after(r, '-c')).toBe('copy');
    expect(r.slice(-4)).toEqual(['flv', '-flvflags', 'no_duration_filesize', 'rtmp://h/app/key']);
    const s = buildPusherArgs('srt://h:1', 'srt');
    expect(s.slice(-3)).toEqual(['-f', 'mpegts', 'srt://h:1']);
  });

  it('recorder picks the right muxer per format', () => {
    expect(buildRecorderArgs('/o.mp4', 'mp4')).toEqual(expect.arrayContaining(['-f', 'mp4', '/o.mp4']));
    const f = buildRecorderArgs('/o.mp4', 'fmp4');
    expect(after(f, '-movflags')).toBe('+frag_keyframe+empty_moov+default_base_moof');
    expect(after(buildRecorderArgs('/o.mkv', 'mkv'), '-f')).toBe('matroska');
    expect(buildRecorderArgs('/o.mp4', 'mp4', false, true)).toContain('hvc1');
    expect(buildRecorderArgs('/o.mkv', 'mkv', false, true)).not.toContain('hvc1');
    expect(buildRemuxArgs('/i.mkv', '/o.mp4', 'mp4')).toEqual(expect.arrayContaining(['-i', '/i.mkv', '-c', 'copy', '/o.mp4']));
  });
});

describe('recording quality', () => {
  const s = defaultSettings();
  it('"same as stream" shares the stream encoder', () => {
    expect(recordingEncoderSettings({ ...s.output.recording, quality: 'stream' }, s.output.stream)).toBeNull();
  });
  it('quality presets use constant quality', () => {
    expect(recordingEncoderSettings({ ...s.output.recording, quality: 'indistinguishable' }, s.output.stream)).toMatchObject({ rateControl: 'cqp', cq: 16 });
    expect(recordingEncoderSettings({ ...s.output.recording, quality: 'high' }, s.output.stream)).toMatchObject({ rateControl: 'cqp', cq: 23 });
  });
  it('encoder key distinguishes settings', () => {
    expect(encoderSettingsKey(enc())).toBe(encoderSettingsKey(enc()));
    expect(encoderSettingsKey(enc({ videoBitrate: 1 }))).not.toBe(encoderSettingsKey(enc()));
  });
});

describe('ffmpeg output parsing', () => {
  it('parses progress lines', () => {
    const p = parseStatsLine('frame=  120 fps= 30 q=23.0 size=    1024KiB time=00:00:04.00 bitrate=2097.2kbits/s dup=2 drop=1 speed=   1x');
    expect(p).toMatchObject({ frame: 120, fps: 30, sizeKB: 1024, timeSec: 4, kbps: 2097.2, speed: 1 });
    expect(p?.dropped).toBe(1);
    expect(p?.duplicated).toBe(2);
    expect(parseStatsLine('[flv @ 0x1] Failed to update header')).toBeNull();
  });

  it('turns errors into actionable messages', () => {
    expect(friendlyFfmpegError('Error opening output: Connection refused')).toMatch(/Connection refused/);
    expect(friendlyFfmpegError('Server returned 403 Forbidden')).toMatch(/stream key/);
    expect(friendlyFfmpegError('Cannot load nvcuda.dll')).toMatch(/hardware encoder/);
    expect(friendlyFfmpegError('line one\nlast line here')).toBe('last line here');
  });
});
