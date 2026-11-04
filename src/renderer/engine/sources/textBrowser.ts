import type { BrowserSourceFrame, Source, SourceOf } from '@shared/types';
import { cssColor } from '@shared/util';
import type { Gfx } from '../gl/compositor';
import type { TexInfo } from '../gl/glUtil';
import { drawStyledLine, fontString, textMargin, wrapText } from '../widgets/textUtil';
import { ElementTexture, type EngineServices, type SourceRuntime } from './base';

export class TextRuntime implements SourceRuntime {
  readonly type = 'text' as const;
  width = 0;
  height = 0;
  private canvas = new OffscreenCanvas(16, 16);
  private ctx: OffscreenCanvasRenderingContext2D;
  private et: ElementTexture;
  private version = 0;
  private s!: SourceOf<'text'>['settings'];
  private fileText = '';
  private fileTimer: number | null = null;
  private lastRendered = '';

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'text'>,
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.et = new ElementTexture(svc.gfx);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'text'>).settings;
    if (this.fileTimer) {
      clearInterval(this.fileTimer);
      this.fileTimer = null;
    }
    if (this.s.readFromFile && this.s.filePath) {
      const poll = () => {
        this.svc.api.files
          .readText(this.s.filePath)
          .then((t) => {
            this.fileText = t;
            this.svc.reportIssue(this.sourceId, null);
            this.render();
          })
          .catch((e: Error) => this.svc.reportIssue(this.sourceId, `Could not read the text file: ${e.message}`));
      };
      poll();
      this.fileTimer = window.setInterval(poll, 1000);
    }
    // Make sure a web/system font is ready before measuring.
    void document.fonts.load(fontString(this.s)).finally(() => {
      this.lastRendered = '';
      this.render();
    });
    this.render();
  }

  private render() {
    const s = this.s;
    const text = s.readFromFile ? this.fileText : s.text;
    const key = JSON.stringify([text, s]);
    if (key === this.lastRendered) return;
    this.lastRendered = key;
    const ctx = this.ctx;
    ctx.font = fontString(s);
    const margin = textMargin(s);
    const lines = wrapText(ctx, text || ' ', s.wrapWidth > 0 ? s.wrapWidth - s.padding * 2 - margin * 2 : 0);
    const lineH = Math.ceil(s.fontSize * Math.max(0.8, s.lineSpacing));
    const widths = lines.map((l) => ctx.measureText(l).width);
    const contentW = s.wrapWidth > 0 ? s.wrapWidth - s.padding * 2 - margin * 2 : Math.max(1, ...widths);
    const W = Math.max(1, Math.ceil(contentW + s.padding * 2 + margin * 2));
    const H = Math.max(1, Math.ceil(lines.length * lineH + s.padding * 2 + margin * 2 + s.fontSize * 0.25));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    if (s.backgroundOpacity > 0) {
      ctx.fillStyle = cssColor(s.backgroundColor, s.backgroundOpacity);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.font = fontString(s);
    ctx.textAlign = s.align;
    const x = s.align === 'left' ? s.padding + margin : s.align === 'right' ? W - s.padding - margin : W / 2;
    lines.forEach((l, i) => {
      const y = s.padding + margin + i * lineH + s.fontSize * 0.95;
      drawStyledLine(ctx, l, x, y, s);
    });
    this.width = W;
    this.height = H;
    this.version++;
  }

  texture(): TexInfo | null {
    return this.et.get(this.canvas, this.width, this.height, this.version);
  }

  destroy(): void {
    if (this.fileTimer) clearInterval(this.fileTimer);
    this.et.dispose();
  }
}

/** Web page rendered off-screen by the main process; frames arrive as BGRA dirty rectangles. */
export class BrowserRuntime implements SourceRuntime {
  readonly type = 'browser' as const;
  width = 0;
  height = 0;
  private tex: TexInfo | null = null;
  private pending: BrowserSourceFrame[] = [];
  private s!: SourceOf<'browser'>['settings'];
  private created = false;
  private audioStream: MediaStream | null = null;
  private audioNode: MediaStreamAudioSourceNode | null = null;
  private audioKey = '';
  private destroyed = false;

  constructor(
    readonly sourceId: string,
    private readonly svc: EngineServices,
    source: SourceOf<'browser'>,
  ) {
    this.update(source);
  }

  /** Called by the engine for every frame message addressed to this source. */
  onFrame(f: BrowserSourceFrame): void {
    // A full frame supersedes queued partial updates.
    if (f.x === 0 && f.y === 0 && f.w === f.width && f.h === f.height) this.pending = [f];
    else this.pending.push(f);
    if (this.pending.length > 30) this.pending.splice(0, this.pending.length - 30);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'browser'>).settings;
    this.width = Math.max(16, this.s.width);
    this.height = Math.max(16, this.s.height);
    const opts = { url: this.s.url, width: this.width, height: this.height, fps: this.s.fps, css: this.s.css, audible: this.s.captureAudio };
    const p = this.created ? this.svc.api.browserSources.update(this.sourceId, opts) : this.svc.api.browserSources.create(this.sourceId, opts);
    this.created = true;
    p.catch((e: Error) => this.svc.reportIssue(this.sourceId, e.message));
    const audioKey = `${this.s.captureAudio}`;
    if (audioKey !== this.audioKey) {
      this.audioKey = audioKey;
      void this.setupAudio();
    }
  }

  private async setupAudio() {
    this.audioNode?.disconnect();
    this.audioNode = null;
    this.audioStream?.getTracks().forEach((t) => t.stop());
    this.audioStream = null;
    if (!this.s.captureAudio) return;
    // Wait a moment for the page to exist in the main process.
    await new Promise((r) => setTimeout(r, 500));
    try {
      const id = await this.svc.api.browserSources.mediaSourceId(this.sourceId);
      if (!id || this.destroyed) return;
      const constraints = { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }, video: false } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.destroyed || !this.s.captureAudio) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.audioStream = stream;
      this.audioNode = this.svc.audio.ctx.createMediaStreamSource(stream);
      this.audioNode.connect(this.svc.audio.channel(this.sourceId).input);
    } catch (e) {
      this.svc.reportIssue(this.sourceId, `Page audio could not be captured (${(e as Error).message}). It plays on your speakers only.`);
    }
  }

  refresh(): void {
    void this.svc.api.browserSources.refresh(this.sourceId);
  }

  texture(g: Gfx): TexInfo | null {
    if (this.pending.length) {
      if (!this.tex) this.tex = g.newTexture();
      for (const f of this.pending) g.uploadBgra(this.tex, f.width, f.height, f.x, f.y, f.w, f.h, f.data);
      this.pending = [];
    }
    return this.tex;
  }

  destroy(): void {
    this.destroyed = true;
    this.audioNode?.disconnect();
    this.audioStream?.getTracks().forEach((t) => t.stop());
    void this.svc.api.browserSources.destroy(this.sourceId);
    this.svc.gfx.deleteTexture(this.tex);
    this.tex = null;
  }
}
