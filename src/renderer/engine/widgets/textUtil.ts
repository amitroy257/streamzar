import type { TextStyle } from '@shared/types';
import { cssColor } from '@shared/util';

export type Ctx2D = OffscreenCanvasRenderingContext2D;

export function fontString(s: Pick<TextStyle, 'fontFamily' | 'fontSize' | 'bold' | 'italic'>, size = s.fontSize, boldOverride?: boolean): string {
  const fam = s.fontFamily.replace(/["\\]/g, '');
  return `${s.italic ? 'italic ' : ''}${boldOverride ?? s.bold ? 'bold ' : ''}${Math.max(1, Math.round(size))}px "${fam}", "Segoe UI", Arial, sans-serif`;
}

/** Word-wrap text to maxWidth (0 = no wrapping). Long words are broken by character. */
export function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!maxWidth || maxWidth <= 0) {
      out.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width <= maxWidth || !line.trim()) {
        if (ctx.measureText(test).width > maxWidth && !line.trim()) {
          // single very long word: hard-break it
          let chunk = '';
          for (const ch of Array.from(w)) {
            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = test;
        }
      } else {
        out.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface StyledRun {
  text: string;
  color?: string;
  bold?: boolean;
}

/** Draw a single line with outline / shadow / underline as configured in the style. */
export function drawStyledLine(ctx: Ctx2D, line: string, x: number, y: number, s: TextStyle, color = s.color): void {
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  if (s.shadow) {
    ctx.shadowColor = cssColor(s.shadowColor, 0.9);
    ctx.shadowBlur = s.shadowBlur;
    ctx.shadowOffsetX = s.shadowOffset;
    ctx.shadowOffsetY = s.shadowOffset;
  }
  if (s.outline && s.outlineWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = s.outlineWidth * 2;
    ctx.strokeStyle = s.outlineColor;
    ctx.strokeText(line, x, y);
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = color;
  ctx.fillText(line, x, y);
  if (s.underline) {
    const w = ctx.measureText(line).width;
    const align = ctx.textAlign;
    const x0 = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
    const t = Math.max(1, s.fontSize / 16);
    ctx.fillRect(x0, y + t * 2, w, t);
  }
  ctx.restore();
}

/** Draw runs of differently coloured text on one line starting at x (left aligned). Returns end x. */
export function drawRuns(ctx: Ctx2D, runs: StyledRun[], x: number, y: number, s: TextStyle): number {
  let cx = x;
  const base = ctx.font;
  for (const r of runs) {
    if (r.bold !== undefined) ctx.font = fontString(s, s.fontSize, r.bold);
    ctx.textAlign = 'left';
    drawStyledLine(ctx, r.text, cx, y, s, r.color ?? s.color);
    cx += ctx.measureText(r.text).width;
    ctx.font = base;
  }
  return cx;
}

export function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Extra space needed around glyphs for outline & shadow. */
export function textMargin(s: TextStyle): number {
  return Math.ceil((s.outline ? s.outlineWidth : 0) + (s.shadow ? s.shadowBlur + Math.abs(s.shadowOffset) : 0)) + 2;
}
