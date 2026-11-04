// Splits the encoder's Matroska output into independently joinable pieces.
//
// The encoder is run with -cluster_size_limit 1, so FFmpeg starts a new Cluster for (almost) every
// packet and in particular for every video keyframe. A consumer can join the stream at any time by receiving the cached header
// (EBML + Segment + Info + Tracks ...) followed by Clusters starting at a keyframe.

export interface StreamPiece {
  data: Buffer;
  /** Piece is a Cluster that starts with a video keyframe (valid entry point). */
  gopStart: boolean;
  /** Number of video frames in this piece. */
  videoFrames: number;
  /** Arrival time (ms) */
  time: number;
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

export interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** Read an EBML element ID (marker bits kept). Returns null if not enough data. */
export function readId(buf: Buffer, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4) throw new Error('invalid EBML id');
  if (off + len > buf.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  return { value: v, length: len, unknown: false };
}

/** Read an EBML data size vint. Returns null if not enough data. */
export function readSize(buf: Buffer, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('invalid EBML size');
  if (off + len > buf.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + buf[off + i];
    if (buf[off + i] !== 0xff) allOnes = false;
  }
  return { value: v, length: len, unknown: allOnes };
}

interface Child {
  id: number;
  dataStart: number;
  dataEnd: number;
}

function* children(buf: Buffer, start: number, end: number): Generator<Child> {
  let off = start;
  while (off < end) {
    const id = readId(buf, off);
    if (!id) return;
    const size = readSize(buf, off + id.length);
    if (!size || size.unknown) return;
    const dataStart = off + id.length + size.length;
    const dataEnd = dataStart + size.value;
    if (dataEnd > end) return;
    yield { id: id.value, dataStart, dataEnd };
    off = dataEnd;
  }
}

function readUint(buf: Buffer, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

/** Find the video track number in a Tracks element body. */
export function findVideoTrack(buf: Buffer, start: number, end: number): number | null {
  for (const te of children(buf, start, end)) {
    if (te.id !== ID_TRACK_ENTRY) continue;
    let num: number | null = null;
    let type: number | null = null;
    for (const c of children(buf, te.dataStart, te.dataEnd)) {
      if (c.id === ID_TRACK_NUMBER) num = readUint(buf, c.dataStart, c.dataEnd);
      else if (c.id === ID_TRACK_TYPE) type = readUint(buf, c.dataStart, c.dataEnd);
    }
    if (type === 1 && num !== null) return num;
  }
  return null;
}

/**
 * Inspect a Cluster body: does its first *video* block carry a keyframe, and how many video blocks
 * are there? FFmpeg's Matroska muxer holds back one audio packet so that it lands in the same
 * Cluster as the following keyframe, so keyframe Clusters typically look like [audio, video key].
 * Leading audio blocks are harmless for a consumer that joins at such a Cluster.
 */
export function inspectCluster(buf: Buffer, start: number, end: number, videoTrack: number): { firstVideoIsKey: boolean; videoFrames: number } {
  let firstVideoIsKey = false;
  let videoFrames = 0;
  for (const c of children(buf, start, end)) {
    let blockStart = -1;
    let blockEnd = -1;
    let simple = false;
    if (c.id === ID_SIMPLE_BLOCK) {
      blockStart = c.dataStart;
      blockEnd = c.dataEnd;
      simple = true;
    } else if (c.id === ID_BLOCK_GROUP) {
      for (const g of children(buf, c.dataStart, c.dataEnd)) {
        if (g.id === ID_BLOCK) {
          blockStart = g.dataStart;
          blockEnd = g.dataEnd;
        }
      }
    } else {
      continue; // Timestamp, CRC-32, Void, ...
    }
    if (blockStart < 0) continue;
    const track = readSize(buf, blockStart);
    if (!track || blockStart + track.length + 3 > blockEnd) continue;
    if (track.value !== videoTrack) continue;
    const flags = buf[blockStart + track.length + 2];
    // FFmpeg writes video as SimpleBlocks with the keyframe flag; BlockGroups are treated as non-key.
    if (videoFrames === 0) firstVideoIsKey = simple && (flags & 0x80) !== 0;
    videoFrames++;
  }
  return { firstVideoIsKey, videoFrames };
}

export class MkvSegmenter {
  private pending: Buffer = Buffer.alloc(0);
  private state: 'ebml' | 'segment' | 'elements' = 'ebml';
  private headerParts: Buffer[] = [];
  private videoTrack = 1;
  header: Buffer | null = null;

  /** Feed encoder output; returns complete pieces (header is exposed via `header`). */
  push(chunk: Buffer, now = Date.now()): StreamPiece[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: StreamPiece[] = [];
    let off = 0;
    const buf = this.pending;
    for (;;) {
      const id = readId(buf, off);
      if (!id) break;
      // Fail fast on garbage instead of buffering forever.
      if (this.state === 'ebml' && id.value !== ID_EBML) throw new Error('not a Matroska stream');
      if (this.state === 'segment' && id.value !== ID_SEGMENT) throw new Error('expected Matroska Segment');
      const size = readSize(buf, off + id.length);
      if (!size) break;
      const headLen = id.length + size.length;
      if (this.state === 'segment' || (id.value === ID_SEGMENT && this.state !== 'elements')) {
        // Segment header: keep only ID + size, its children are parsed individually.
        if (id.value !== ID_SEGMENT) throw new Error('expected Matroska Segment');
        this.headerParts.push(Buffer.from(buf.subarray(off, off + headLen)));
        off += headLen;
        this.state = 'elements';
        continue;
      }
      if (size.unknown) throw new Error('unexpected unknown-size Matroska element');
      const total = headLen + size.value;
      if (off + total > buf.length) break;
      const el = buf.subarray(off, off + total);
      const dataStart = off + headLen;
      const dataEnd = off + total;
      if (this.state === 'ebml') {
        if (id.value !== ID_EBML) throw new Error('not a Matroska stream');
        this.headerParts.push(Buffer.from(el));
        this.state = 'segment';
      } else if (id.value === ID_CLUSTER) {
        if (!this.header) this.header = Buffer.concat(this.headerParts);
        const info = inspectCluster(buf, dataStart, dataEnd, this.videoTrack);
        out.push({ data: Buffer.from(el), gopStart: info.firstVideoIsKey, videoFrames: info.videoFrames, time: now });
      } else if (!this.header) {
        if (id.value === ID_TRACKS) this.videoTrack = findVideoTrack(buf, dataStart, dataEnd) ?? 1;
        this.headerParts.push(Buffer.from(el));
      } else {
        // Late level-1 elements (Tags/Cues at the end of the stream): pass through.
        out.push({ data: Buffer.from(el), gopStart: false, videoFrames: 0, time: now });
      }
      off += total;
    }
    this.pending = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
    return out;
  }
}
