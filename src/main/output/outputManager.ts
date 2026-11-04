import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, CaptureRequest, EncoderSettings, OutputStatus } from '../../shared/types';
import { RECORDING_EXTENSIONS, encoderCodec, encoderSettingsKey, recordingEncoderSettings } from '../../shared/ffmpegArgs';
import { PLATFORMS, bitrateWarnings, validateDestination } from '../../shared/platforms';
import { formatFilename, normalizeOutputSize } from '../../shared/util';
import { DelayBuffer } from './delayBuffer';
import { EncoderPipeline } from './encoder';
import { MediaHub } from './mediaHub';
import { Pusher } from './pusher';
import { Recorder } from './recorder';
import { ReplayBuffer } from './replayBuffer';
import type { StreamFanout } from './streamFanout';

type Role = 'stream' | 'recording' | 'replay';

export interface OutputManagerDeps {
  getSettings(): AppSettings;
  /** Sample rate the renderer's audio engine actually runs at (fixed until restart). */
  sampleRate?(): number;
  resolveFfmpeg(): Promise<string>;
  defaultRecordingDir(): string;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  onStatus(status: OutputStatus): void;
  onCaptureRequest(req: CaptureRequest): void;
  onNotice(level: 'info' | 'warning' | 'error', message: string): void;
}

interface EncoderEntry {
  pipeline: EncoderPipeline;
  roles: Set<Role>;
}

interface StreamState {
  encoderKey: string;
  delay: DelayBuffer | null;
  pushers: Pusher[];
  startedAt: number;
  autoRecording: boolean;
  autoReplay: boolean;
  stopping: boolean;
}

export class OutputManager {
  private hub: MediaHub | null = null;
  private hubStarting: Promise<MediaHub> | null = null;
  private encoders = new Map<string, EncoderEntry>();
  private stream: StreamState | null = null;
  private streamStarting = false;
  private recording: { encoderKey: string; recorder: Recorder } | null = null;
  private replay: { encoderKey: string; buffer: ReplayBuffer } | null = null;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private statsTimer: NodeJS.Timeout | null = null;
  private reconnectCaptureTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OutputManagerDeps) {}

  /** Serialise start/stop operations so rapid clicks / hotkeys can't interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  status(): OutputStatus {
    const s = this.deps.getSettings();
    return {
      streaming: !!this.stream,
      streamStarting: this.streamStarting,
      streamStopping: !!this.stream?.stopping,
      streamStartedAt: this.stream?.startedAt ?? null,
      stopCountdownSec: this.stream?.stopping && this.stream.delay ? Math.ceil(this.stream.delay.remainingSec) : 0,
      delaySec: this.stream?.delay ? s.stream.delaySec : 0,
      destinations: this.stream?.pushers.map((p) => p.status()) ?? [],
      recording: !!this.recording,
      recordingStartedAt: this.recording?.recorder.startedAt ?? null,
      recordingPath: this.recording?.recorder.path ?? null,
      replayBuffer: !!this.replay,
      replayBufferSeconds: this.replay ? Math.round(this.replay.buffer.seconds) : 0,
      encoders: [...this.encoders.values()].map(({ pipeline }) => ({
        id: pipeline.id,
        label: pipeline.label,
        encoder: pipeline.settings.encoder,
        fps: pipeline.fps,
        speed: pipeline.speed,
        kbps: Math.round(pipeline.kbps),
        skippedFrames: pipeline.skippedFrames,
        lagging: pipeline.lagging,
      })),
      lastError: this.lastError,
    };
  }

  private emit() {
    this.deps.onStatus(this.status());
  }

  private ensureStatsTimer() {
    const active = this.encoders.size > 0;
    if (active && !this.statsTimer) {
      this.statsTimer = setInterval(() => {
        for (const e of this.encoders.values()) e.pipeline.updateRates();
        this.stream?.pushers.forEach((p) => p.updateRates());
        this.emit();
      }, 1000);
    } else if (!active && this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Hub & encoders
  // ---------------------------------------------------------------------------

  private hubFormat() {
    const s = this.deps.getSettings();
    const { width, height } = normalizeOutputSize(s.video.outputWidth, s.video.outputHeight);
    return { width, height, fpsNum: s.video.fpsNum, fpsDen: s.video.fpsDen, sampleRate: this.deps.sampleRate?.() ?? s.audio.sampleRate };
  }

  private captureRequest(active: boolean): CaptureRequest {
    const f = this.hub?.format ?? this.hubFormat();
    return { active, port: this.hub?.port ?? 0, token: this.hub?.token ?? '', ...f };
  }

  private async ensureHub(): Promise<MediaHub> {
    if (this.hub) return this.hub;
    if (this.hubStarting) return this.hubStarting;
    this.hubStarting = (async () => {
      const hub = new MediaHub(this.hubFormat());
      hub.on('log', (lvl: 'info' | 'warn' | 'error', msg: string) => this.deps.log(lvl, msg));
      await hub.start();
      hub.on('disconnected', () => {
        // The renderer reloaded or crashed: ask it to reconnect while outputs are active.
        if (this.hub !== hub) return;
        this.deps.log('warn', 'capture link disconnected; requesting reconnect');
        if (this.reconnectCaptureTimer) clearTimeout(this.reconnectCaptureTimer);
        this.reconnectCaptureTimer = setTimeout(() => {
          if (this.hub === hub && !hub.connected) this.deps.onCaptureRequest(this.captureRequest(true));
        }, 1000);
      });
      this.hub = hub;
      this.deps.onCaptureRequest(this.captureRequest(true));
      return hub;
    })();
    try {
      return await this.hubStarting;
    } finally {
      this.hubStarting = null;
    }
  }

  /** Re-send the current capture request (e.g. after the renderer reloaded). */
  resendCaptureRequest(): void {
    if (this.hub) this.deps.onCaptureRequest(this.captureRequest(true));
  }

  private async acquireEncoder(role: Role, settings: EncoderSettings, label: string): Promise<{ key: string; fanout: StreamFanout; pipeline: EncoderPipeline }> {
    const key = encoderSettingsKey(settings);
    const existing = this.encoders.get(key);
    if (existing && existing.pipeline.alive) {
      existing.roles.add(role);
      return { key, fanout: existing.pipeline.fanout, pipeline: existing.pipeline };
    }
    const ffmpegPath = await this.deps.resolveFfmpeg();
    const hub = await this.ensureHub();
    const s = this.deps.getSettings();
    const pipeline = new EncoderPipeline({
      id: key,
      label,
      settings,
      format: hub.format,
      ffmpegPath,
      priority: s.advanced.processPriority,
      verbose: s.advanced.verboseLogging,
      log: this.deps.log,
    });
    pipeline.on('failed', (err: Error) => void this.onEncoderFailed(key, err));
    hub.attach(pipeline);
    this.encoders.set(key, { pipeline, roles: new Set([role]) });
    this.ensureStatsTimer();
    return { key, fanout: pipeline.fanout, pipeline };
  }

  private async releaseEncoder(role: Role, key: string): Promise<void> {
    const entry = this.encoders.get(key);
    if (!entry) return;
    entry.roles.delete(role);
    if (entry.roles.size > 0) return;
    this.encoders.delete(key);
    this.hub?.detach(entry.pipeline);
    await entry.pipeline.stop();
    if (this.encoders.size === 0) this.stopHub();
    this.ensureStatsTimer();
  }

  private stopHub() {
    if (!this.hub) return;
    if (this.reconnectCaptureTimer) clearTimeout(this.reconnectCaptureTimer);
    this.deps.onCaptureRequest(this.captureRequest(false));
    this.hub.stop();
    this.hub = null;
  }

  private async onEncoderFailed(key: string, err: Error) {
    this.lastError = err.message;
    this.deps.onNotice('error', err.message);
    const entry = this.encoders.get(key);
    if (!entry) return;
    await this.exclusive(async () => {
      if (this.stream?.encoderKey === key) await this.stopStreamInternal(true);
      if (this.recording?.encoderKey === key) await this.stopRecordingInternal();
      if (this.replay?.encoderKey === key) await this.stopReplayInternal();
      // make sure the entry is gone even if roles were inconsistent
      if (this.encoders.get(key) === entry) {
        this.encoders.delete(key);
        this.hub?.detach(entry.pipeline);
        if (this.encoders.size === 0) this.stopHub();
        this.ensureStatsTimer();
      }
    });
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  startStream(): Promise<void> {
    return this.exclusive(async () => {
      if (this.stream) return;
      const s = this.deps.getSettings();
      const dests = s.stream.destinations.filter((d) => d.enabled);
      if (!dests.length) throw new Error('No streaming destination is enabled. Add YouTube, Facebook or another platform in Go Live → Destinations.');
      for (const d of dests) {
        const problem = validateDestination(d);
        if (problem) throw new Error(problem);
      }
      const enc = s.output.stream;
      if (encoderCodec(enc.encoder) !== 'h264') throw new Error('Streaming requires an H.264 encoder (YouTube, Facebook and Twitch ingest only accept H.264). Change it in Settings → Output.');
      this.streamStarting = true;
      this.lastError = null;
      this.emit();
      try {
        const { height, fpsNum, fpsDen } = this.hubFormat();
        for (const w of bitrateWarnings(dests, enc.videoBitrate, height, fpsNum / fpsDen)) this.deps.onNotice('warning', w);
        const { key, fanout } = await this.acquireEncoder('stream', enc, 'Stream encoder');
        const delay = s.stream.delaySec > 0 ? new DelayBuffer(fanout, s.stream.delaySec * 1000) : null;
        const source = delay ? delay.output : fanout;
        const ffmpegPath = await this.deps.resolveFfmpeg();
        const pushers = dests.map(
          (d) =>
            new Pusher(source, {
              destination: d,
              ffmpegPath,
              autoReconnect: s.stream.autoReconnect,
              reconnectDelaySec: s.stream.reconnectDelaySec,
              maxRetries: s.stream.maxRetries,
              verbose: s.advanced.verboseLogging,
              bitrateKbps: enc.videoBitrate + enc.audioBitrate,
              log: this.deps.log,
            }),
        );
        const state: StreamState = { encoderKey: key, delay, pushers, startedAt: Date.now(), autoRecording: false, autoReplay: false, stopping: false };
        this.stream = state;
        for (const p of pushers) {
          p.on('state', () => this.emit());
          p.on('failed', (msg: string) => {
            this.deps.onNotice('error', `${p.destination.name} (${PLATFORMS[p.destination.platform].label}): ${msg}`);
            if (this.stream === state && state.pushers.every((x) => x.state === 'error')) {
              this.lastError = 'All destinations failed. The stream was stopped.';
              void this.stopStream(true);
            }
          });
          p.start();
        }
        this.deps.log('info', `stream started to ${dests.map((d) => d.name).join(', ')}`);
        if (s.general.recordWhenStreaming && !this.recording) {
          try {
            await this.startRecordingInternal();
            state.autoRecording = true;
          } catch (e) {
            this.deps.onNotice('error', `Could not start recording: ${(e as Error).message}`);
          }
        }
        if (s.general.replayBufferWhileStreaming && !this.replay) {
          try {
            await this.startReplayInternal();
            state.autoReplay = true;
          } catch (e) {
            this.deps.onNotice('error', `Could not start the replay buffer: ${(e as Error).message}`);
          }
        }
      } finally {
        this.streamStarting = false;
        this.emit();
      }
    });
  }

  stopStream(force = false): Promise<void> {
    return this.exclusive(() => this.stopStreamInternal(force));
  }

  private async stopStreamInternal(force: boolean): Promise<void> {
    const st = this.stream;
    if (!st) return;
    if (st.stopping && !force) return;
    st.stopping = true;
    this.emit();
    if (st.delay && !force) {
      const tick = setInterval(() => this.emit(), 500);
      // Keep sending the delayed content, then let every pusher finish cleanly.
      await st.delay.drain();
      // waitClosed covers connected pushers; stop() also cancels any pending reconnect timer.
      await Promise.all(st.pushers.map((p) => p.waitClosed().then(() => p.stop())));
      clearInterval(tick);
    } else {
      st.delay?.abort();
      await Promise.all(st.pushers.map((p) => p.stop()));
    }
    await this.releaseEncoder('stream', st.encoderKey);
    this.stream = null;
    this.deps.log('info', 'stream stopped');
    const s = this.deps.getSettings();
    if (st.autoRecording && this.recording && !s.general.keepRecordingWhenStreamStops) await this.stopRecordingInternal();
    if (st.autoReplay && this.replay) await this.stopReplayInternal();
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  private recordingEncoder(): EncoderSettings {
    const s = this.deps.getSettings();
    return recordingEncoderSettings(s.output.recording, s.output.stream) ?? s.output.stream;
  }

  /** Recordings that use the stream settings share (and are labelled as) the stream encoder. */
  private recordingLabel(): string {
    const s = this.deps.getSettings();
    const separate = recordingEncoderSettings(s.output.recording, s.output.stream);
    return separate && encoderSettingsKey(separate) !== encoderSettingsKey(s.output.stream) ? 'Recording encoder' : 'Stream encoder';
  }

  private async recordingDir(): Promise<string> {
    const s = this.deps.getSettings();
    const dir = s.output.recording.path.trim() || this.deps.defaultRecordingDir();
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private uniquePath(dir: string, base: string, ext: string): string {
    let p = path.join(dir, `${base}.${ext}`);
    for (let i = 1; existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
    return p;
  }

  startRecording(): Promise<void> {
    return this.exclusive(() => this.startRecordingInternal());
  }

  private async startRecordingInternal(): Promise<void> {
    if (this.recording) return;
    const s = this.deps.getSettings();
    const rec = s.output.recording;
    const enc = this.recordingEncoder();
    if (rec.format === 'flv' && encoderCodec(enc.encoder) === 'hevc') throw new Error('FLV recordings support H.264 only. Choose MP4/MKV or an H.264 encoder.');
    const dir = await this.recordingDir();
    const file = this.uniquePath(dir, formatFilename(rec.filenameFormat, new Date()), RECORDING_EXTENSIONS[rec.format]);
    const { key, fanout } = await this.acquireEncoder('recording', enc, this.recordingLabel());
    const ffmpegPath = await this.deps.resolveFfmpeg();
    const recorder = new Recorder(fanout, { path: file, format: rec.format, ffmpegPath, verbose: s.advanced.verboseLogging, hevc: encoderCodec(enc.encoder) === 'hevc', log: this.deps.log });
    const state = { encoderKey: key, recorder };
    this.recording = state;
    recorder.on('failed', (msg: string) => {
      this.lastError = `Recording failed: ${msg}`;
      this.deps.onNotice('error', this.lastError);
      void this.exclusive(async () => {
        if (this.recording === state) {
          this.recording = null;
          await this.releaseEncoder('recording', key);
          this.emit();
        }
      });
    });
    this.emit();
  }

  stopRecording(): Promise<void> {
    return this.exclusive(() => this.stopRecordingInternal());
  }

  private async stopRecordingInternal(): Promise<void> {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    this.emit();
    const ok = await r.recorder.stop();
    await this.releaseEncoder('recording', r.encoderKey);
    if (ok) this.deps.onNotice('info', `Recording saved: ${r.recorder.path}`);
    else this.deps.onNotice('warning', `Recording finished with errors: ${r.recorder.path}`);
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Replay buffer
  // ---------------------------------------------------------------------------

  startReplayBuffer(): Promise<void> {
    return this.exclusive(() => this.startReplayInternal());
  }

  private async startReplayInternal(): Promise<void> {
    if (this.replay) return;
    const s = this.deps.getSettings();
    const enc = this.recordingEncoder();
    const { key, fanout } = await this.acquireEncoder('replay', enc, this.recordingLabel());
    const ffmpegPath = await this.deps.resolveFfmpeg();
    const duration = Math.max(5, Math.min(600, s.output.replayBuffer.durationSec));
    this.replay = { encoderKey: key, buffer: new ReplayBuffer(fanout, duration, ffmpegPath, encoderCodec(enc.encoder) === 'hevc') };
    this.emit();
  }

  stopReplayBuffer(): Promise<void> {
    return this.exclusive(() => this.stopReplayInternal());
  }

  private async stopReplayInternal(): Promise<void> {
    const r = this.replay;
    if (!r) return;
    this.replay = null;
    r.buffer.stop();
    await this.releaseEncoder('replay', r.encoderKey);
    this.emit();
  }

  async saveReplay(): Promise<string> {
    const r = this.replay;
    if (!r) throw new Error('The replay buffer is not running.');
    const s = this.deps.getSettings();
    const fmt = s.output.replayBuffer.format;
    const dir = await this.recordingDir();
    const file = this.uniquePath(dir, `Replay ${formatFilename('%Y-%m-%d %H-%M-%S', new Date())}`, RECORDING_EXTENSIONS[fmt]);
    const out = await r.buffer.save(file, fmt);
    this.deps.onNotice('info', `Replay saved: ${out}`);
    return out;
  }

  // ---------------------------------------------------------------------------

  get active(): boolean {
    return !!(this.stream || this.recording || this.replay);
  }

  /** Stop everything (app quit). */
  async shutdown(): Promise<void> {
    await this.exclusive(async () => {
      await this.stopStreamInternal(true);
      await this.stopRecordingInternal();
      await this.stopReplayInternal();
    });
    for (const [key, e] of this.encoders) {
      this.encoders.delete(key);
      await e.pipeline.stop();
    }
    this.stopHub();
    this.ensureStatsTimer();
  }
}
