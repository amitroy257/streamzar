import { BrowserWindow, session, type WebContents } from 'electron';
import type { BrowserSourceFrame, BrowserSourceOptions } from '../shared/types';
import { log } from './logger';

const PARTITION = 'persist:streamzar-browser-sources';

interface Entry {
  win: BrowserWindow;
  opts: BrowserSourceOptions;
  cssKey: string | null;
}

/**
 * Browser sources are rendered in hidden off-screen windows (with transparency) and their pixels are
 * streamed to the compositor. They run in their own session partition without access to the app
 * protocol or any privileged API.
 */
export class BrowserSourceManager {
  private entries = new Map<string, Entry>();
  private configured = false;

  constructor(private readonly getTarget: () => WebContents | null) {}

  private configureSession() {
    if (this.configured) return;
    this.configured = true;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));
    ses.setPermissionCheckHandler(() => false);
  }

  private sanitizeUrl(url: string): string {
    const u = url.trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^file:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return `https://${u}`;
    return 'about:blank';
  }

  async create(id: string, opts: BrowserSourceOptions): Promise<void> {
    if (this.entries.has(id)) return this.update(id, opts);
    this.configureSession();
    const width = Math.max(16, Math.min(3840, Math.round(opts.width)));
    const height = Math.max(16, Math.min(2160, Math.round(opts.height)));
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: true,
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const entry: Entry = { win, opts: { ...opts, width, height }, cssKey: null };
    this.entries.set(id, entry);
    const wc = win.webContents;
    wc.setFrameRate(Math.max(1, Math.min(60, Math.round(opts.fps) || 30)));
    wc.setAudioMuted(!opts.audible);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('dom-ready', () => void this.applyCss(id));
    wc.on('did-fail-load', (_e, code, desc, url) => {
      if (code !== -3) log('warn', `browser source failed to load ${url}: ${desc} (${code})`);
    });
    wc.on('render-process-gone', (_e, details) => {
      log('warn', `browser source renderer gone (${details.reason}), reloading`);
      setTimeout(() => {
        if (this.entries.get(id) === entry && !win.isDestroyed()) wc.reload();
      }, 2000);
    });
    wc.on('paint', (_e, dirty, image) => {
      const target = this.getTarget();
      if (!target || target.isDestroyed()) return;
      const size = image.getSize();
      if (!size.width || !size.height) return;
      const scaled = size.width !== entry.opts.width || size.height !== entry.opts.height;
      let x = 0;
      let y = 0;
      let w = size.width;
      let h = size.height;
      let data: Buffer;
      if (!scaled && dirty.width > 0 && dirty.height > 0 && (dirty.width < size.width || dirty.height < size.height)) {
        x = Math.max(0, Math.floor(dirty.x));
        y = Math.max(0, Math.floor(dirty.y));
        w = Math.min(size.width - x, Math.ceil(dirty.width));
        h = Math.min(size.height - y, Math.ceil(dirty.height));
        data = image.crop({ x, y, width: w, height: h }).toBitmap();
      } else {
        data = image.toBitmap();
      }
      if (data.length !== w * h * 4) {
        // Unexpected stride: fall back to a full frame.
        x = 0;
        y = 0;
        w = size.width;
        h = size.height;
        data = image.toBitmap();
        if (data.length !== w * h * 4) return;
      }
      const frame: BrowserSourceFrame = { id, width: size.width, height: size.height, x, y, w, h, data };
      target.send('browser-source:frame', frame);
    });
    await this.load(entry);
  }

  private async load(entry: Entry) {
    try {
      await entry.win.webContents.loadURL(this.sanitizeUrl(entry.opts.url));
    } catch (e) {
      log('warn', `browser source load error: ${(e as Error).message}`);
    }
  }

  private async applyCss(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.win.isDestroyed()) return;
    const wc = entry.win.webContents;
    if (entry.cssKey) {
      try {
        await wc.removeInsertedCSS(entry.cssKey);
      } catch {
        /* page navigated */
      }
      entry.cssKey = null;
    }
    if (entry.opts.css.trim()) {
      try {
        entry.cssKey = await wc.insertCSS(entry.opts.css);
      } catch {
        /* ignore */
      }
    }
  }

  async update(id: string, opts: BrowserSourceOptions): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return this.create(id, opts);
    const prev = entry.opts;
    const width = Math.max(16, Math.min(3840, Math.round(opts.width)));
    const height = Math.max(16, Math.min(2160, Math.round(opts.height)));
    entry.opts = { ...opts, width, height };
    const wc = entry.win.webContents;
    if (prev.width !== width || prev.height !== height) entry.win.setContentSize(width, height);
    if (prev.fps !== opts.fps) wc.setFrameRate(Math.max(1, Math.min(60, Math.round(opts.fps) || 30)));
    wc.setAudioMuted(!opts.audible);
    if (prev.url !== opts.url) await this.load(entry);
    else if (prev.css !== opts.css) await this.applyCss(id);
    else if (prev.width !== width || prev.height !== height) wc.invalidate();
  }

  async refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry && !entry.win.isDestroyed()) entry.win.webContents.reloadIgnoringCache();
  }

  /** Media source id that lets the main window capture this page's audio. */
  mediaSourceId(id: string, requester: WebContents): string | null {
    const entry = this.entries.get(id);
    if (!entry || entry.win.isDestroyed()) return null;
    try {
      return entry.win.webContents.getMediaSourceId(requester);
    } catch {
      return null;
    }
  }

  interact(id: string, ev: { type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel'; x: number; y: number; deltaY?: number }): void {
    const entry = this.entries.get(id);
    if (!entry || entry.win.isDestroyed()) return;
    const wc = entry.win.webContents;
    const x = Math.round(ev.x);
    const y = Math.round(ev.y);
    if (ev.type === 'mouseWheel') wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -(ev.deltaY ?? 0), canScroll: true });
    else if (ev.type === 'mouseMove') wc.sendInputEvent({ type: 'mouseMove', x, y });
    else wc.sendInputEvent({ type: ev.type, x, y, button: 'left', clickCount: 1 });
  }

  destroy(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  destroyAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }
}
