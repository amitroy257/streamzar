import { describe, expect, it } from 'vitest';
import { PLATFORMS, PLATFORM_ORDER, bitrateWarnings, buildIngestUrl, redactUrl, validateDestination } from '../../src/shared/platforms';
import type { Destination } from '../../src/shared/types';

describe('buildIngestUrl', () => {
  it('appends the key to YouTube RTMPS', () => {
    expect(buildIngestUrl('rtmps://a.rtmps.youtube.com:443/live2', 'abcd-efgh-ijkl-mnop')).toEqual({ url: 'rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl-mnop', protocol: 'rtmp' });
  });

  it('keeps the backup query string after the key', () => {
    expect(buildIngestUrl('rtmps://b.rtmps.youtube.com:443/live2?backup=1', 'k1').url).toBe('rtmps://b.rtmps.youtube.com:443/live2/k1?backup=1');
  });

  it('handles trailing slashes and whitespace', () => {
    expect(buildIngestUrl('  rtmp://live.twitch.tv/app/ ', ' live_123 ').url).toBe('rtmp://live.twitch.tv/app/live_123');
  });

  it('keeps Facebook keys that contain their own query string intact', () => {
    const key = 'FB-1234567890-0-AbCdEf?s_bl=1&s_ps=1&s_sw=0&a=Abx';
    expect(buildIngestUrl('rtmps://live-api-s.facebook.com:443/rtmp', key).url).toBe(`rtmps://live-api-s.facebook.com:443/rtmp/${key}`);
  });

  it('builds SRT stream ids', () => {
    expect(buildIngestUrl('srt://ingest.example.com:9000', 'my key/1'.replace(' ', '')).url).toBe('srt://ingest.example.com:9000?streamid=mykey%2F1');
    expect(buildIngestUrl('srt://h:1?latency=200', 'abc')).toEqual({ url: 'srt://h:1?latency=200&streamid=abc', protocol: 'srt' });
  });

  it('allows a custom URL that already contains the key', () => {
    expect(buildIngestUrl('rtmp://example.com/live/secret', '').url).toBe('rtmp://example.com/live/secret');
  });

  it('rejects bad input', () => {
    expect(() => buildIngestUrl('', 'k')).toThrow(/No server/);
    expect(() => buildIngestUrl('http://example.com', 'k')).toThrow(/rtmp/);
    expect(() => buildIngestUrl('rtmp://example.com/app', 'has space')).toThrow(/spaces/);
  });
});

describe('destinations', () => {
  const d = (p: Partial<Destination>): Destination => ({ id: 'x', platform: 'youtube', name: 'YouTube', enabled: true, server: PLATFORMS.youtube.servers[0].url, streamKey: 'key', ...p });

  it('validates required fields', () => {
    expect(validateDestination(d({}))).toBeNull();
    expect(validateDestination(d({ streamKey: '' }))).toMatch(/stream key is missing/);
    expect(validateDestination(d({ server: '' }))).toMatch(/server URL is missing/);
    expect(validateDestination(d({ platform: 'custom', streamKey: '', server: 'rtmp://h/app/key' }))).toBeNull();
  });

  it('every platform has a label, colour and help text, and fixed servers are valid URLs', () => {
    for (const id of PLATFORM_ORDER) {
      const p = PLATFORMS[id];
      expect(p.label).toBeTruthy();
      expect(p.keyHelp).toBeTruthy();
      for (const s of p.servers) expect(s.url).toMatch(/^(rtmps?|srt):\/\//);
      if (!p.serverEditable) expect(p.servers.length).toBeGreaterThan(0);
    }
  });

  it('warns about bitrates above platform recommendations', () => {
    const w = bitrateWarnings([d({ platform: 'facebook', name: 'FB' }), d({ enabled: false, platform: 'twitch' })], 12000, 1080, 60);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/FB: 12000 kbps/);
    expect(bitrateWarnings([d({})], 9000, 1080, 60)).toEqual([]);
  });

  it('redacts stream keys from logs', () => {
    expect(redactUrl('rtmp://h/app/sekret?x=1', 'sekret')).toBe('rtmp://h/app/••••?x=1');
    expect(redactUrl('srt://h?streamid=a%2Fb', 'a/b')).toBe('srt://h?streamid=••••');
  });
});
