// Minimal streaming Matroska writer for raw I420 video + 32-bit float PCM audio.
// Every packet is written as its own Cluster with a known size, which keeps the stream trivially
// valid when it is cut at any packet boundary and lets FFmpeg read it from a pipe with zero probing.

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  ColourSpace: 0x2eb524,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
} as const;

function idBytes(id: number): Buffer {
  if (id >= 0x1000000) return Buffer.from([(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  if (id >= 0x10000) return Buffer.from([(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  if (id >= 0x100) return Buffer.from([(id >>> 8) & 0xff, id & 0xff]);
  return Buffer.from([id & 0xff]);
}

/** EBML variable-size integer for element data sizes. */
export function encodeVintSize(size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid EBML size ${size}`);
  for (let len = 1; len <= 8; len++) {
    // all-ones is reserved for "unknown size"
    const max = 2 ** (7 * len) - 2;
    if (size <= max) {
      const out = Buffer.alloc(len);
      let v = size;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error(`EBML size too large: ${size}`);
}

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function el(id: number, data: Buffer): Buffer {
  return Buffer.concat([idBytes(id), encodeVintSize(data.length), data]);
}

function uint(id: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid uint ${value}`);
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, Buffer.from(bytes));
}

function float(id: number, value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value, 0);
  return el(id, b);
}

function str(id: number, value: string): Buffer {
  return el(id, Buffer.from(value, 'utf8'));
}

function master(id: number, children: Buffer[]): Buffer {
  return el(id, Buffer.concat(children));
}

export interface MkvStreamInfo {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  channels: number;
}

export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;

export function i420FrameSize(width: number, height: number): number {
  return width * height + 2 * ((width >> 1) * (height >> 1));
}

/** EBML header + Segment start + Info + Tracks. */
export function buildMkvHeader(info: MkvStreamInfo): Buffer {
  const ebml = master(ID.EBML, [
    uint(ID.EBMLVersion, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, 'matroska'),
    uint(ID.DocTypeVersion, 4),
    uint(ID.DocTypeReadVersion, 2),
  ]);
  const segmentStart = Buffer.concat([idBytes(ID.Segment), UNKNOWN_SIZE]);
  const infoEl = master(ID.Info, [uint(ID.TimestampScale, 1000), str(ID.MuxingApp, 'Streamzar'), str(ID.WritingApp, 'Streamzar')]);
  const frameNs = Math.round((1e9 * info.fpsDen) / info.fpsNum);
  const video = master(ID.TrackEntry, [
    uint(ID.TrackNumber, VIDEO_TRACK),
    uint(ID.TrackUID, VIDEO_TRACK),
    uint(ID.TrackType, 1),
    uint(ID.FlagLacing, 0),
    str(ID.CodecID, 'V_UNCOMPRESSED'),
    uint(ID.DefaultDuration, frameNs),
    master(ID.Video, [
      uint(ID.PixelWidth, info.width),
      uint(ID.PixelHeight, info.height),
      el(ID.ColourSpace, Buffer.from('I420', 'ascii')),
      master(ID.Colour, [uint(ID.MatrixCoefficients, 1), uint(ID.Range, 1), uint(ID.TransferCharacteristics, 1), uint(ID.Primaries, 1)]),
    ]),
  ]);
  const audio = master(ID.TrackEntry, [
    uint(ID.TrackNumber, AUDIO_TRACK),
    uint(ID.TrackUID, AUDIO_TRACK),
    uint(ID.TrackType, 2),
    uint(ID.FlagLacing, 0),
    str(ID.CodecID, 'A_PCM/FLOAT/IEEE'),
    master(ID.Audio, [float(ID.SamplingFrequency, info.sampleRate), uint(ID.Channels, info.channels), uint(ID.BitDepth, 32)]),
  ]);
  const tracks = master(ID.Tracks, [video, audio]);
  return Buffer.concat([ebml, segmentStart, infoEl, tracks]);
}

/**
 * Header bytes for a Cluster holding exactly one SimpleBlock with `payloadLength` bytes of data.
 * The payload itself is written separately (avoids copying multi-megabyte video frames).
 */
export function buildClusterHeader(track: number, timestampUs: number, payloadLength: number): Buffer {
  const ts = uint(ID.Timestamp, Math.max(0, Math.round(timestampUs)));
  // SimpleBlock: track vint (1 byte for tracks < 127), int16 relative timestamp, flags (keyframe)
  const blockHead = Buffer.from([0x80 | track, 0x00, 0x00, 0x80]);
  const blockSize = blockHead.length + payloadLength;
  const simpleBlockHead = Buffer.concat([idBytes(ID.SimpleBlock), encodeVintSize(blockSize), blockHead]);
  const clusterBodySize = ts.length + simpleBlockHead.length + payloadLength;
  return Buffer.concat([idBytes(ID.Cluster), encodeVintSize(clusterBodySize), ts, simpleBlockHead]);
}
