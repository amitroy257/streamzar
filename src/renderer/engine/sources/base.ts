import type { Source, SourceType } from '@shared/types';
import type { StreamzarApi } from '@shared/ipc';
import type { Gfx } from '../gl/compositor';
import type { TexInfo } from '../gl/glUtil';
import type { AudioEngine } from '../audio/audioEngine';
import type { AlertManager, ChatFeed, SessionStats } from '../live';

export interface EngineServices {
  api: StreamzarApi;
  gfx: Gfx;
  audio: AudioEngine;
  alerts: AlertManager;
  chat: ChatFeed;
  stats: SessionStats;
  baseSize(): { width: number; height: number };
  streamStartedAt(): number | null;
  /** Report a user-facing problem with a source (shown in the UI). */
  reportIssue(sourceId: string, message: string | null): void;
  /** Patch a source's settings without creating an undo step (e.g. goal progress). */
  patchSourceSettings(sourceId: string, patch: Record<string, unknown>): void;
}

export interface SourceRuntime {
  readonly sourceId: string;
  readonly type: SourceType;
  /** Natural size in canvas pixels (0 while unknown). */
  width: number;
  height: number;
  /** Nested scene id (scene sources only). */
  sceneId?: string;
  /** Settings changed. */
  update(source: Source): void;
  /** Called every rendered frame. `active` = visible in the program output. */
  tick?(now: number, active: boolean): void;
  /** Current content as a texture (uploads lazily). */
  texture(g: Gfx): TexInfo | null;
  /** Visible in program changed. */
  setActive?(active: boolean): void;
  /** Media controls (media sources). */
  control?(action: 'play' | 'pause' | 'restart' | 'stop'): void;
  /** Re-open the underlying device (capture sources), e.g. after hardware was plugged in. */
  reload?(): void;
  destroy(): void;
}

/** Texture fed from a DOM element/canvas. Tracks a version so uploads only happen on change. */
export class ElementTexture {
  info: TexInfo | null = null;
  private uploaded = -1;

  constructor(private readonly gfx: Gfx) {}

  /** Upload `el` if `version` changed. Returns the texture or null if nothing to show. */
  get(el: TexImageSource | null, width: number, height: number, version: number): TexInfo | null {
    if (!el || width <= 0 || height <= 0) return this.info && this.uploaded >= 0 ? this.info : null;
    if (!this.info) this.info = this.gfx.newTexture();
    if (version !== this.uploaded || this.info.width !== width || this.info.height !== height) {
      try {
        this.gfx.uploadElement(this.info, el, width, height);
        this.uploaded = version;
      } catch {
        // e.g. video not ready yet / tainted: keep last frame
        return this.uploaded >= 0 ? this.info : null;
      }
    }
    return this.info;
  }

  reset(): void {
    this.uploaded = -1;
  }

  dispose(): void {
    this.gfx.deleteTexture(this.info);
    this.info = null;
    this.uploaded = -1;
  }
}

/**
 * Tracks new frames of a <video> element so textures are only re-uploaded when needed.
 * Uses requestVideoFrameCallback when it is firing; otherwise (e.g. the element is not composited)
 * treats every tick of a playing video as a new frame.
 */
export class VideoFrameTracker {
  private rvfcVersion = 0;
  private lastCallback = 0;
  private fallbackVersion = 0;
  private handle = 0;
  private stopped = false;

  constructor(private readonly video: HTMLVideoElement) {
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) {
      const loop = () => {
        if (this.stopped) return;
        this.rvfcVersion++;
        this.lastCallback = performance.now();
        this.handle = v.requestVideoFrameCallback!(loop);
      };
      this.handle = v.requestVideoFrameCallback(loop);
    }
  }

  /** Call once per tick; returns a version that changes whenever a new frame may be available. */
  poll(now: number): number {
    const v = this.video;
    if (now - this.lastCallback >= 1000 && !v.paused && v.readyState >= 2) this.fallbackVersion++;
    return this.rvfcVersion + this.fallbackVersion * 1_000_000;
  }

  /** Force a re-upload (e.g. after seeking while paused). */
  bump(): void {
    this.fallbackVersion++;
  }

  stop(): void {
    this.stopped = true;
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    v.cancelVideoFrameCallback?.(this.handle);
  }
}
