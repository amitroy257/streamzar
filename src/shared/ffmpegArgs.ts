// Pure builders for every FFmpeg command line Streamzar runs. Kept free of Node APIs so they can be
// unit-tested and reused. All commands are spawned without a shell, so no quoting is needed.

import type { EncoderId, EncoderInfo, EncoderSettings, QualityPreset, RecordingFormat, RecordingSettings } from './types';
import type { OutputProtocol } from './platforms';

export const ENCODERS: Omit<EncoderInfo, 'available'>[] = [
  { id: 'libx264', label: 'Software (x264)', hardware: false, codec: 'h264' },
  { id: 'h264_nvenc', label: 'NVIDIA NVENC H.264', hardware: true, codec: 'h264' },
  { id: 'h264_qsv', label: 'Intel QuickSync H.264', hardware: true, codec: 'h264' },
  { id: 'h264_amf', label: 'AMD AMF H.264', hardware: true, codec: 'h264' },
  { id: 'h264_videotoolbox', label: 'Apple VideoToolbox H.264', hardware: true, codec: 'h264' },
  { id: 'h264_vaapi', label: 'VA-API H.264 (Linux)', hardware: true, codec: 'h264' },
  { id: 'libx265', label: 'Software (x265 HEVC)', hardware: false, codec: 'hevc' },
  { id: 'hevc_nvenc', label: 'NVIDIA NVENC HEVC', hardware: true, codec: 'hevc' },
  { id: 'hevc_qsv', label: 'Intel QuickSync HEVC', hardware: true, codec: 'hevc' },
  { id: 'hevc_amf', label: 'AMD AMF HEVC', hardware: true, codec: 'hevc' },
  { id: 'hevc_videotoolbox', label: 'Apple VideoToolbox HEVC', hardware: true, codec: 'hevc' },
];

export function encoderCodec(id: EncoderId): 'h264' | 'hevc' {
  return id.startsWith('hevc') || id === 'libx265' ? 'hevc' : 'h264';
}

export function encoderFamily(id: EncoderId): 'x264' | 'x265' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox' | 'vaapi' {
  if (id === 'libx264') return 'x264';
  if (id === 'libx265') return 'x265';
  if (id.endsWith('_nvenc')) return 'nvenc';
  if (id.endsWith('_qsv')) return 'qsv';
  if (id.endsWith('_amf')) return 'amf';
  if (id.endsWith('_videotoolbox')) return 'videotoolbox';
  return 'vaapi';
}

const X26X_PRESETS: Record<QualityPreset, string> = { speed: 'superfast', balanced: 'veryfast', quality: 'fast', max_quality: 'medium' };
const NVENC_PRESETS: Record<QualityPreset, string> = { speed: 'p2', balanced: 'p4', quality: 'p5', max_quality: 'p7' };
const QSV_PRESETS: Record<QualityPreset, string> = { speed: 'veryfast', balanced: 'fast', quality: 'medium', max_quality: 'slow' };
const AMF_QUALITY: Record<QualityPreset, string> = { speed: 'speed', balanced: 'balanced', quality: 'quality', max_quality: 'quality' };

export interface VideoArgsContext {
  fpsNum: number;
  fpsDen: number;
}

export function keyframeInterval(settings: EncoderSettings, ctx: VideoArgsContext): number {
  const fps = ctx.fpsNum / ctx.fpsDen;
  const sec = settings.keyframeSec > 0 ? settings.keyframeSec : 2;
  return Math.max(1, Math.round(fps * sec));
}

/** Video encoder options (everything after the filter graph, before the muxer). */
export function buildVideoEncoderArgs(s: EncoderSettings, ctx: VideoArgsContext): string[] {
  const fam = encoderFamily(s.encoder);
  const codec = encoderCodec(s.encoder);
  const g = keyframeInterval(s, ctx);
  const b = Math.max(100, Math.round(s.videoBitrate));
  const maxr = Math.max(b, Math.round(s.maxBitrate || b));
  const cq = Math.round(Math.min(51, Math.max(0, s.cq)));
  const bf = Math.max(0, Math.min(4, Math.round(s.bframes)));
  const args: string[] = ['-c:v', s.encoder];

  const rate = (): string[] => {
    if (s.rateControl === 'cbr') return ['-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${b}k`];
    if (s.rateControl === 'vbr') return ['-b:v', `${b}k`, '-maxrate', `${maxr}k`, '-bufsize', `${maxr * 2}k`];
    return [];
  };
  // HEVC encoders only support main profile for 8-bit 4:2:0.
  const profile = codec === 'hevc' ? 'main' : s.profile;

  switch (fam) {
    case 'x264': {
      args.push('-preset', X26X_PRESETS[s.preset], '-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-crf', String(cq));
      else args.push(...rate());
      const params = ['force-cfr=1'];
      if (s.rateControl === 'cbr') params.unshift('nal-hrd=cbr');
      args.push('-x264-params', params.join(':'));
      args.push('-g', String(g), '-keyint_min', String(g), '-sc_threshold', '0', '-bf', String(profile === 'baseline' ? 0 : bf));
      args.push('-pix_fmt', 'yuv420p');
      break;
    }
    case 'x265': {
      args.push('-preset', X26X_PRESETS[s.preset], '-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-crf', String(cq));
      else args.push(...rate());
      args.push('-g', String(g), '-keyint_min', String(g), '-bf', String(bf));
      args.push('-x265-params', `scenecut=0:log-level=error`);
      args.push('-pix_fmt', 'yuv420p');
      break;
    }
    case 'nvenc': {
      args.push('-preset', NVENC_PRESETS[s.preset], '-tune', 'hq', '-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-maxrate', `${Math.max(maxr, 50000)}k`);
      else args.push('-rc', s.rateControl, ...rate());
      args.push('-g', String(g), '-bf', String(profile === 'baseline' ? 0 : bf), '-no-scenecut', '1', '-spatial-aq', '1', '-forced-idr', '1');
      args.push('-pix_fmt', 'yuv420p');
      break;
    }
    case 'qsv': {
      args.push('-preset', QSV_PRESETS[s.preset], '-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-global_quality', String(cq));
      else args.push(...rate());
      args.push('-g', String(g), '-bf', String(profile === 'baseline' ? 0 : bf));
      args.push('-pix_fmt', 'nv12');
      break;
    }
    case 'amf': {
      args.push('-usage', 'transcoding', '-quality', AMF_QUALITY[s.preset], '-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq), '-qp_b', String(cq));
      else args.push('-rc', s.rateControl === 'cbr' ? 'cbr' : 'vbr_peak', ...rate());
      args.push('-g', String(g));
      args.push('-pix_fmt', 'nv12');
      break;
    }
    case 'videotoolbox': {
      args.push('-profile:v', profile);
      if (s.rateControl === 'cqp') {
        // VideoToolbox quality is 1..100 (higher is better); map from the 0..51 quantizer scale.
        args.push('-q:v', String(Math.round(Math.min(100, Math.max(1, 100 - cq * 1.6)))));
      } else {
        args.push(...rate());
      }
      if (s.preset === 'speed' || s.preset === 'balanced') args.push('-realtime', '1');
      args.push('-g', String(g), '-bf', String(profile === 'baseline' ? 0 : bf));
      args.push('-pix_fmt', 'nv12');
      break;
    }
    case 'vaapi': {
      args.push('-profile:v', profile);
      if (s.rateControl === 'cqp') args.push('-rc_mode', 'CQP', '-qp', String(cq));
      else args.push('-rc_mode', s.rateControl === 'cbr' ? 'CBR' : 'VBR', ...rate());
      args.push('-g', String(g), '-bf', String(profile === 'baseline' ? 0 : bf));
      break;
    }
  }
  args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  if (codec === 'hevc') args.push('-tag:v', 'hvc1');
  return args;
}

export function fpsExpr(num: number, den: number): string {
  return den === 1 ? String(num) : `${num}/${den}`;
}

export interface EncoderJobOptions {
  settings: EncoderSettings;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  verbose?: boolean;
  /** Linux VA-API render node */
  vaapiDevice?: string;
}

/**
 * Encoder process: reads the raw Matroska stream (I420 video + float PCM audio) produced by the
 * MediaHub on stdin and writes a Matroska stream with H.264/HEVC + AAC to stdout. One block per
 * Cluster so every keyframe is a clean entry point for consumers joining mid-stream.
 */
export function buildEncoderArgs(o: EncoderJobOptions): string[] {
  const fam = encoderFamily(o.settings.encoder);
  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', o.verbose ? 'info' : 'warning', '-stats', '-stats_period', '1'];
  if (fam === 'vaapi') args.push('-vaapi_device', o.vaapiDevice || '/dev/dri/renderD128');
  args.push('-thread_queue_size', '1024', '-probesize', '32M', '-analyzeduration', '0', '-f', 'matroska', '-i', 'pipe:0');
  args.push('-map', '0:v:0', '-map', '0:a:0');
  const vf = [`fps=${fpsExpr(o.fpsNum, o.fpsDen)}`];
  if (fam === 'vaapi') vf.push('format=nv12', 'hwupload');
  args.push('-vf', vf.join(','));
  args.push(...buildVideoEncoderArgs(o.settings, { fpsNum: o.fpsNum, fpsDen: o.fpsDen }));
  args.push(
    '-af',
    'aresample=async=1000:first_pts=0',
    '-c:a',
    'aac',
    '-b:a',
    `${Math.max(64, Math.min(512, Math.round(o.settings.audioBitrate)))}k`,
    '-ar',
    String(o.sampleRate),
    '-ac',
    '2',
  );
  args.push('-f', 'matroska', '-live', '1', '-cluster_size_limit', '1', '-write_crc32', '0', '-flush_packets', '1', 'pipe:1');
  return args;
}

/** Push the already-encoded stream (Matroska on stdin) to one ingest URL without re-encoding. */
export function buildPusherArgs(url: string, protocol: OutputProtocol, verbose = false): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', verbose ? 'info' : 'warning', '-stats', '-stats_period', '1'];
  args.push('-f', 'matroska', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy');
  if (protocol === 'srt') {
    args.push('-f', 'mpegts', url);
  } else {
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', url);
  }
  return args;
}

export const RECORDING_EXTENSIONS: Record<RecordingFormat, string> = {
  mp4: 'mp4',
  fmp4: 'mp4',
  mkv: 'mkv',
  mov: 'mov',
  flv: 'flv',
  ts: 'ts',
};

export const RECORDING_FORMAT_LABELS: Record<RecordingFormat, string> = {
  mp4: 'MP4',
  fmp4: 'Fragmented MP4 (crash-safe)',
  mkv: 'MKV (crash-safe)',
  mov: 'MOV',
  flv: 'FLV',
  ts: 'MPEG-TS',
};

function muxerArgs(format: RecordingFormat, hevc: boolean): string[] {
  // Apple players need the 'hvc1' tag for HEVC in MP4/MOV.
  const tag = hevc ? ['-tag:v', 'hvc1'] : [];
  switch (format) {
    case 'mp4':
      return [...tag, '-f', 'mp4'];
    case 'fmp4':
      return [...tag, '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];
    case 'mkv':
      return ['-f', 'matroska'];
    case 'mov':
      return [...tag, '-f', 'mov'];
    case 'flv':
      return ['-f', 'flv'];
    case 'ts':
      return ['-f', 'mpegts'];
  }
}

/** Write the encoded stream (Matroska on stdin) to a file without re-encoding. */
export function buildRecorderArgs(outputPath: string, format: RecordingFormat, verbose = false, hevc = false): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    verbose ? 'info' : 'warning',
    '-f',
    'matroska',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    ...muxerArgs(format, hevc),
    '-y',
    outputPath,
  ];
}

/** Convert a finished file (e.g. replay buffer dump or MKV recording) to another container. */
export function buildRemuxArgs(inputPath: string, outputPath: string, format: RecordingFormat, hevc = false): string[] {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', inputPath, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', ...muxerArgs(format, hevc), '-y', outputPath];
}

/** Short synthetic encode used to check that a (hardware) encoder actually works on this machine. */
export function buildEncoderProbeArgs(settings: EncoderSettings, vaapiDevice?: string): string[] {
  const fam = encoderFamily(settings.encoder);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (fam === 'vaapi') args.push('-vaapi_device', vaapiDevice || '/dev/dri/renderD128');
  args.push('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '10');
  if (fam === 'vaapi') args.push('-vf', 'format=nv12,hwupload');
  args.push(...buildVideoEncoderArgs(settings, { fpsNum: 30, fpsDen: 1 }), '-f', 'null', '-');
  return args;
}

/** Resolve the encoder settings used for recordings (null = share the stream encoder). */
export function recordingEncoderSettings(rec: RecordingSettings, stream: EncoderSettings): EncoderSettings | null {
  switch (rec.quality) {
    case 'stream':
      return null;
    case 'high':
      return { ...stream, rateControl: 'cqp', cq: 23, preset: stream.preset === 'speed' ? 'balanced' : stream.preset };
    case 'indistinguishable':
      return { ...stream, rateControl: 'cqp', cq: 16, preset: stream.preset === 'speed' ? 'balanced' : stream.preset };
    case 'custom':
      return { ...rec.encoder };
  }
}

export function encoderSettingsKey(s: EncoderSettings): string {
  return JSON.stringify([s.encoder, s.rateControl, s.videoBitrate, s.maxBitrate, s.cq, s.keyframeSec, s.preset, s.profile, s.bframes, s.audioBitrate]);
}

export interface StatsLine {
  frame?: number;
  fps?: number;
  kbps?: number;
  speed?: number;
  sizeKB?: number;
  timeSec?: number;
  dropped?: number;
  duplicated?: number;
}

/** Parse an FFmpeg "-stats" progress line, e.g. "frame=  120 fps= 30 q=23.0 size= 1024kB time=00:00:04.00 bitrate=2097.2kbits/s speed=   1x" */
export function parseStatsLine(line: string): StatsLine | null {
  if (!/(?:^|\s)(frame|size)=/.test(line)) return null;
  const out: StatsLine = {};
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(line);
    if (!m) return undefined;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : undefined;
  };
  out.frame = num(/frame=\s*(\d+)/);
  out.fps = num(/fps=\s*([\d.]+)/);
  out.kbps = num(/bitrate=\s*([\d.]+)kbits\/s/);
  out.speed = num(/speed=\s*([\d.]+)x/);
  const size = /size=\s*([\d.]+)\s*(kB|KiB|MB|MiB|B)/.exec(line);
  if (size) {
    const v = parseFloat(size[1]);
    const unit = size[2];
    out.sizeKB = unit === 'B' ? v / 1024 : unit === 'MB' || unit === 'MiB' ? v * 1024 : v;
  }
  const t = /time=\s*(-?)(\d+):(\d+):([\d.]+)/.exec(line);
  if (t) out.timeSec = (t[1] ? -1 : 1) * (parseInt(t[2], 10) * 3600 + parseInt(t[3], 10) * 60 + parseFloat(t[4]));
  out.dropped = num(/drop=\s*(\d+)/);
  out.duplicated = num(/dup=\s*(\d+)/);
  return out;
}

/** Turn an FFmpeg error output into something a streamer can act on. */
export function friendlyFfmpegError(stderrTail: string): string {
  const s = stderrTail.toLowerCase();
  if (s.includes('connection refused')) return 'Connection refused by the server. Check the server URL.';
  if (s.includes('server returned 4') || s.includes('unauthorized') || s.includes('forbidden')) return 'The server rejected the stream key. Check that your stream key is correct and current.';
  if (s.includes('name or service not known') || s.includes('failed to resolve') || s.includes('nodename nor servname') || s.includes('no such host')) return 'Could not resolve the server address. Check your internet connection and the server URL.';
  if (s.includes('connection timed out') || s.includes('operation timed out') || s.includes('timed out')) return 'Connection timed out. Check your internet connection or firewall.';
  if (s.includes('broken pipe') || s.includes('connection reset')) return 'The connection to the server was lost.';
  if (s.includes('tls') || s.includes('ssl') || s.includes('certificate')) return 'Secure (RTMPS) connection failed. Try the RTMP server option or check your system clock.';
  if (s.includes('cannot load') || s.includes('no capable devices') || s.includes('nvenc') || s.includes('device creation failed') || s.includes('no device available')) return 'The selected hardware encoder is not available. Choose another encoder in Settings → Output.';
  if (s.includes('permission denied')) return 'Permission denied. Choose a different recording folder.';
  if (s.includes('no space left')) return 'The disk is full.';
  const lines = stderrTail.trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : 'FFmpeg exited unexpectedly.';
}
