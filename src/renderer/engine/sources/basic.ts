import type { Source, SourceOf } from '@shared/types';
import { hexToRgba } from '@shared/util';
import type { TexInfo } from '../gl/glUtil';
import { AnimatedImage } from './animatedImage';
import { ElementTexture, VideoFrameTracker, type EngineServices, type SourceRuntime } from './base';

export class ColorRuntime implements SourceRuntime {
  readonly type = 'color' as const;
  width = 0;
  height = 0;
  private tex: TexInfo | null = null;
  private color = '';

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'color'>,
  ) {
    this.update(source);
  }

  update(source: Source): void {
    const s = (source as SourceOf<'color'>).settings;
    this.width = Math.max(1, s.width);
    this.height = Math.max(1, s.height);
    if (s.color !== this.color) {
      this.color = s.color;
      if (!this.tex) this.tex = this.svc.gfx.newTexture();
      this.svc.gfx.uploadSolid(this.tex, hexToRgba(s.color));
    }
  }

  texture(): TexInfo | null {
    return this.tex;
  }

  destroy(): void {
    this.svc.gfx.deleteTexture(this.tex);
    this.tex = null;
  }
}

export class ImageRuntime implements SourceRuntime {
  readonly type = 'image' as const;
  width = 0;
  height = 0;
  private img: AnimatedImage | null = null;
  private path = '';
  private et: ElementTexture;
  private now = performance.now();

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'image'>,
  ) {
    this.et = new ElementTexture(svc.gfx);
    this.update(source);
  }

  update(source: Source): void {
    const s = (source as SourceOf<'image'>).settings;
    if (s.path === this.path) return;
    this.path = s.path;
    this.img?.dispose();
    this.img = null;
    this.et.reset();
    this.width = this.height = 0;
    if (!s.path) return;
    const img = new AnimatedImage(this.svc.api.files.mediaUrl(s.path), () => {
      if (this.img !== img) return;
      this.width = img.width;
      this.height = img.height;
      this.svc.reportIssue(this.sourceId, img.error);
    });
    this.img = img;
  }

  tick(now: number): void {
    this.now = now;
  }

  texture(): TexInfo | null {
    const img = this.img;
    if (!img) return null;
    const el = img.frame(this.now);
    return this.et.get(el, img.width, img.height, img.version);
  }

  setActive(active: boolean): void {
    if (active) this.img?.restart();
  }

  destroy(): void {
    this.img?.dispose();
    this.et.dispose();
  }
}

/** Cycles through images with a cut or cross-fade, drawn on a 2D canvas at the configured size. */
export class SlideshowRuntime implements SourceRuntime {
  readonly type = 'slideshow' as const;
  width = 0;
  height = 0;
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private images = new Map<string, AnimatedImage>();
  private order: string[] = [];
  private index = 0;
  private slideStart = performance.now();
  private s!: SourceOf<'slideshow'>['settings'];
  private et: ElementTexture;
  private version = 0;

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'slideshow'>,
  ) {
    this.canvas = new OffscreenCanvas(16, 16);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.et = new ElementTexture(svc.gfx);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'slideshow'>).settings;
    this.width = Math.max(16, this.s.width);
    this.height = Math.max(16, this.s.height);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const wanted = new Set(this.s.paths);
    for (const [p, img] of this.images) {
      if (!wanted.has(p)) {
        img.dispose();
        this.images.delete(p);
      }
    }
    for (const p of this.s.paths) if (!this.images.has(p)) this.images.set(p, new AnimatedImage(this.svc.api.files.mediaUrl(p)));
    this.order = [...this.s.paths];
    if (this.s.shuffle) this.order.sort(() => Math.random() - 0.5);
    this.index = Math.min(this.index, Math.max(0, this.order.length - 1));
    this.version++;
  }

  setActive(active: boolean): void {
    if (active) this.slideStart = performance.now();
  }

  private drawImageFit(src: TexImageSource, w: number, h: number, alpha: number) {
    const W = this.width;
    const H = this.height;
    const s = Math.min(W / w, H / h);
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(src as CanvasImageSource, (W - w * s) / 2, (H - h * s) / 2, w * s, h * s);
    this.ctx.globalAlpha = 1;
  }

  tick(now: number): void {
    if (!this.order.length) return;
    const interval = Math.max(500, this.s.intervalMs);
    let elapsed = now - this.slideStart;
    if (elapsed >= interval) {
      if (this.index < this.order.length - 1 || this.s.loop) {
        this.index = (this.index + 1) % this.order.length;
        this.slideStart = now;
        elapsed = 0;
      }
    }
    const cur = this.images.get(this.order[this.index]);
    const prevIdx = (this.index - 1 + this.order.length) % this.order.length;
    const prev = this.images.get(this.order[prevIdx]);
    const fadeMs = this.s.transition === 'fade' ? Math.max(0, this.s.transitionMs) : 0;
    const t = fadeMs > 0 ? Math.min(1, elapsed / fadeMs) : 1;
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (t < 1 && prev && prev !== cur) {
      const pf = prev.frame(now);
      if (pf) this.drawImageFit(pf, prev.width, prev.height, 1 - t);
    }
    const cf = cur?.frame(now);
    if (cur && cf) this.drawImageFit(cf, cur.width, cur.height, t);
    this.version++;
  }

  texture(): TexInfo | null {
    return this.et.get(this.canvas, this.width, this.height, this.version);
  }

  destroy(): void {
    for (const img of this.images.values()) img.dispose();
    this.images.clear();
    this.et.dispose();
  }
}

/** Video / audio file playback. Audio goes through the mixer. */
export class MediaRuntime implements SourceRuntime {
  readonly type = 'media' as const;
  width = 0;
  height = 0;
  readonly video: HTMLVideoElement;
  private et: ElementTexture;
  private frames: VideoFrameTracker;
  private now = performance.now();
  private path = '';
  private s!: SourceOf<'media'>['settings'];
  private active = false;
  private audioNode: MediaElementAudioSourceNode;
  private ended = false;

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'media'>,
  ) {
    this.et = new ElementTexture(svc.gfx);
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
      this.svc.reportIssue(this.sourceId, null);
    });
    v.addEventListener('error', () => {
      if (v.getAttribute('src')) this.svc.reportIssue(this.sourceId, 'This media file could not be played. Use MP4 (H.264/AAC), WebM, MP3 or WAV.');
    });
    v.addEventListener('ended', () => {
      this.ended = true;
    });
    v.addEventListener('seeked', () => this.frames.bump());
    v.addEventListener('loadeddata', () => this.frames.bump());
    this.video = v;
    this.audioNode = svc.audio.ctx.createMediaElementSource(v);
    this.audioNode.connect(svc.audio.channel(sourceId).input);
    this.frames = new VideoFrameTracker(v);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'media'>).settings;
    this.video.loop = this.s.loop;
    this.video.playbackRate = Math.max(0.25, Math.min(4, this.s.speedPercent / 100));
    if (this.s.path !== this.path) {
      this.path = this.s.path;
      this.width = this.height = 0;
      this.et.reset();
      if (this.path) {
        this.video.src = this.svc.api.files.mediaUrl(this.path);
        this.video.load();
        if (this.active) void this.video.play().catch(() => undefined);
      } else {
        this.video.removeAttribute('src');
        this.video.load();
      }
    }
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!this.path) return;
    if (active) {
      if (this.s.restartOnActivate || this.ended) this.video.currentTime = 0;
      this.ended = false;
      void this.video.play().catch(() => undefined);
    } else if (this.s.restartOnActivate) {
      this.video.pause();
    }
  }

  control(action: 'play' | 'pause' | 'restart' | 'stop'): void {
    const v = this.video;
    if (action === 'play') void v.play().catch(() => undefined);
    else if (action === 'pause') v.pause();
    else if (action === 'restart') {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
      v.currentTime = 0;
    }
  }

  tick(now: number): void {
    this.now = now;
  }

  texture(): TexInfo | null {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return this.et.info;
    return this.et.get(v, v.videoWidth, v.videoHeight, this.frames.poll(this.now));
  }

  destroy(): void {
    this.frames.stop();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.audioNode.disconnect();
    this.et.dispose();
  }
}

export class SceneRuntime implements SourceRuntime {
  readonly type = 'scene' as const;
  width: number;
  height: number;
  sceneId: string;

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'scene'>,
  ) {
    const b = svc.baseSize();
    this.width = b.width;
    this.height = b.height;
    this.sceneId = source.settings.sceneId;
  }

  update(source: Source): void {
    this.sceneId = (source as SourceOf<'scene'>).settings.sceneId;
    const b = this.svc.baseSize();
    this.width = b.width;
    this.height = b.height;
  }

  texture(): TexInfo | null {
    return null; // rendered by the compositor
  }

  destroy(): void {
    /* nothing */
  }
}
