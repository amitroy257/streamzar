import { describe, expect, it } from 'vitest';
import { parseRange } from '../../src/main/protocol';
import { validateRemoteCommand } from '../../src/main/services/server';

describe('HTTP range parsing', () => {
  it('parses byte ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=2000-3000', 1000)).toBeNull();
    expect(parseRange('bytes=5-1', 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
  });
});

describe('remote control commands', () => {
  it('accepts only well-formed commands', () => {
    expect(validateRemoteCommand({ type: 'switchScene', sceneId: 's1' })).toEqual({ type: 'switchScene', sceneId: 's1' });
    expect(validateRemoteCommand({ type: 'setVolume', sourceId: 'a', volumeDb: 99 })).toEqual({ type: 'setVolume', sourceId: 'a', volumeDb: 26 });
    expect(validateRemoteCommand({ type: 'hotkey', action: 'toggleStream' })).toEqual({ type: 'hotkey', action: 'toggleStream' });
    expect(validateRemoteCommand({ type: 'hotkey', action: 'deleteEverything' })).toBeNull();
    expect(validateRemoteCommand({ type: 'switchScene' })).toBeNull();
    expect(validateRemoteCommand({ type: 'eval', code: '1' })).toBeNull();
    expect(validateRemoteCommand(null)).toBeNull();
  });
});

