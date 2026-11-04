import { describe, expect, it } from 'vitest';
import { canvasToLocal, fitTransform, hitTest, itemBounds, itemBox, itemCorners, itemUv, localToCanvas, resizeByHandle, snapBounds } from '../../src/shared/transform';
import { defaultTransform } from '../../src/shared/defaults';
import type { Transform } from '../../src/shared/types';

const t = (p: Partial<Transform> = {}): Transform => ({ ...defaultTransform(), ...p });

describe('item geometry', () => {
  it('computes boxes with crop and scale', () => {
    expect(itemBox(t({ scaleX: 0.5, scaleY: 2, crop: { left: 10, right: 10, top: 0, bottom: 20 } }), 100, 100)).toEqual({ cw: 80, ch: 80, w: 40, h: 160 });
  });

  it('round-trips between local and canvas space, including rotation', () => {
    const tr = t({ x: 100, y: 50, scaleX: 2, scaleY: 1, rotation: 33 });
    const p = { x: 17, y: 42 };
    const c = localToCanvas(tr, 100, 80, p);
    const back = canvasToLocal(tr, 100, 80, c);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('rotates corners clockwise around the centre', () => {
    const c = itemCorners(t({ rotation: 90 }), 100, 50);
    // centre stays (50,25); top-left corner moves to the top-right of the rotated box
    expect(c[0].x).toBeCloseTo(75, 9);
    expect(c[0].y).toBeCloseTo(-25, 9);
    const b = itemBounds(t({ rotation: 90 }), 100, 50);
    expect(b.w).toBeCloseTo(50, 9);
    expect(b.h).toBeCloseTo(100, 9);
  });

  it('hit-tests rotated items', () => {
    const tr = t({ x: 0, y: 0, rotation: 45 });
    expect(hitTest(tr, 100, 100, { x: 50, y: 50 })).toBe(true);
    expect(hitTest(tr, 100, 100, { x: 2, y: 2 })).toBe(false); // outside the rotated diamond
  });

  it('crops and flips texture coordinates', () => {
    expect(itemUv(t({ crop: { left: 25, right: 25, top: 0, bottom: 50 } }), 100, 100)).toEqual([0.25, 0, 0.75, 0.5]);
    expect(itemUv(t({ flipH: true }), 100, 100)).toEqual([1, 0, 0, 1]);
  });
});

describe('fit presets', () => {
  it('fits, stretches, fills and centres', () => {
    const fit = fitTransform(t(), 1280, 720, 1920, 1080, 'fit');
    expect(fit).toMatchObject({ x: 0, y: 0, scaleX: 1.5, scaleY: 1.5 });
    const tall = fitTransform(t(), 1080, 1920, 1920, 1080, 'fit');
    expect(tall.scaleX).toBeCloseTo(0.5625);
    expect(tall.x).toBeCloseTo((1920 - 1080 * 0.5625) / 2);
    const st = fitTransform(t(), 640, 640, 1920, 1080, 'stretch');
    expect(st).toMatchObject({ x: 0, y: 0, scaleX: 3, scaleY: 1080 / 640 });
    const fill = fitTransform(t(), 1000, 1000, 1920, 1080, 'fill');
    expect(fill.scaleX).toBeCloseTo(1.92);
    const c = fitTransform(t({ x: 5, y: 5 }), 100, 100, 1920, 1080, 'center');
    expect(c).toMatchObject({ x: 910, y: 490 });
    expect(fitTransform(t({ x: 9, scaleX: 3, rotation: 20, crop: { left: 1, right: 1, top: 1, bottom: 1 } }), 10, 10, 100, 100, 'reset')).toEqual(t());
  });
});

describe('resize handles', () => {
  it('corner drag keeps the aspect ratio and the opposite corner fixed', () => {
    const start = t({ x: 100, y: 100 });
    const r = resizeByHandle(start, 200, 100, 'se', { x: 500, y: 200 }, { keepAspect: true, crop: false });
    expect(r.scaleX).toBeCloseTo(r.scaleY, 9);
    expect(r.x).toBeCloseTo(100, 9);
    expect(r.y).toBeCloseTo(100, 9);
    expect(r.scaleX).toBeCloseTo(2, 9);
  });

  it('left-edge drag keeps the right edge fixed', () => {
    const start = t({ x: 100, y: 100 });
    const r = resizeByHandle(start, 200, 100, 'w', { x: 50, y: 150 }, { keepAspect: false, crop: false });
    const b = itemBox(r, 200, 100);
    expect(r.x).toBeCloseTo(50, 9);
    expect(r.x + b.w).toBeCloseTo(300, 9);
    expect(r.scaleY).toBe(1);
  });

  it('alt-drag crops instead of scaling', () => {
    const start = t({ x: 0, y: 0, scaleX: 2, scaleY: 2 });
    const r = resizeByHandle(start, 100, 100, 'e', { x: 150, y: 100 }, { keepAspect: false, crop: true });
    expect(r.scaleX).toBe(2);
    expect(r.crop.right).toBe(25);
    expect(r.x).toBeCloseTo(0, 9);
    const l = resizeByHandle(start, 100, 100, 'w', { x: 40, y: 100 }, { keepAspect: false, crop: true });
    expect(l.crop.left).toBe(20);
    expect(l.x).toBeCloseTo(40, 9);
  });

  it('never inverts or collapses an item', () => {
    const r = resizeByHandle(t(), 100, 100, 'se', { x: -500, y: -500 }, { keepAspect: false, crop: false });
    expect(itemBox(r, 100, 100).w).toBeGreaterThan(0);
    expect(itemBox(r, 100, 100).h).toBeGreaterThan(0);
  });
});

describe('snapping', () => {
  it('snaps to canvas edges and centre', () => {
    expect(snapBounds({ x: 5, y: 300, w: 100, h: 100 }, 1920, 1080, [], 10)).toMatchObject({ dx: -5, dy: 0, guidesX: [0] });
    const c = snapBounds({ x: 906, y: 487, w: 100, h: 100 }, 1920, 1080, [], 10);
    expect(c.dx).toBe(4);
    expect(c.dy).toBe(3);
    expect(snapBounds({ x: 500, y: 500, w: 10, h: 10 }, 1920, 1080, [], 10)).toMatchObject({ dx: 0, dy: 0 });
  });
  it('snaps to other items', () => {
    expect(snapBounds({ x: 207, y: 600, w: 50, h: 50 }, 1920, 1080, [{ x: 100, y: 100, w: 100, h: 100 }], 10).dx).toBe(-7);
  });
});
