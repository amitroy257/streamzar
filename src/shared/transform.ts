// Geometry for scene items. Canvas space: pixels, origin top-left, y down. Rotation is clockwise in
// degrees around the centre of the item's (scaled, cropped) box.

import type { Crop, Transform } from './types';

export interface Pt {
  x: number;
  y: number;
}

export interface ItemBox {
  /** Cropped source size (texture pixels shown) */
  cw: number;
  ch: number;
  /** Size on the canvas */
  w: number;
  h: number;
}

export function itemBox(t: Transform, natW: number, natH: number): ItemBox {
  const cw = Math.max(0, natW - t.crop.left - t.crop.right);
  const ch = Math.max(0, natH - t.crop.top - t.crop.bottom);
  return { cw, ch, w: cw * Math.abs(t.scaleX), h: ch * Math.abs(t.scaleY) };
}

export function itemCenter(t: Transform, natW: number, natH: number): Pt {
  const b = itemBox(t, natW, natH);
  return { x: t.x + b.w / 2, y: t.y + b.h / 2 };
}

function rot(p: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Map a point in the item's local box space (0..w, 0..h, unrotated) to canvas space. */
export function localToCanvas(t: Transform, natW: number, natH: number, p: Pt): Pt {
  const b = itemBox(t, natW, natH);
  const r = rot({ x: p.x - b.w / 2, y: p.y - b.h / 2 }, t.rotation);
  return { x: r.x + t.x + b.w / 2, y: r.y + t.y + b.h / 2 };
}

/** Map a canvas point to the item's local box space. */
export function canvasToLocal(t: Transform, natW: number, natH: number, p: Pt): Pt {
  const b = itemBox(t, natW, natH);
  const c = { x: t.x + b.w / 2, y: t.y + b.h / 2 };
  const r = rot({ x: p.x - c.x, y: p.y - c.y }, -t.rotation);
  return { x: r.x + b.w / 2, y: r.y + b.h / 2 };
}

/** Corners in canvas space: top-left, top-right, bottom-right, bottom-left. */
export function itemCorners(t: Transform, natW: number, natH: number): [Pt, Pt, Pt, Pt] {
  const b = itemBox(t, natW, natH);
  return [
    localToCanvas(t, natW, natH, { x: 0, y: 0 }),
    localToCanvas(t, natW, natH, { x: b.w, y: 0 }),
    localToCanvas(t, natW, natH, { x: b.w, y: b.h }),
    localToCanvas(t, natW, natH, { x: 0, y: b.h }),
  ];
}

export function hitTest(t: Transform, natW: number, natH: number, p: Pt, slop = 0): boolean {
  const b = itemBox(t, natW, natH);
  const l = canvasToLocal(t, natW, natH, p);
  return l.x >= -slop && l.y >= -slop && l.x <= b.w + slop && l.y <= b.h + slop;
}

/** Axis-aligned bounds of the (possibly rotated) item. */
export function itemBounds(t: Transform, natW: number, natH: number): { x: number; y: number; w: number; h: number } {
  const c = itemCorners(t, natW, natH);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Texture coordinates (u0, v0, u1, v1) for the cropped & flipped source. */
export function itemUv(t: Transform, natW: number, natH: number): [number, number, number, number] {
  if (natW <= 0 || natH <= 0) return [0, 0, 1, 1];
  let u0 = t.crop.left / natW;
  let u1 = 1 - t.crop.right / natW;
  let v0 = t.crop.top / natH;
  let v1 = 1 - t.crop.bottom / natH;
  if (t.flipH) [u0, u1] = [u1, u0];
  if (t.flipV) [v0, v1] = [v1, v0];
  return [u0, v0, u1, v1];
}

export type FitMode = 'fit' | 'stretch' | 'fill' | 'center' | 'reset';

/** Transform presets for the context menu (Fit to screen, Stretch, Center...). */
export function fitTransform(t: Transform, natW: number, natH: number, canvasW: number, canvasH: number, mode: FitMode): Transform {
  const crop: Crop = mode === 'reset' ? { left: 0, top: 0, right: 0, bottom: 0 } : t.crop;
  const base: Transform = { ...t, crop, rotation: mode === 'reset' ? 0 : t.rotation };
  const { cw, ch } = itemBox(base, natW, natH);
  if (cw <= 0 || ch <= 0) return base;
  switch (mode) {
    case 'reset':
      return { ...base, x: 0, y: 0, scaleX: 1, scaleY: 1, flipH: false, flipV: false };
    case 'stretch':
      return { ...base, x: 0, y: 0, scaleX: canvasW / cw, scaleY: canvasH / ch, rotation: 0 };
    case 'fit': {
      const s = Math.min(canvasW / cw, canvasH / ch);
      return { ...base, scaleX: s, scaleY: s, x: (canvasW - cw * s) / 2, y: (canvasH - ch * s) / 2, rotation: 0 };
    }
    case 'fill': {
      const s = Math.max(canvasW / cw, canvasH / ch);
      return { ...base, scaleX: s, scaleY: s, x: (canvasW - cw * s) / 2, y: (canvasH - ch * s) / 2, rotation: 0 };
    }
    case 'center': {
      const b = itemBox(base, natW, natH);
      return { ...base, x: (canvasW - b.w) / 2, y: (canvasH - b.h) / 2 };
    }
  }
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Resize an item by dragging one of its handles to `pointer` (canvas space).
 * The opposite edge/corner stays fixed. With keepAspect the scale ratio is preserved (corner handles).
 * With crop=true the drag crops the source instead of scaling (Alt-drag like OBS).
 */
export function resizeByHandle(
  start: Transform,
  natW: number,
  natH: number,
  handle: Handle,
  pointer: Pt,
  opts: { keepAspect: boolean; crop: boolean },
): Transform {
  const b0 = itemBox(start, natW, natH);
  const local = canvasToLocal(start, natW, natH, pointer);
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');
  // New box edges in the start item's local space
  let left = 0;
  let top = 0;
  let right = b0.w;
  let bottom = b0.h;
  if (hasW) left = Math.min(local.x, right - 1);
  if (hasE) right = Math.max(local.x, left + 1);
  if (hasN) top = Math.min(local.y, bottom - 1);
  if (hasS) bottom = Math.max(local.y, top + 1);

  const sx0 = Math.abs(start.scaleX) || 1;
  const sy0 = Math.abs(start.scaleY) || 1;

  if (opts.crop) {
    // Convert the moved edges into crop amounts (source pixels), clamped so something stays visible.
    const crop = { ...start.crop };
    const maxCropX = natW - 1;
    const maxCropY = natH - 1;
    const dl = left / sx0;
    const dr = (b0.w - right) / sx0;
    const dt = top / sy0;
    const db = (b0.h - bottom) / sy0;
    // Flipped items crop the opposite side of the source.
    const lKey = start.flipH ? 'right' : 'left';
    const rKey = start.flipH ? 'left' : 'right';
    const tKey = start.flipV ? 'bottom' : 'top';
    const bKey = start.flipV ? 'top' : 'bottom';
    if (hasW) crop[lKey] = clampCrop(start.crop[lKey] + dl, maxCropX - crop[rKey]);
    if (hasE) crop[rKey] = clampCrop(start.crop[rKey] + dr, maxCropX - crop[lKey]);
    if (hasN) crop[tKey] = clampCrop(start.crop[tKey] + dt, maxCropY - crop[bKey]);
    if (hasS) crop[bKey] = clampCrop(start.crop[bKey] + db, maxCropY - crop[tKey]);
    const t1: Transform = { ...start, crop };
    const b1 = itemBox(t1, natW, natH);
    // Keep the opposite (non-dragged) edges fixed: new top-left in the start item's local space.
    const anchorLocal = { x: hasW ? b0.w - b1.w : 0, y: hasN ? b0.h - b1.h : 0 };
    return placeBox(start, natW, natH, t1, anchorLocal, b1.w, b1.h);
  }

  let newW = right - left;
  let newH = bottom - top;
  if (opts.keepAspect && b0.w > 0 && b0.h > 0) {
    const corner = (hasW || hasE) && (hasN || hasS);
    const ratio = b0.w / b0.h;
    if (corner) {
      if (newW / newH > ratio) newH = newW / ratio;
      else newW = newH * ratio;
    } else if (hasW || hasE) {
      newH = newW / ratio;
    } else {
      newW = newH * ratio;
    }
    if (hasW) left = right - newW;
    else right = left + newW;
    if (hasN) top = bottom - newH;
    else if (hasS) bottom = top + newH;
    else {
      // side handle E/W with aspect: grow symmetrically around the vertical centre
      const cy = b0.h / 2;
      top = cy - newH / 2;
      bottom = cy + newH / 2;
    }
    if (!(hasW || hasE)) {
      const cx = b0.w / 2;
      left = cx - newW / 2;
      right = cx + newW / 2;
    }
  }
  const sxSign = Math.sign(start.scaleX) || 1;
  const sySign = Math.sign(start.scaleY) || 1;
  const t1: Transform = {
    ...start,
    scaleX: b0.cw > 0 ? (newW / b0.cw) * sxSign : start.scaleX,
    scaleY: b0.ch > 0 ? (newH / b0.ch) * sySign : start.scaleY,
  };
  return placeBox(start, natW, natH, t1, { x: left, y: top }, newW, newH);
}

function clampCrop(v: number, max: number): number {
  return Math.round(Math.max(0, Math.min(max, v)));
}

/**
 * Position `next` so that its box (size w x h) has its top-left at `anchorLocal`, expressed in the
 * local (unrotated) space of `start`. Rotation is preserved.
 */
function placeBox(start: Transform, natW: number, natH: number, next: Transform, anchorLocal: Pt, w: number, h: number): Transform {
  // centre of the new box in start-local space -> canvas
  const centerCanvas = localToCanvas(start, natW, natH, { x: anchorLocal.x + w / 2, y: anchorLocal.y + h / 2 });
  return { ...next, x: centerCanvas.x - w / 2, y: centerCanvas.y - h / 2 };
}

export interface SnapResult {
  dx: number;
  dy: number;
  guidesX: number[];
  guidesY: number[];
}

/**
 * Snap a moving box (axis-aligned bounds) to canvas edges, canvas centre and other items' edges.
 * Returns the correction to apply.
 */
export function snapBounds(
  box: { x: number; y: number; w: number; h: number },
  canvasW: number,
  canvasH: number,
  others: { x: number; y: number; w: number; h: number }[],
  distance: number,
): SnapResult {
  const xs = [0, canvasW / 2, canvasW];
  const ys = [0, canvasH / 2, canvasH];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const candX = [box.x, box.x + box.w / 2, box.x + box.w];
  const candY = [box.y, box.y + box.h / 2, box.y + box.h];
  let best = { d: distance + 1, delta: 0, line: 0 };
  for (const c of candX) for (const t of xs) if (Math.abs(t - c) < best.d) best = { d: Math.abs(t - c), delta: t - c, line: t };
  let bestY = { d: distance + 1, delta: 0, line: 0 };
  for (const c of candY) for (const t of ys) if (Math.abs(t - c) < bestY.d) bestY = { d: Math.abs(t - c), delta: t - c, line: t };
  const res: SnapResult = { dx: 0, dy: 0, guidesX: [], guidesY: [] };
  if (best.d <= distance) {
    res.dx = best.delta;
    res.guidesX.push(best.line);
  }
  if (bestY.d <= distance) {
    res.dy = bestY.delta;
    res.guidesY.push(bestY.line);
  }
  return res;
}
