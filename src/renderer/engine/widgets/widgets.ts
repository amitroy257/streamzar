import type { AlertEvent, AlertType, AlertTypeConfig, ChatMessage, Source, SourceOf, SourceType, TextStyle } from '@shared/types';
import { alertTemplateValues } from '@shared/chatParsers';
import { ALERT_TYPE_LABELS } from '@shared/defaults';
import { cssColor, formatDuration, formatMoney } from '@shared/util';
import type { TexInfo } from '../gl/glUtil';
import { AnimatedImage } from '../sources/animatedImage';
import { ElementTexture, type EngineServices, type SourceRuntime } from '../sources/base';
import { drawRuns, drawStyledLine, fontString, roundRect, textMargin, wrapText, type StyledRun } from './textUtil';

abstract class CanvasWidget implements SourceRuntime {
  abstract readonly type: SourceType;
  width = 0;
  height = 0;
  protected canvas = new OffscreenCanvas(16, 16);
  protected ctx: OffscreenCanvasRenderingContext2D;
  protected et: ElementTexture;
  protected version = 0;
  protected active = false;

  constructor(
    readonly sourceId: string,
    protected readonly svc: EngineServices,
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.et = new ElementTexture(svc.gfx);
  }

  protected resize(w: number, h: number) {
    const W = Math.max(16, Math.round(w));
    const H = Math.max(16, Math.round(h));
    this.width = W;
    this.height = H;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  abstract update(source: Source): void;
  abstract tick(now: number, active: boolean): void;

  setActive(active: boolean): void {
    this.active = active;
  }

  texture(): TexInfo | null {
    return this.et.get(this.canvas, this.width, this.height, this.version);
  }

  destroy(): void {
    this.et.dispose();
  }
}

// ---------------------------------------------------------------------------
// Alert Box
// ---------------------------------------------------------------------------

function ease(t: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

function bounce(t: number) {
  const x = Math.min(1, Math.max(0, t));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

interface AlertMedia {
  path: string;
  image?: AnimatedImage;
  video?: HTMLVideoElement;
}

export class AlertBoxRuntime extends CanvasWidget {
  readonly type = 'alert_box' as const;
  private s!: SourceOf<'alert_box'>['settings'];
  private media = new Map<string, AlertMedia>();
  private shownId: string | null = null;
  private soundEl: HTMLAudioElement | null = null;
  private soundNode: MediaElementAudioSourceNode | null = null;

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'alert_box'>) {
    super(sourceId, svc);
    this.update(source);
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    this.soundEl = el;
    this.soundNode = svc.audio.ctx.createMediaElementSource(el);
    this.soundNode.connect(svc.audio.channel(sourceId).input);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'alert_box'>).settings;
    this.resize(this.s.width, this.s.height);
    this.version++;
  }

  private mediaFor(path: string): AlertMedia | null {
    if (!path) return null;
    let m = this.media.get(path);
    if (!m) {
      m = { path };
      const url = this.svc.api.files.mediaUrl(path);
      if (/\.(webm|mp4|mov|m4v)$/i.test(path)) {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = url;
        m.video = v;
      } else {
        m.image = new AnimatedImage(url);
      }
      this.media.set(path, m);
    }
    return m;
  }

  private accepts(type: AlertType): boolean {
    return !this.s.types.length || this.s.types.includes(type);
  }

  tick(now: number, active: boolean): void {
    const cur = this.svc.alerts.current;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    if (!cur || !this.accepts(cur.event.type)) {
      if (this.shownId !== null) {
        this.shownId = null;
        ctx.clearRect(0, 0, W, H);
        this.version++;
      }
      return;
    }
    const { event, config, start, durationMs } = cur;
    const media = this.mediaFor(config.imagePath);
    if (this.shownId !== event.id) {
      this.shownId = event.id;
      media?.image?.restart();
      if (media?.video) {
        media.video.currentTime = 0;
        void media.video.play().catch(() => undefined);
      }
      if (config.soundPath && active && this.soundEl && this.svc.alerts.claimSound(event.id, this.sourceId)) {
        this.soundEl.src = this.svc.api.files.mediaUrl(config.soundPath);
        this.soundEl.volume = Math.max(0, Math.min(1, config.soundVolume * this.svc.alerts.globalVolume));
        void this.soundEl.play().catch(() => undefined);
      }
    }
    const t = now - start;
    const inT = Math.min(1, t / 600);
    const outT = Math.min(1, Math.max(0, (t - (durationMs - 500)) / 500));
    let alpha = 1;
    let dy = 0;
    let sc = 1;
    switch (config.animationIn) {
      case 'fade':
        alpha *= ease(inT);
        break;
      case 'slide_down':
        dy -= (1 - ease(inT)) * H * 0.5;
        alpha *= Math.min(1, inT * 3);
        break;
      case 'slide_up':
        dy += (1 - ease(inT)) * H * 0.5;
        alpha *= Math.min(1, inT * 3);
        break;
      case 'zoom':
        sc *= 0.3 + 0.7 * ease(inT);
        alpha *= Math.min(1, inT * 2);
        break;
      case 'bounce':
        sc *= Math.max(0.01, bounce(inT));
        alpha *= Math.min(1, inT * 3);
        break;
    }
    switch (config.animationOut) {
      case 'fade':
        alpha *= 1 - outT;
        break;
      case 'slide_down':
        dy += ease(outT) * H * 0.5;
        alpha *= 1 - outT;
        break;
      case 'slide_up':
        dy -= ease(outT) * H * 0.5;
        alpha *= 1 - outT;
        break;
      case 'zoom':
        sc *= 1 - 0.7 * ease(outT);
        alpha *= 1 - outT;
        break;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(W / 2, H / 2 + dy);
    ctx.scale(sc, sc);
    ctx.translate(-W / 2, -H / 2);
    this.drawAlert(event, config, media, now);
    ctx.restore();
    this.version++;
  }

  private drawAlert(event: AlertEvent, config: AlertTypeConfig, media: AlertMedia | null, now: number) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const style: TextStyle = {
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      bold: true,
      italic: false,
      underline: false,
      color: config.textColor,
      outline: true,
      outlineColor: '#000000',
      outlineWidth: Math.max(2, Math.round(config.fontSize / 12)),
      shadow: true,
      shadowColor: '#000000',
      shadowBlur: 8,
      shadowOffset: 2,
      align: 'center',
    };
    // Media
    let mediaEl: CanvasImageSource | null = null;
    let mw = 0;
    let mh = 0;
    if (media?.image) {
      const f = media.image.frame(now);
      if (f) {
        mediaEl = f as CanvasImageSource;
        mw = media.image.width;
        mh = media.image.height;
      }
    } else if (media?.video && media.video.readyState >= 2) {
      mediaEl = media.video;
      mw = media.video.videoWidth;
      mh = media.video.videoHeight;
    }
    const message = renderAlertMessage(config.messageTemplate, event);
    const userMsg = config.showUserMessage && event.message ? event.message : '';
    const side = config.layout === 'side' && mediaEl;
    const textAreaW = side ? W * 0.55 : W * 0.95;
    ctx.font = fontString(style);
    const lines = wrapText(ctx, message, textAreaW);
    const lineH = style.fontSize * 1.2;
    const smallStyle: TextStyle = { ...style, fontSize: Math.round(style.fontSize * 0.55), bold: false, color: '#ffffff' };
    ctx.font = fontString(smallStyle);
    const userLines = userMsg ? wrapText(ctx, userMsg, textAreaW).slice(0, 4) : [];
    const smallH = smallStyle.fontSize * 1.25;
    const textH = lines.length * lineH + (userLines.length ? userLines.length * smallH + smallStyle.fontSize * 0.4 : 0);

    let imgBox = { x: 0, y: 0, w: 0, h: 0 };
    let textTop: number;
    let textCx: number;
    if (mediaEl && mw > 0 && mh > 0) {
      if (config.layout === 'text_over') {
        const s = Math.min(W / mw, H / mh);
        imgBox = { x: (W - mw * s) / 2, y: (H - mh * s) / 2, w: mw * s, h: mh * s };
        textTop = (H - textH) / 2;
        textCx = W / 2;
      } else if (side) {
        const s = Math.min((W * 0.4) / mw, H / mh);
        imgBox = { x: 0, y: (H - mh * s) / 2, w: mw * s, h: mh * s };
        textTop = (H - textH) / 2;
        textCx = imgBox.w + (W - imgBox.w) / 2;
      } else {
        const maxImgH = Math.max(H * 0.25, H - textH - 10);
        const s = Math.min(W / mw, maxImgH / mh);
        imgBox = { x: (W - mw * s) / 2, y: Math.max(0, (H - (mh * s + textH + 10)) / 2), w: mw * s, h: mh * s };
        textTop = imgBox.y + imgBox.h + 10;
        textCx = W / 2;
      }
      ctx.drawImage(mediaEl, imgBox.x, imgBox.y, imgBox.w, imgBox.h);
    } else {
      textTop = (H - textH) / 2;
      textCx = W / 2;
    }
    // Message: the {name} / {amount} values are highlighted
    ctx.font = fontString(style);
    lines.forEach((line, i) => {
      const y = textTop + i * lineH + style.fontSize;
      const runs = highlightRuns(line, [event.name, event.formattedAmount ?? ''], config.highlightColor);
      const width = runs.reduce((w, r) => w + ctx.measureText(r.text).width, 0);
      drawRuns(ctx, runs, textCx - width / 2, y, style);
    });
    if (userLines.length) {
      ctx.font = fontString(smallStyle);
      ctx.textAlign = 'center';
      userLines.forEach((l, i) => {
        const y = textTop + lines.length * lineH + smallStyle.fontSize * 0.4 + i * smallH + smallStyle.fontSize;
        drawStyledLine(ctx, l, textCx, y, smallStyle);
      });
    }
  }

  override destroy(): void {
    super.destroy();
    for (const m of this.media.values()) {
      m.image?.dispose();
      if (m.video) {
        m.video.pause();
        m.video.removeAttribute('src');
        m.video.load();
      }
    }
    this.soundEl?.pause();
    this.soundNode?.disconnect();
  }
}

export function renderAlertMessage(template: string, ev: AlertEvent): string {
  const v = alertTemplateValues(ev);
  return template
    .replace(/\{(\w+)\}/g, (m, k: string) => (v[k] === undefined ? m : String(v[k])))
    .replace(/\s+/g, ' ')
    .trim();
}

function highlightRuns(line: string, words: string[], color: string): StyledRun[] {
  const targets = words.filter((w) => w && w.length > 0);
  const runs: StyledRun[] = [];
  let rest = line;
  while (rest.length) {
    let best = -1;
    let word = '';
    for (const w of targets) {
      const i = rest.indexOf(w);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        word = w;
      }
    }
    if (best < 0) {
      runs.push({ text: rest });
      break;
    }
    if (best > 0) runs.push({ text: rest.slice(0, best) });
    runs.push({ text: word, color });
    rest = rest.slice(best + word.length);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Chat Box
// ---------------------------------------------------------------------------

const PLATFORM_COLORS: Record<string, string> = { twitch: '#9146ff', youtube: '#ff0033', facebook: '#1877f2', system: '#8b95a7' };
const PLATFORM_LETTER: Record<string, string> = { twitch: 'T', youtube: 'Y', facebook: 'f', system: '•' };

export class ChatBoxRuntime extends CanvasWidget {
  readonly type = 'chat_box' as const;
  private s!: SourceOf<'chat_box'>['settings'];
  private lastVersion = -1;
  private emoteCache = new Map<string, AnimatedImage>();
  private lastFadeCheck = 0;

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'chat_box'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'chat_box'>).settings;
    this.resize(this.s.width, this.s.height);
    this.lastVersion = -1;
  }

  private emote(url: string): AnimatedImage {
    let e = this.emoteCache.get(url);
    if (!e) {
      e = new AnimatedImage(this.svc.api.files.remoteUrl(url), () => {
        this.lastVersion = -1;
      });
      this.emoteCache.set(url, e);
      if (this.emoteCache.size > 300) {
        const first = this.emoteCache.keys().next().value as string;
        this.emoteCache.get(first)?.dispose();
        this.emoteCache.delete(first);
      }
    }
    return e;
  }

  tick(now: number): void {
    const feed = this.svc.chat;
    const needsFade = this.s.hideAfterSec > 0 && now - this.lastFadeCheck > 250;
    if (feed.version === this.lastVersion && !needsFade) return;
    this.lastFadeCheck = now;
    this.lastVersion = feed.version;
    this.draw(feed.messages, Date.now());
  }

  private draw(all: ChatMessage[], wallNow: number) {
    const s = this.s;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);
    if (s.backgroundOpacity > 0) {
      ctx.fillStyle = cssColor(s.backgroundColor, s.backgroundOpacity);
      ctx.fillRect(0, 0, W, H);
    }
    const pad = 10;
    const fs = s.fontSize;
    const lineH = Math.round(fs * 1.3);
    const msgs = all.filter((m) => m.platform !== 'system' && (s.hideAfterSec <= 0 || wallNow - m.time < s.hideAfterSec * 1000 + 1000)).slice(-s.maxMessages);
    let y = H - pad;
    const margin = textMargin(s);
    for (let i = msgs.length - 1; i >= 0 && y > 0; i--) {
      const m = msgs[i];
      const age = wallNow - m.time;
      const fade = s.hideAfterSec > 0 ? Math.max(0, Math.min(1, (s.hideAfterSec * 1000 + 1000 - age) / 1000)) : 1;
      // Layout: [icon] Name: text (wrapping), emotes inline.
      ctx.font = fontString(s, fs, true);
      const iconW = s.showPlatformIcon ? fs * 1.1 : 0;
      const nameText = `${m.author}${m.isAction ? ' ' : ': '}`;
      const nameW = ctx.measureText(nameText).width;
      ctx.font = fontString(s);
      const avail = W - pad * 2 - margin * 2;
      const tokens = tokenize(m);
      // Measure lines
      const lines: { kind: 'text' | 'emote'; value: string; w: number }[][] = [[]];
      let lineW = iconW + nameW;
      for (const tk of tokens) {
        const w = tk.kind === 'emote' ? fs * 1.2 : ctx.measureText(tk.value).width;
        if (lineW + w > avail && lines[lines.length - 1].length) {
          lines.push([]);
          lineW = 0;
          if (tk.kind === 'text' && !tk.value.trim()) continue;
        }
        lines[lines.length - 1].push({ ...tk, w });
        lineW += w;
      }
      const blockH = lines.length * lineH + 8;
      y -= blockH;
      ctx.save();
      ctx.globalAlpha = fade;
      if (s.messageBackground) {
        ctx.fillStyle = m.highlight ? 'rgba(49,195,162,0.30)' : 'rgba(0,0,0,0.45)';
        roundRect(ctx, pad - 4, y, W - pad * 2 + 8, blockH - 4, 8);
        ctx.fill();
      }
      let cx = pad + margin;
      let cy = y + 4 + fs;
      if (s.showPlatformIcon) {
        ctx.fillStyle = PLATFORM_COLORS[m.platform] ?? '#888';
        ctx.beginPath();
        ctx.arc(cx + fs * 0.45, cy - fs * 0.35, fs * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = fontString({ ...s, fontFamily: 'Arial' }, fs * 0.6, true);
        ctx.textAlign = 'center';
        ctx.fillText(PLATFORM_LETTER[m.platform] ?? '?', cx + fs * 0.45, cy - fs * 0.35 + fs * 0.22);
        cx += iconW;
      }
      ctx.font = fontString(s, fs, true);
      ctx.textAlign = 'left';
      drawStyledLine(ctx, nameText, cx, cy, s, m.authorColor || nameColor(m.author));
      cx += nameW;
      ctx.font = fontString(s);
      lines.forEach((line, li) => {
        if (li > 0) {
          cx = pad + margin;
          cy += lineH;
        }
        for (const tk of line) {
          if (tk.kind === 'emote') {
            const img = this.emote(tk.value);
            const f = img.frame(performance.now());
            if (f) ctx.drawImage(f as CanvasImageSource, cx, cy - fs, fs * 1.15, fs * 1.15);
          } else {
            drawStyledLine(ctx, tk.value, cx, cy, s, m.isAction ? m.authorColor || s.color : s.color);
          }
          cx += tk.w;
        }
      });
      ctx.restore();
      y -= 4;
    }
    this.version++;
    // keep animated emotes moving
    if ([...this.emoteCache.values()].some((e) => e.animated)) this.lastVersion = -1;
  }

  override destroy(): void {
    super.destroy();
    for (const e of this.emoteCache.values()) e.dispose();
  }
}

function tokenize(m: ChatMessage): { kind: 'text' | 'emote'; value: string }[] {
  const chars = Array.from(m.text);
  const out: { kind: 'text' | 'emote'; value: string }[] = [];
  let i = 0;
  const pushText = (t: string) => {
    for (const part of t.split(/(\s+)/)) if (part) out.push({ kind: 'text', value: part });
  };
  for (const e of m.emotes) {
    if (e.start < i) continue;
    pushText(chars.slice(i, e.start).join(''));
    out.push({ kind: 'emote', value: e.url });
    i = e.end + 1;
  }
  pushText(chars.slice(i).join(''));
  return out;
}

function nameColor(name: string): string {
  const palette = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#f06595'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

// ---------------------------------------------------------------------------
// Event List
// ---------------------------------------------------------------------------

const EVENT_ICONS: Record<AlertType, string> = {
  follow: '♥',
  subscription: '★',
  gift_sub: '🎁',
  donation: '$',
  bits: '◆',
  raid: '⚑',
  superchat: '$',
  membership: '★',
  stars: '✦',
};

export function eventLine(e: AlertEvent): string {
  switch (e.type) {
    case 'follow':
      return 'followed';
    case 'subscription':
      return e.months ? `subscribed (${e.months} months)` : 'subscribed';
    case 'gift_sub':
      return `gifted ${e.count ?? 1} sub${(e.count ?? 1) === 1 ? '' : 's'}`;
    case 'donation':
      return `donated ${e.formattedAmount ?? ''}`.trim();
    case 'bits':
      return `cheered ${e.formattedAmount ?? ''}`.trim();
    case 'raid':
      return `raided with ${e.count ?? 0}`;
    case 'superchat':
      return `Super Chat ${e.formattedAmount ?? ''}`.trim();
    case 'membership':
      return 'became a member';
    case 'stars':
      return `sent ${e.formattedAmount ?? 'Stars'}`;
  }
  return ALERT_TYPE_LABELS[e.type];
}

export class EventListRuntime extends CanvasWidget {
  readonly type = 'event_list' as const;
  private s!: SourceOf<'event_list'>['settings'];
  private lastKey = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'event_list'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'event_list'>).settings;
    this.resize(this.s.width, this.s.height);
    this.lastKey = '';
  }

  tick(): void {
    const s = this.s;
    const events = this.svc.alerts.history.filter((e) => !s.types.length || s.types.includes(e.type)).slice(0, Math.max(1, s.maxEvents));
    const key = events.map((e) => e.id).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);
    const rowH = Math.round(s.fontSize * 1.8);
    events.forEach((e, i) => {
      const y = 6 + i * (rowH + 6);
      if (y + rowH > H) return;
      ctx.fillStyle = cssColor(s.backgroundColor, s.backgroundOpacity);
      roundRect(ctx, 4, y, W - 8, rowH, 8);
      ctx.fill();
      ctx.font = fontString(s, s.fontSize, true);
      ctx.textAlign = 'left';
      const cy = y + rowH / 2 + s.fontSize * 0.35;
      drawStyledLine(ctx, EVENT_ICONS[e.type] ?? '•', 14, cy, s, '#31c3a2');
      const nameX = 14 + s.fontSize * 1.4;
      drawStyledLine(ctx, e.name, nameX, cy, s);
      const nw = ctx.measureText(`${e.name} `).width;
      ctx.font = fontString(s, s.fontSize * 0.85, false);
      drawStyledLine(ctx, eventLine(e), nameX + nw, cy, { ...s, fontSize: s.fontSize * 0.85 }, '#c9cfdb');
    });
    this.version++;
  }
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export class GoalRuntime extends CanvasWidget {
  readonly type = 'goal' as const;
  private s!: SourceOf<'goal'>['settings'];
  private shown = -1;
  private lastKey = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'goal'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'goal'>).settings;
    this.resize(this.s.width, this.s.height);
    this.lastKey = '';
  }

  tick(): void {
    const s = this.s;
    const target = Math.max(1, s.target);
    const frac = Math.max(0, Math.min(1, s.current / target));
    if (this.shown < 0) this.shown = frac;
    // animate the bar towards the new value
    this.shown += (frac - this.shown) * 0.12;
    if (Math.abs(frac - this.shown) < 0.001) this.shown = frac;
    const key = JSON.stringify([s, this.shown]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);
    const titleH = s.fontSize * 1.3;
    ctx.font = fontString(s);
    ctx.textAlign = 'left';
    drawStyledLine(ctx, s.title, 6, s.fontSize, s);
    const money = s.goalType === 'donation' || s.goalType === 'superchat';
    const fmt = (v: number) => (money ? formatMoney(v, s.currency) : String(Math.round(v)));
    const right = `${fmt(s.current)} / ${fmt(target)}`;
    ctx.textAlign = 'right';
    drawStyledLine(ctx, right, W - 6, s.fontSize, s);
    const barY = titleH + 6;
    const barH = Math.max(12, H - barY - 6);
    ctx.fillStyle = s.barBackground;
    roundRect(ctx, 4, barY, W - 8, barH, barH / 2);
    ctx.fill();
    if (this.shown > 0) {
      ctx.fillStyle = s.barColor;
      roundRect(ctx, 4, barY, Math.max(barH, (W - 8) * this.shown), barH, barH / 2);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    const pct = `${Math.round(frac * 100)}%`;
    drawStyledLine(ctx, pct, W / 2, barY + barH / 2 + s.fontSize * 0.35, { ...s, outline: true, outlineColor: '#000000', outlineWidth: 3 });
    this.version++;
  }
}

// ---------------------------------------------------------------------------
// Countdown / stopwatch / clock / uptime
// ---------------------------------------------------------------------------

export class CountdownRuntime extends CanvasWidget {
  readonly type = 'countdown' as const;
  private s!: SourceOf<'countdown'>['settings'];
  private activatedAt = performance.now();
  private lastText = '';
  private lastKey = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'countdown'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'countdown'>).settings;
    this.lastKey = '';
    this.lastText = '';
    this.tick(performance.now());
  }

  override setActive(active: boolean): void {
    if (active && !this.active) this.activatedAt = performance.now();
    super.setActive(active);
  }

  /** Restart from the full duration (context menu). */
  control(): void {
    this.activatedAt = performance.now();
  }

  private fmt(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    if (this.s.format === 'hh:mm:ss' || (this.s.format === 'auto' && h > 0)) return `${p(h)}:${p(m)}:${p(sec)}`;
    return `${p(m + h * 60)}:${p(sec)}`;
  }

  private text(now: number): string {
    const s = this.s;
    switch (s.mode) {
      case 'clock': {
        const d = new Date();
        return s.prefix + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !s.clock24h });
      }
      case 'stopwatch':
        return s.prefix + formatDuration(now - this.activatedAt);
      case 'stream_uptime': {
        const started = this.svc.streamStartedAt();
        return s.prefix + (started ? formatDuration(Date.now() - started) : '00:00:00');
      }
      case 'countdown':
      default: {
        let remaining: number;
        const target = s.targetTime ? Date.parse(s.targetTime) : NaN;
        if (Number.isFinite(target)) remaining = target - Date.now();
        else remaining = s.durationSec * 1000 - (now - this.activatedAt);
        if (remaining <= 0 && s.endText) return s.endText;
        return s.prefix + this.fmt(remaining);
      }
    }
  }

  tick(now: number): void {
    const s = this.s;
    const text = this.text(now);
    const key = JSON.stringify(s);
    if (text === this.lastText && key === this.lastKey) return;
    this.lastText = text;
    this.lastKey = key;
    const ctx = this.ctx;
    ctx.font = fontString(s);
    const margin = textMargin(s);
    // Use the widest digit so the box does not jitter while counting.
    const sample = text.replace(/\d/g, '0');
    const tw = Math.max(ctx.measureText(sample).width, ctx.measureText(text).width);
    this.resize(tw + margin * 2 + 16, s.fontSize * 1.3 + margin * 2);
    ctx.clearRect(0, 0, this.width, this.height);
    if (s.backgroundOpacity > 0) {
      ctx.fillStyle = cssColor(s.backgroundColor, s.backgroundOpacity);
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.font = fontString(s);
    ctx.textAlign = 'center';
    drawStyledLine(ctx, text, this.width / 2, margin + s.fontSize, s);
    this.version++;
  }
}

// ---------------------------------------------------------------------------
// Stream Label
// ---------------------------------------------------------------------------

export class StreamLabelRuntime extends CanvasWidget {
  readonly type = 'stream_label' as const;
  private s!: SourceOf<'stream_label'>['settings'];
  private lastKey = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'stream_label'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'stream_label'>).settings;
    this.lastKey = '';
    this.tick();
  }

  tick(): void {
    const s = this.s;
    const text = this.svc.stats.label(s.kind, s.template, s.emptyText, this.svc.chat.viewers);
    const key = JSON.stringify([text, s]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const ctx = this.ctx;
    ctx.font = fontString(s);
    const margin = textMargin(s);
    const tw = ctx.measureText(text || ' ').width;
    this.resize(tw + margin * 2 + 12, s.fontSize * 1.3 + margin * 2);
    ctx.clearRect(0, 0, this.width, this.height);
    if (s.backgroundOpacity > 0) {
      ctx.fillStyle = cssColor(s.backgroundColor, s.backgroundOpacity);
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.font = fontString(s);
    ctx.textAlign = 'left';
    drawStyledLine(ctx, text, margin + 6, margin + s.fontSize, s);
    this.version++;
  }
}
