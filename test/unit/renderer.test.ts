import { describe, expect, it, beforeEach } from 'vitest';
import { parseCubeLut } from '../../src/renderer/engine/gl/compositor';
import { AlertManager, SessionStats } from '../../src/renderer/engine/live';
import { DEFAULT_ALERTS } from '../../src/shared/defaults';
import type { AlertEvent } from '../../src/shared/types';

describe('.cube LUT parsing', () => {
  it('parses a 2x2x2 identity LUT', () => {
    const lines = ['TITLE "id"', 'LUT_3D_SIZE 2'];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${r} ${g} ${b}`);
    const lut = parseCubeLut(lines.join('\n'));
    expect(lut.size).toBe(2);
    expect([...lut.data.slice(0, 6)]).toEqual([0, 0, 0, 255, 0, 0]);
    expect([...lut.data.slice(-3)]).toEqual([255, 255, 255]);
  });
  it('rejects broken files', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0')).toThrow();
    expect(() => parseCubeLut('hello')).toThrow();
  });
});

describe('alert queue', () => {
  let m: AlertManager;
  const ev = (id: string, type: AlertEvent['type'] = 'follow', amount?: number): AlertEvent => ({ id, type, platform: 'test', name: id, amount, time: 0 });
  beforeEach(() => {
    m = new AlertManager();
    m.history = [];
    m.setSettings(JSON.parse(JSON.stringify(DEFAULT_ALERTS)));
  });

  it('plays alerts one after another with a pause in between', () => {
    m.push(ev('a'));
    m.push(ev('b'));
    m.tick(0);
    expect(m.current?.event.id).toBe('a');
    m.tick(4999);
    expect(m.current?.event.id).toBe('a');
    m.tick(5000); // follow duration 5000ms
    expect(m.current).toBeNull();
    m.tick(5500); // within the 1000ms gap
    expect(m.current).toBeNull();
    m.tick(6000);
    expect(m.current?.event.id).toBe('b');
  });

  it('respects disabled types, minimum amounts and de-duplicates', () => {
    const s = JSON.parse(JSON.stringify(DEFAULT_ALERTS));
    s.types.follow.enabled = false;
    s.types.donation.minAmount = 5;
    m.setSettings(s);
    m.push(ev('f'));
    m.push(ev('d1', 'donation', 2));
    m.push(ev('d2', 'donation', 10));
    m.push(ev('d2', 'donation', 10));
    m.tick(0);
    expect(m.current?.event.id).toBe('d2');
    expect(m.queued).toBe(0);
    expect(m.history.map((h) => h.id)).toEqual(['d2', 'd1', 'f']);
  });

  it('lets only one alert box claim the sound', () => {
    expect(m.claimSound('x', 'box1')).toBe(true);
    expect(m.claimSound('x', 'box2')).toBe(false);
    expect(m.claimSound('x', 'box1')).toBe(true);
  });
});

describe('stream labels', () => {
  it('tracks latest and session values', () => {
    const s = new SessionStats();
    s.latest = {};
    s.record({ id: '1', type: 'follow', platform: 'test', name: 'Ann', time: 0 });
    s.record({ id: '2', type: 'donation', platform: 'test', name: 'Bob', amount: 5, currency: 'USD', formattedAmount: '$5.00', time: 0 });
    s.record({ id: '3', type: 'donation', platform: 'test', name: 'Cy', amount: 2, currency: 'USD', formattedAmount: '$2.00', time: 0 });
    expect(s.label('latest_follower', 'Latest: {name}', '-', 0)).toBe('Latest: Ann');
    expect(s.label('top_donation', '{name} {amount}', '-', 0)).toBe('Bob $5.00');
    expect(s.label('latest_donation', '{name} {amount}', '-', 0)).toBe('Cy $2.00');
    expect(s.label('session_donation_total', 'Total {amount}', '-', 0)).toBe('Total $7.00');
    expect(s.label('latest_raid', '{name}', 'none yet', 0)).toBe('none yet');
    expect(s.label('viewer_count', '{count} watching', '', 12)).toBe('12 watching');
  });
});
