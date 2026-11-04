import { describe, expect, it } from 'vitest';
import { dbToFader, dbToGain, faderToDb, formatDuration, formatFilename, gainToDb, hexToRgba, mergeDefaults, normalizeOutputSize, renderTemplate } from '../../src/shared/util';
import { defaultSettings } from '../../src/shared/defaults';
import { sanitizeSettings, validateCollection } from '../../src/main/store';
import { createCollection } from '../../src/shared/defaults';

describe('audio math', () => {
  it('converts dB and gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-100)).toBe(0);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-100);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });
  it('fader mapping is monotonic and round-trips', () => {
    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const db = faderToDb(p);
      expect(db).toBeGreaterThanOrEqual(prev);
      prev = db;
      if (p > 0.01) expect(dbToFader(db)).toBeCloseTo(p, 5);
    }
    expect(faderToDb(1)).toBe(0);
    expect(faderToDb(0)).toBe(-100);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(3_723_000)).toBe('01:02:03');
  });
  it('builds safe file names', () => {
    expect(formatFilename('Stream %Y-%m-%d %H-%M-%S', new Date(2026, 0, 2, 3, 4, 5))).toBe('Stream 2026-01-02 03-04-05');
    expect(formatFilename('a/b:c*?', new Date())).toBe('a-b-c--');
    expect(formatFilename('   ', new Date())).toBe('recording');
  });
  it('renders templates', () => {
    expect(renderTemplate('{name} gave {amount} {unknown}', { name: 'A', amount: '$1' })).toBe('A gave $1 {unknown}');
  });
  it('parses colours', () => {
    expect(hexToRgba('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(hexToRgba('#0f0')).toEqual([0, 1, 0, 1]);
    expect(hexToRgba('#00000080')[3]).toBeCloseTo(0.502, 2);
    expect(hexToRgba('bogus')).toEqual([0, 0, 0, 1]);
  });
});

describe('settings', () => {
  it('merges defaults deeply while keeping user values', () => {
    const merged = mergeDefaults(defaultSettings(), { video: { fpsNum: 60 }, hotkeys: { toggleStream: 'F9' } });
    expect(merged.video.fpsNum).toBe(60);
    expect(merged.video.baseWidth).toBe(1920);
    expect(merged.hotkeys.toggleStream).toBe('F9');
    expect(merged.output.recording.format).toBe('mp4');
  });
  it('normalises output size to multiples of 4', () => {
    expect(normalizeOutputSize(854, 480)).toEqual({ width: 856, height: 480 });
    expect(normalizeOutputSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(normalizeOutputSize(10, 10)).toEqual({ width: 64, height: 64 });
  });
  it('sanitises dangerous values', () => {
    const s = sanitizeSettings({ video: { outputWidth: 1366, outputHeight: 767, fpsNum: 0, fpsDen: 1 }, output: { stream: { videoBitrate: -5, keyframeSec: 99 } }, audio: { sampleRate: 96000 }, server: { port: 80 } });
    expect(s.video.outputWidth % 4).toBe(0);
    expect(s.video.outputHeight % 4).toBe(0);
    expect(s.video.fpsNum).toBe(30);
    expect(s.output.stream.videoBitrate).toBe(200);
    expect(s.output.stream.keyframeSec).toBe(10);
    expect(s.audio.sampleRate).toBe(48000);
    expect(s.server.port).toBe(1024);
    expect(s.server.token).toMatch(/^[0-9a-f]{32}$/);
  });
  it('validates scene collections', () => {
    const c = createCollection('Test');
    expect(validateCollection(JSON.parse(JSON.stringify(c))).id).toBe(c.id);
    expect(() => validateCollection({ ...c, id: '../evil' })).toThrow(/invalid id/);
    expect(() => validateCollection({ ...c, scenes: [] })).toThrow(/no scenes/);
    const fixed = validateCollection({ ...c, activeSceneId: 'missing', transition: undefined });
    expect(fixed.activeSceneId).toBe(c.scenes[0].id);
    expect(fixed.transition.type).toBe('fade');
  });
});
