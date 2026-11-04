import { describe, expect, it } from 'vitest';
import { AUDIO_TRACK, VIDEO_TRACK, buildClusterHeader, buildMkvHeader, encodeVintSize, i420FrameSize } from '../../src/main/output/mkv';
import { MkvSegmenter, readId, readSize } from '../../src/main/output/mkvSegmenter';
import { StreamFanout } from '../../src/main/output/streamFanout';
import type { StreamPiece } from '../../src/main/output/mkvSegmenter';

describe('EBML encoding', () => {
  it('encodes sizes with the shortest valid length', () => {
    expect([...encodeVintSize(0)]).toEqual([0x80]);
    expect([...encodeVintSize(126)]).toEqual([0xfe]);
    expect([...encodeVintSize(127)]).toEqual([0x40, 0x7f]); // 0xff would mean "unknown"
    expect(encodeVintSize(3_110_400).length).toBe(4);
    expect(() => encodeVintSize(-1)).toThrow();
  });

  it('round-trips through the reader', () => {
    for (const n of [0, 1, 126, 127, 16382, 16383, 2_000_000, 3_110_400, 2 ** 40]) {
      const b = encodeVintSize(n);
      expect(readSize(b, 0)).toEqual({ value: n, length: b.length, unknown: false });
    }
    expect(readSize(Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)?.unknown).toBe(true);
    expect(readId(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 0)?.value).toBe(0x1a45dfa3);
    expect(readSize(Buffer.from([0x40]), 0)).toBeNull(); // incomplete
  });

  it('I420 frame size', () => {
    expect(i420FrameSize(1920, 1080)).toBe(1920 * 1080 * 1.5);
    expect(i420FrameSize(1280, 720)).toBe(1382400);
  });

  it('cluster header sizes are self-consistent', () => {
    const h = buildClusterHeader(VIDEO_TRACK, 123456, 1000);
    const id = readId(h, 0)!;
    const size = readSize(h, id.length)!;
    expect(id.value).toBe(0x1f43b675);
    expect(h.length - id.length - size.length + 1000).toBe(size.value);
  });
});

/** Build an encoded-like Matroska stream: header + clusters with one block each. */
function fakeStream(frames: { key: boolean; video: boolean }[]): { header: Buffer; clusters: Buffer[] } {
  const header = buildMkvHeader({ width: 64, height: 64, fpsNum: 30, fpsDen: 1, sampleRate: 48000, channels: 2 });
  const clusters = frames.map((f, i) => {
    const payload = Buffer.alloc(50 + i, i & 0xff);
    const c = buildClusterHeader(f.video ? VIDEO_TRACK : AUDIO_TRACK, i * 1000, payload.length);
    // buildClusterHeader always marks blocks as keyframes; clear the flag for non-key video frames
    if (!f.key) c[c.length - 1] = 0x00;
    return Buffer.concat([c, payload]);
  });
  return { header, clusters };
}

describe('MkvSegmenter', () => {
  const frames = [
    { key: true, video: true },
    { key: true, video: false },
    { key: false, video: true },
    { key: true, video: false },
    { key: false, video: true },
    { key: true, video: true },
    { key: false, video: true },
  ];
  const { header, clusters } = fakeStream(frames);
  const all = Buffer.concat([header, ...clusters]);

  for (const chunk of [1, 7, 64, 1000, all.length]) {
    it(`finds the header and GOP starts with ${chunk}-byte chunks`, () => {
      const seg = new MkvSegmenter();
      const pieces: StreamPiece[] = [];
      for (let i = 0; i < all.length; i += chunk) pieces.push(...seg.push(all.subarray(i, i + chunk)));
      expect(seg.header?.equals(header)).toBe(true);
      expect(pieces.map((p) => p.data.length)).toEqual(clusters.map((c) => c.length));
      expect(pieces.map((p) => p.gopStart)).toEqual([true, false, false, false, false, true, false]);
      expect(pieces.reduce((n, p) => n + p.videoFrames, 0)).toBe(5);
      expect(Buffer.concat([seg.header!, ...pieces.map((p) => p.data)]).equals(all)).toBe(true);
    });
  }

  it('rejects non-Matroska data', () => {
    expect(() => new MkvSegmenter().push(Buffer.from('this is not matroska at all'))).toThrow();
  });
});

describe('StreamFanout', () => {
  const piece = (gopStart: boolean, tag: number, size = 10): StreamPiece => ({ data: Buffer.alloc(size, tag), gopStart, videoFrames: 1, time: 0 });

  function sink() {
    const got: number[] = [];
    let backlog = 0;
    let ended = false;
    return {
      got,
      setBacklog: (b: number) => (backlog = b),
      ended: () => ended,
      sink: { write: (d: Buffer) => void got.push(d[0]), backlog: () => backlog, end: () => void (ended = true) },
    };
  }

  it('late joiners get the header and start at a keyframe', () => {
    const f = new StreamFanout();
    f.header = Buffer.from([0xee]);
    const s = sink();
    f.subscribe(s.sink);
    f.push(piece(false, 1));
    f.push(piece(true, 2));
    f.push(piece(false, 3));
    expect(s.got).toEqual([0xee, 2, 3]);
  });

  it('drops whole GOPs while congested and resumes at the next keyframe', () => {
    const f = new StreamFanout();
    f.header = Buffer.from([0xee]);
    const s = sink();
    const sub = f.subscribe(s.sink, { highWater: 100, lowWater: 10 });
    f.push(piece(true, 1));
    s.setBacklog(300); // slow network (above high water, below the 4x emergency limit)
    f.push(piece(false, 2)); // mid-GOP: still delivered (below 4x high water)
    f.push(piece(true, 3)); // new GOP while congested: dropped
    f.push(piece(false, 4)); // rest of that GOP: dropped
    s.setBacklog(50); // drained below high but above low water
    f.push(piece(true, 5)); // still congested (needs to drop below low water)
    s.setBacklog(0);
    f.push(piece(false, 6)); // waiting for a GOP start
    f.push(piece(true, 7)); // resumes here
    expect(s.got).toEqual([0xee, 1, 2, 7]);
    expect(sub.droppedFrames).toBe(4);
    expect(sub.congested).toBe(false);
  });

  it('taps see every piece and ends propagate', () => {
    const f = new StreamFanout();
    const seen: number[] = [];
    let tapEnded = false;
    f.tap(
      (p) => seen.push(p.data[0]),
      () => (tapEnded = true),
    );
    const s = sink();
    f.subscribe(s.sink);
    f.push(piece(false, 1));
    f.push(piece(true, 2));
    f.end();
    expect(seen).toEqual([1, 2]);
    expect(tapEnded).toBe(true);
    expect(s.ended()).toBe(true);
  });
});
