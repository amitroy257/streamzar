import type { Source, SourceOf } from '@shared/types';
import type { TexInfo } from '../gl/glUtil';
import { ElementTexture, VideoFrameTracker, type EngineServices, type SourceRuntime } from './base';

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}

function describeMediaError(e: unknown, what: string): string {
  const err = e as DOMException;
  switch (err?.name) {
    case 'NotAllowedError':
      return `Access to the ${what} was denied. Allow Streamzar in your system privacy settings.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `The ${what} was not found. Is it connected?`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${what} is busy or could not be opened (another app may be using it).`;
    default:
      return `Could not open the ${what}: ${err?.message ?? String(e)}`;
  }
}

/** Shared logic for sources backed by a MediaStream video track. */
abstract class StreamVideoRuntime implements SourceRuntime {
  abstract readonly type: Source['type'];
  width = 0;
  height = 0;
  protected stream: MediaStream | null = null;
  protected video: HTMLVideoElement;
  private et: ElementTexture;
  private frames: VideoFrameTracker;
  private now = performance.now();
  protected opening = 0;
  private retryTimer: number | null = null;
  protected destroyed = false;

  constructor(
    readonly sourceId: string,
    protected readonly svc: EngineServices,
  ) {
    this.et = new ElementTexture(svc.gfx);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.addEventListener('resize', () => {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
    });
    v.addEventListener('loadedmetadata', () => {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
    });
    this.video = v;
    this.frames = new VideoFrameTracker(v);
  }

  abstract update(source: Source): void;
  protected abstract acquire(): Promise<MediaStream>;
  protected abstract what: string;

  /** (Re)open the capture. Concurrent calls are de-duplicated with a generation counter. */
  protected async open(): Promise<void> {
    const gen = ++this.opening;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    stopStream(this.stream);
    this.stream = null;
    try {
      const stream = await this.acquire();
      if (gen !== this.opening || this.destroyed) {
        stopStream(stream);
        return;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (gen !== this.opening || this.destroyed) return;
        this.svc.reportIssue(this.sourceId, `The ${this.what} stopped. Retrying…`);
        this.scheduleRetry();
      });
      this.video.srcObject = stream;
      await this.video.play().catch(() => undefined);
      this.svc.reportIssue(this.sourceId, null);
    } catch (e) {
      if (gen !== this.opening || this.destroyed) return;
      const msg = e instanceof Error && !(e instanceof DOMException) ? e.message : describeMediaError(e, this.what);
      this.svc.reportIssue(this.sourceId, msg);
      this.scheduleRetry();
    }
  }

  protected scheduleRetry(ms = 5000): void {
    if (this.destroyed || this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, ms);
  }

  reload(): void {
    void this.open();
  }

  tick(now: number): void {
    this.now = now;
  }

  texture(): TexInfo | null {
    const v = this.video;
    if (!this.stream || !v.videoWidth || v.readyState < 2) return this.et.info;
    return this.et.get(v, v.videoWidth, v.videoHeight, this.frames.poll(this.now));
  }

  destroy(): void {
    this.destroyed = true;
    this.opening++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.frames.stop();
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.et.dispose();
  }
}

export class VideoCaptureRuntime extends StreamVideoRuntime {
  readonly type = 'video_capture' as const;
  protected what = 'camera';
  private s!: SourceOf<'video_capture'>['settings'];
  private key = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'video_capture'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'video_capture'>).settings;
    const key = JSON.stringify([this.s.deviceId, this.s.width, this.s.height, this.s.fps]);
    if (key === this.key) return;
    this.key = key;
    void this.open();
  }

  protected async acquire(): Promise<MediaStream> {
    const s = this.s;
    const video: MediaTrackConstraints = {
      width: { ideal: s.width },
      height: { ideal: s.height },
      frameRate: { ideal: s.fps },
    };
    if (s.deviceId) video.deviceId = { exact: s.deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      // The saved device id changes when a camera is re-plugged on some systems: match by label.
      if ((e as DOMException).name === 'OverconstrainedError' || (e as DOMException).name === 'NotFoundError') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find((d) => d.kind === 'videoinput' && d.label && d.label === s.deviceLabel);
        if (match && match.deviceId !== s.deviceId) {
          this.svc.patchSourceSettings(this.sourceId, { deviceId: match.deviceId });
          return navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: { exact: match.deviceId } }, audio: false });
        }
      }
      throw e;
    }
  }
}

type DesktopConstraints = MediaTrackConstraints & { mandatory?: Record<string, unknown> };

async function desktopStream(id: string, fps: number): Promise<MediaStream> {
  const video: DesktopConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: id,
      maxWidth: 7680,
      maxHeight: 4320,
      maxFrameRate: Math.max(1, Math.min(120, fps)),
    },
  };
  return navigator.mediaDevices.getUserMedia({ audio: false, video: video as MediaTrackConstraints });
}

export class DisplayCaptureRuntime extends StreamVideoRuntime {
  readonly type = 'display_capture' as const;
  protected what = 'display';
  private s!: SourceOf<'display_capture'>['settings'];
  private key = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'display_capture'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'display_capture'>).settings;
    const key = JSON.stringify([this.s.captureId, this.s.fps]);
    if (key === this.key) return;
    this.key = key;
    void this.open();
  }

  protected async acquire(): Promise<MediaStream> {
    let id = this.s.captureId;
    const screens = await this.svc.api.desktop.getSources(['screen']);
    if (!screens.length) throw new Error('No displays found');
    if (!screens.some((x) => x.id === id)) {
      // Monitor ids can change when displays are re-arranged: fall back by name, then to the first.
      const byName = screens.find((x) => x.name === this.s.captureName);
      id = (byName ?? screens[0]).id;
    }
    return desktopStream(id, this.s.fps);
  }
}

export class WindowCaptureRuntime extends StreamVideoRuntime {
  readonly type = 'window_capture' as const;
  protected what = 'window';
  private s!: SourceOf<'window_capture'>['settings'];
  private key = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'window_capture'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'window_capture'>).settings;
    const key = JSON.stringify([this.s.captureId, this.s.fps]);
    if (key === this.key) return;
    this.key = key;
    void this.open();
  }

  protected async acquire(): Promise<MediaStream> {
    if (!this.s.captureId && !this.s.captureName) throw new Error('No window selected');
    const windows = await this.svc.api.desktop.getSources(['window']);
    let id = this.s.captureId;
    if (!windows.some((w) => w.id === id)) {
      // Window ids change every time an app restarts: re-match by title.
      const match = windows.find((w) => w.name === this.s.captureName) ?? windows.find((w) => this.s.captureName && w.name.includes(this.s.captureName));
      if (!match) {
        const err = new Error(`Waiting for window "${this.s.captureName}"…`);
        err.name = 'WindowMissing';
        throw err;
      }
      id = match.id;
      this.svc.patchSourceSettings(this.sourceId, { captureId: id });
    }
    return desktopStream(id, this.s.fps);
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

abstract class StreamAudioRuntime implements SourceRuntime {
  abstract readonly type: Source['type'];
  width = 0;
  height = 0;
  protected stream: MediaStream | null = null;
  private node: MediaStreamAudioSourceNode | null = null;
  private opening = 0;
  private retryTimer: number | null = null;
  protected destroyed = false;
  protected abstract what: string;

  constructor(
    readonly sourceId: string,
    protected readonly svc: EngineServices,
  ) {}

  abstract update(source: Source): void;
  protected abstract acquire(): Promise<MediaStream>;

  protected async open(): Promise<void> {
    const gen = ++this.opening;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.close();
    try {
      const stream = await this.acquire();
      if (gen !== this.opening || this.destroyed) {
        stopStream(stream);
        return;
      }
      if (!stream.getAudioTracks().length) {
        stopStream(stream);
        throw new Error('No audio track');
      }
      // Only the audio is needed (desktop audio capture also delivers a video track).
      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      this.stream = stream;
      this.node = this.svc.audio.ctx.createMediaStreamSource(stream);
      this.node.connect(this.svc.audio.channel(this.sourceId).input);
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (gen !== this.opening || this.destroyed) return;
        this.svc.reportIssue(this.sourceId, `The ${this.what} disconnected. Retrying…`);
        this.scheduleRetry();
      });
      this.svc.reportIssue(this.sourceId, null);
    } catch (e) {
      if (gen !== this.opening || this.destroyed) return;
      const msg = e instanceof Error && !(e instanceof DOMException) ? e.message : describeMediaError(e, this.what);
      this.svc.reportIssue(this.sourceId, msg);
      this.scheduleRetry(10000);
    }
  }

  protected scheduleRetry(ms = 5000): void {
    if (this.destroyed || this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, ms);
  }

  reload(): void {
    void this.open();
  }

  private close() {
    this.node?.disconnect();
    this.node = null;
    stopStream(this.stream);
    this.stream = null;
  }

  texture(): TexInfo | null {
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    this.opening++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.close();
  }
}

export class AudioInputRuntime extends StreamAudioRuntime {
  readonly type = 'audio_input' as const;
  protected what = 'microphone';
  private s!: SourceOf<'audio_input'>['settings'];
  private key = '';

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'audio_input'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source: Source): void {
    this.s = (source as SourceOf<'audio_input'>).settings;
    const key = JSON.stringify([this.s.deviceId, this.s.noiseSuppression, this.s.echoCancellation, this.s.autoGainControl]);
    if (key === this.key) return;
    this.key = key;
    void this.open();
  }

  protected async acquire(): Promise<MediaStream> {
    const s = this.s;
    const audio: MediaTrackConstraints = {
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: this.svc.audio.ctx.sampleRate },
    };
    if (s.deviceId && s.deviceId !== 'default') audio.deviceId = { exact: s.deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (e) {
      if ((e as DOMException).name === 'OverconstrainedError' || (e as DOMException).name === 'NotFoundError') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find((d) => d.kind === 'audioinput' && d.label && d.label === s.deviceLabel);
        if (match && match.deviceId !== s.deviceId) {
          this.svc.patchSourceSettings(this.sourceId, { deviceId: match.deviceId });
          return navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: match.deviceId } }, video: false });
        }
      }
      throw e;
    }
  }
}

/** Desktop / system audio. Windows: WASAPI loopback; macOS 13+: ScreenCaptureKit; Linux: monitor device. */
export class AudioOutputRuntime extends StreamAudioRuntime {
  readonly type = 'audio_output' as const;
  protected what = 'desktop audio';
  private started = false;

  constructor(sourceId: string, svc: EngineServices, source: SourceOf<'audio_output'>) {
    super(sourceId, svc);
    this.update(source);
  }

  update(source?: Source): void {
    void source; // desktop audio has no settings that require re-opening
    if (this.started) return;
    this.started = true;
    void this.open();
  }

  protected async acquire(): Promise<MediaStream> {
    const platform = this.svc.api.platform;
    if (platform === 'win32') {
      const desktop = { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints;
      return navigator.mediaDevices.getUserMedia({ audio: desktop, video: desktop });
    }
    if (platform === 'darwin') {
      return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    }
    // Linux (PulseAudio / PipeWire): the system output is exposed as a "Monitor of …" input.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const monitor = devices.find((d) => d.kind === 'audioinput' && /monitor/i.test(d.label));
    if (!monitor) {
      throw new Error('No desktop-audio monitor device found. On Linux, enable a PulseAudio/PipeWire monitor source (e.g. with pavucontrol) or add an "Audio Input Capture" for it.');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: monitor.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      video: false,
    });
  }
}
