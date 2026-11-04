import type { AppSettings, CaptureRequest, Scene, SceneCollection, Source, TransitionSettings } from '@shared/types';
import type { StreamzarApi } from '@shared/ipc';
import { normalizeOutputSize } from '@shared/util';
import { AudioEngine } from './audio/audioEngine';
import { CaptureSession } from './capture';
import { Compositor, type RenderWorld, type SourceRuntimeLike, type TransitionState } from './gl/compositor';
import type { TexInfo } from './gl/glUtil';
import { ElementTexture, VideoFrameTracker, type EngineServices, type SourceRuntime } from './sources/base';
import { createRuntime } from './sources/factory';
import { AlertManager, ChatFeed, SessionStats } from './live';
import TickWorker from './tickWorker.ts?worker';

export interface EngineHooks {
  patchSourceSettings(sourceId: string, patch: Record<string, unknown>): void;
  onIssues(issues: Record<string, string>): void;
  onTransitionEnd?(): void;
}

export interface EngineStats {
  renderFps: number;
  renderMs: number;
  framesSent: number;
  framesSkipped: number;
  capturing: boolean;
}

/** Plays a stinger transition video and exposes it as a texture. */
class StingerPlayer implements SourceRuntimeLike {
  width = 0;
  height = 0;
  readonly video: HTMLVideoElement;
  private et: ElementTexture;
  private frames: VideoFrameTracker;
  private node: MediaElementAudioSourceNode;
  private gain: GainNode;
  private path = '';
  private now = 0;

  constructor(
    private readonly engine: Engine,
    audio: AudioEngine,
  ) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
    });
    this.video = v;
    this.et = new ElementTexture(engine.compositor.gfx);
    this.frames = new VideoFrameTracker(v);
    this.node = audio.ctx.createMediaElementSource(v);
    this.gain = audio.ctx.createGain();
    this.node.connect(this.gain);
    this.gain.connect(audio.master);
  }

  load(s: TransitionSettings) {
    if (s.stingerPath !== this.path) {
      this.path = s.stingerPath;
      if (this.path) {
        this.video.src = this.engine.api.files.mediaUrl(this.path);
        this.video.load();
      } else {
        this.video.removeAttribute('src');
      }
    }
    this.gain.gain.value = Math.max(0, Math.min(1, s.stingerVolume));
  }

  get durationMs(): number {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d * 1000 : 0;
  }

  play() {
    this.video.currentTime = 0;
    void this.video.play().catch(() => undefined);
  }

  tick(now: number) {
    this.now = now;
  }

  texture(): TexInfo | null {
    const v = this.video;
    if (v.paused || v.ended || !v.videoWidth || v.readyState < 2) return null;
    return this.et.get(v, v.videoWidth, v.videoHeight, this.frames.poll(this.now));
  }
}

/**
 * Show a frame in a bitmaprenderer canvas. The canvas' intrinsic size must match the bitmap,
 * otherwise CSS object-fit uses the default 300x150 and the picture gets stretched.
 */
function present(ctx: ImageBitmapRenderingContext, bitmap: ImageBitmap) {
  const c = ctx.canvas as HTMLCanvasElement | OffscreenCanvas;
  if (c.width !== bitmap.width || c.height !== bitmap.height) {
    c.width = bitmap.width;
    c.height = bitmap.height;
  }
  ctx.transferFromImageBitmap(bitmap);
}

export class Engine {
  readonly compositor: Compositor;
  readonly audio: AudioEngine;
  readonly alerts = new AlertManager();
  readonly chat = new ChatFeed();
  readonly stats = new SessionStats();
  private runtimes = new Map<string, SourceRuntime>();
  private sourceJson = new Map<string, string>();
  private collection: SceneCollection | null = null;
  private settings: AppSettings;
  private programSceneId = '';
  private transition: TransitionState | null = null;
  private studio = false;
  private previewSceneId: string | null = null;
  private activeSet = new Set<string>();
  private worker: Worker;
  private workerFps = 0;
  private displays: { program: ImageBitmapRenderingContext | null; preview: ImageBitmapRenderingContext | null } = { program: null, preview: null };
  private projectors = new Set<ImageBitmapRenderingContext>();
  private capture: CaptureSession | null = null;
  private captureGeneration = 0;
  private issues: Record<string, string> = {};
  private stinger: StingerPlayer;
  private svc: EngineServices;
  private frameTimes: number[] = [];
  private lastRenderMs = 0;
  private streamStarted: number | null = null;
  private lastDisplayAt = 0;
  private displayCostMs = 0;
  private lastTickAt = 0;
  captureError: string | null = null;

  constructor(
    readonly api: StreamzarApi,
    settings: AppSettings,
    private readonly hooks: EngineHooks,
  ) {
    this.settings = settings;
    this.compositor = new Compositor(settings.video.baseWidth, settings.video.baseHeight);
    this.audio = new AudioEngine(settings.audio.sampleRate);
    this.alerts.setSettings(settings.alerts);
    void this.audio.setMonitoringDevice(settings.audio.monitoringDeviceId);
    this.svc = {
      api,
      gfx: this.compositor.gfx,
      audio: this.audio,
      alerts: this.alerts,
      chat: this.chat,
      stats: this.stats,
      baseSize: () => ({ width: this.compositor.baseW, height: this.compositor.baseH }),
      streamStartedAt: () => this.streamStarted,
      reportIssue: (id, msg) => this.setIssue(id, msg),
      patchSourceSettings: (id, patch) => hooks.patchSourceSettings(id, patch),
    };
    this.stinger = new StingerPlayer(this, this.audio);
    this.alerts.onEvent((ev) => {
      this.stats.record(ev);
      this.updateGoals(ev);
    });
    this.worker = new TickWorker();
    // The worker only paces the loop: its performance.now() has a different time origin than the
    // page, so every timestamp used for rendering / A-V sync comes from the page clock.
    this.worker.onmessage = () => this.tick(performance.now());
    this.startClock(settings.video.fpsNum / settings.video.fpsDen);
  }

  get services(): EngineServices {
    return this.svc;
  }

  private startClock(fps: number) {
    if (Math.abs(fps - this.workerFps) < 0.001) return;
    this.workerFps = fps;
    this.worker.postMessage({ cmd: 'start', fps });
  }

  // ---------------------------------------------------------------------------
  // State sync
  // ---------------------------------------------------------------------------

  setSettings(s: AppSettings): void {
    const prev = this.settings;
    this.settings = s;
    if (s.video.baseWidth !== this.compositor.baseW || s.video.baseHeight !== this.compositor.baseH) {
      this.compositor.resizeBase(s.video.baseWidth, s.video.baseHeight);
      for (const [id, rt] of this.runtimes) {
        const src = this.collection?.sources.find((x) => x.id === id);
        if (src && src.type === 'scene') rt.update(src);
      }
    }
    if (!this.capture) this.startClock(s.video.fpsNum / s.video.fpsDen);
    this.alerts.setSettings(s.alerts);
    if (prev.audio.monitoringDeviceId !== s.audio.monitoringDeviceId) void this.audio.setMonitoringDevice(s.audio.monitoringDeviceId);
  }

  setStreamStartedAt(t: number | null): void {
    this.streamStarted = t;
  }

  setCollection(c: SceneCollection): void {
    const prev = this.collection;
    const switchedCollection = !prev || prev.id !== c.id;
    this.collection = c;
    if (switchedCollection) {
      for (const id of [...this.runtimes.keys()]) this.destroyRuntime(id);
      this.transition = null;
      this.programSceneId = c.activeSceneId;
    }
    // Create / update / destroy runtimes
    const live = new Set<string>();
    for (const src of c.sources) {
      live.add(src.id);
      const json = JSON.stringify(src.settings);
      const rt = this.runtimes.get(src.id);
      if (!rt) {
        try {
          this.runtimes.set(src.id, createRuntime(src, this.svc));
        } catch (e) {
          this.setIssue(src.id, (e as Error).message);
        }
        this.sourceJson.set(src.id, json);
      } else if (this.sourceJson.get(src.id) !== json) {
        this.sourceJson.set(src.id, json);
        try {
          rt.update(src);
        } catch (e) {
          this.setIssue(src.id, (e as Error).message);
        }
      }
      if (this.audio.hasChannel(src.id) || src.type === 'audio_input' || src.type === 'audio_output' || src.type === 'media' || src.type === 'browser' || src.type === 'alert_box') {
        this.audio.channel(src.id).update(src.audio);
      }
    }
    for (const id of [...this.runtimes.keys()]) if (!live.has(id)) this.destroyRuntime(id);
    for (const id of Object.keys(this.issues)) if (!live.has(id)) this.setIssue(id, null);
    this.compositor.gc(live);
    this.stinger.load(c.transition);

    // Scene switch → transition
    if (!c.scenes.some((s) => s.id === this.programSceneId)) this.programSceneId = c.activeSceneId;
    if (c.activeSceneId !== this.programSceneId) this.beginTransition(this.programSceneId, c.activeSceneId, c.transition);
    if (this.previewSceneId && !c.scenes.some((s) => s.id === this.previewSceneId)) this.previewSceneId = c.activeSceneId;
  }

  setStudio(enabled: boolean, previewSceneId: string | null): void {
    this.studio = enabled;
    this.previewSceneId = previewSceneId;
  }

  private destroyRuntime(id: string) {
    const rt = this.runtimes.get(id);
    if (rt) {
      try {
        rt.destroy();
      } catch (e) {
        console.warn('destroy failed', e);
      }
    }
    this.runtimes.delete(id);
    this.sourceJson.delete(id);
    this.audio.removeChannel(id);
  }

  private beginTransition(from: string, to: string, s: TransitionSettings) {
    // Finish any running transition first.
    const realFrom = this.transition ? this.transition.to : from;
    this.transition = null;
    this.programSceneId = to;
    if (s.type === 'cut' || realFrom === to) {
      this.hooks.onTransitionEnd?.();
      return;
    }
    let durationMs = Math.max(50, s.durationMs);
    if (s.type === 'stinger') {
      if (!s.stingerPath || !this.stinger.durationMs) {
        // No stinger video available: fall back to a cut.
        this.hooks.onTransitionEnd?.();
        return;
      }
      durationMs = this.stinger.durationMs;
      this.stinger.play();
    }
    this.transition = { from: realFrom, to, start: performance.now(), settings: { ...s }, durationMs, stinger: s.type === 'stinger' ? this.stinger : null };
  }

  get transitioning(): boolean {
    return !!this.transition;
  }

  private setIssue(id: string, msg: string | null) {
    if (msg) {
      if (this.issues[id] === msg) return;
      this.issues = { ...this.issues, [id]: msg };
    } else {
      if (!(id in this.issues)) return;
      const next = { ...this.issues };
      delete next[id];
      this.issues = next;
    }
    this.hooks.onIssues(this.issues);
  }

  private updateGoals(ev: import('@shared/types').AlertEvent) {
    const c = this.collection;
    if (!c) return;
    for (const src of c.sources) {
      if (src.type !== 'goal') continue;
      const g = src.settings;
      let delta = 0;
      switch (g.goalType) {
        case 'follower':
          if (ev.type === 'follow') delta = 1;
          break;
        case 'subscriber':
          if (ev.type === 'subscription' || ev.type === 'membership') delta = 1;
          else if (ev.type === 'gift_sub') delta = ev.count ?? 1;
          break;
        case 'donation':
          if (ev.type === 'donation' || ev.type === 'superchat' || ev.type === 'stars') delta = ev.amount ?? 0;
          break;
        case 'superchat':
          if (ev.type === 'superchat') delta = ev.amount ?? 0;
          break;
        case 'bits':
          if (ev.type === 'bits') delta = ev.amount ?? 0;
          break;
      }
      if (delta > 0) this.hooks.patchSourceSettings(src.id, { current: Math.round((g.current + delta) * 100) / 100 });
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  runtime(id: string): SourceRuntime | undefined {
    return this.runtimes.get(id);
  }

  sourceSize(id: string): { width: number; height: number } {
    const rt = this.runtimes.get(id);
    if (!rt) return { width: 0, height: 0 };
    return { width: rt.width, height: rt.height };
  }

  isActive(sourceId: string): boolean {
    return this.activeSet.has(sourceId);
  }

  get programScene(): string {
    return this.programSceneId;
  }

  engineStats(): EngineStats {
    const n = this.frameTimes.length;
    const fps = n > 1 ? ((n - 1) * 1000) / (this.frameTimes[n - 1] - this.frameTimes[0]) : 0;
    return {
      renderFps: Math.round(fps * 10) / 10,
      renderMs: Math.round(this.lastRenderMs * 10) / 10,
      framesSent: this.capture?.stats.framesSent ?? 0,
      framesSkipped: this.capture?.stats.framesSkipped ?? 0,
      capturing: !!this.capture,
    };
  }

  // ---------------------------------------------------------------------------
  // Displays
  // ---------------------------------------------------------------------------

  attachDisplay(kind: 'program' | 'preview', canvas: HTMLCanvasElement | null): void {
    this.displays[kind] = canvas ? (canvas.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null) : null;
  }

  attachProjector(canvas: HTMLCanvasElement): () => void {
    const ctx = canvas.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null;
    if (!ctx) return () => undefined;
    this.projectors.add(ctx);
    return () => this.projectors.delete(ctx);
  }

  // ---------------------------------------------------------------------------
  // Capture (driven by the main process)
  // ---------------------------------------------------------------------------

  async handleCaptureRequest(req: CaptureRequest): Promise<void> {
    const gen = ++this.captureGeneration;
    this.capture?.stop();
    this.capture = null;
    if (!req.active) {
      this.startClock(this.settings.video.fpsNum / this.settings.video.fpsDen);
      return;
    }
    const size = normalizeOutputSize(req.width, req.height);
    const session = new CaptureSession(this.api, this.compositor, this.audio, { ...req, ...size }, this.settings.video.scaleFilter);
    try {
      await session.start();
      if (gen !== this.captureGeneration) {
        session.stop();
        return;
      }
      this.capture = session;
      this.captureError = null;
      this.startClock(req.fpsNum / req.fpsDen);
    } catch (e) {
      session.stop();
      this.captureError = (e as Error).message;
      this.api.system.log('error', `capture start failed: ${this.captureError}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private computeActive(): Set<string> {
    const set = new Set<string>();
    const c = this.collection;
    if (!c) return set;
    const scenes = new Map<string, Scene>(c.scenes.map((s) => [s.id, s]));
    const sources = new Map<string, Source>(c.sources.map((s) => [s.id, s]));
    const visit = (sceneId: string, depth: number) => {
      const sc = scenes.get(sceneId);
      if (!sc || depth > 8) return;
      for (const it of sc.items) {
        if (!it.visible || set.has(it.sourceId)) continue;
        set.add(it.sourceId);
        const src = sources.get(it.sourceId);
        if (src?.type === 'scene') visit(src.settings.sceneId, depth + 1);
      }
    };
    visit(this.programSceneId, 0);
    if (this.transition) visit(this.transition.from, 0);
    return set;
  }

  private tick(now: number) {
    const c = this.collection;
    if (!c || this.compositor.contextLost) return;
    // If the page was busy, several clock messages arrive back-to-back: render once, not N times.
    if (now - this.lastTickAt < 500 / this.workerFps) return;
    this.lastTickAt = now;
    const t0 = performance.now();
    this.alerts.tick(now);
    this.stinger.tick(now);

    const active = this.computeActive();
    const global = new Set(c.globalAudioSourceIds);
    for (const [id, rt] of this.runtimes) {
      const isActive = active.has(id);
      if (isActive !== this.activeSet.has(id)) {
        try {
          rt.setActive?.(isActive);
        } catch (e) {
          console.warn(e);
        }
      }
      try {
        rt.tick?.(now, isActive);
      } catch (e) {
        console.warn(e);
      }
      if (this.audio.hasChannel(id)) this.audio.channel(id).setActive(isActive || global.has(id));
    }
    this.activeSet = active;

    const sceneMap = new Map(c.scenes.map((s) => [s.id, s]));
    const sourceMap = new Map(c.sources.map((s) => [s.id, s]));
    const world: RenderWorld = {
      getScene: (id) => sceneMap.get(id),
      getSource: (id) => sourceMap.get(id),
      getRuntime: (id) => this.runtimes.get(id),
      mediaUrl: (p) => this.api.files.mediaUrl(p),
      now,
    };
    const still = this.compositor.renderProgram(this.programSceneId, world, this.transition);
    if (this.transition && !still) {
      this.transition = null;
      this.hooks.onTransitionEnd?.();
    }
    if (this.studio && this.previewSceneId) this.compositor.renderPreview(this.previewSceneId, world);
    this.capture?.onFrameRendered(now);

    // Update the on-screen views (skipped while the window is hidden; output is unaffected).
    // When the GPU falls behind on output readbacks, the stream/recording wins over the preview.
    const visible = typeof document !== 'undefined' && !document.hidden;
    // The preview refresh rate also adapts to how expensive it is (software rendering, 4K canvases).
    const gpuBusy = !!this.capture && this.compositor.pendingReads >= 2;
    const minInterval = Math.max(gpuBusy ? 100 : 1000 / 61, this.displayCostMs * 3);
    if ((visible || this.projectors.size) && now - this.lastDisplayAt > minInterval) {
      this.lastDisplayAt = now;
      const d0 = performance.now();
      if (visible && this.displays.program) present(this.displays.program, this.compositor.snapshot(this.compositor.program));
      if (visible && this.studio && this.displays.preview) present(this.displays.preview, this.compositor.snapshot(this.compositor.preview));
      for (const p of this.projectors) {
        try {
          present(p, this.compositor.snapshot(this.compositor.program));
        } catch {
          this.projectors.delete(p);
        }
      }
      this.displayCostMs = this.displayCostMs * 0.9 + (performance.now() - d0) * 0.1;
    }
    this.lastRenderMs = performance.now() - t0;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  async screenshot(): Promise<string> {
    const png = await this.compositor.programPng();
    return this.api.files.saveScreenshot(png);
  }

  dispose(): void {
    this.worker.terminate();
    this.capture?.stop();
    for (const id of [...this.runtimes.keys()]) this.destroyRuntime(id);
    this.audio.dispose();
  }
}
