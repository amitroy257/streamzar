import type { AudioFilter, AudioSettings } from '@shared/types';
import { dbToGain, gainToDb } from '@shared/util';
import workletUrl from './worklet.ts?worker&url';

export interface Levels {
  peak: [number, number];
  rms: [number, number];
}

const SILENT: Levels = { peak: [-100, -100], rms: [-100, -100] };

/** A filter as a small sub-graph with one input and one output node. */
export interface FilterUnit {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
}

function measure(a: AnalyserNode, buf: Float32Array<ArrayBuffer>): [number, number] {
  a.getFloatTimeDomainData(buf);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
    sum += v * v;
  }
  return [gainToDb(peak), gainToDb(Math.sqrt(sum / buf.length))];
}

/** One mixer strip: input → filters → sync delay → mono → balance → fader → mute → routing. */
export class Channel {
  readonly input: GainNode;
  private filterUnits: FilterUnit[] = [];
  private filterKey = '';
  private delay: DelayNode;
  private mono: GainNode;
  private panner: StereoPannerNode;
  private fader: GainNode;
  private muteGain: GainNode;
  private activeGain: GainNode;
  private outSend: GainNode;
  private monSend: GainNode;
  private splitter: ChannelSplitterNode;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  active = false;

  constructor(
    private readonly engine: AudioEngine,
    readonly sourceId: string,
  ) {
    const ctx = engine.ctx;
    this.input = ctx.createGain();
    this.delay = ctx.createDelay(10);
    this.mono = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.fader = ctx.createGain();
    this.muteGain = ctx.createGain();
    this.activeGain = ctx.createGain();
    this.activeGain.gain.value = 0;
    this.outSend = ctx.createGain();
    this.monSend = ctx.createGain();
    this.monSend.gain.value = 0;
    this.splitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;
    this.buf = new Float32Array(1024);
    this.input.connect(this.delay);
    this.delay.connect(this.mono);
    this.mono.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(this.muteGain);
    this.muteGain.connect(this.activeGain);
    this.activeGain.connect(this.outSend);
    this.activeGain.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.outSend.connect(engine.master);
    // Monitoring taps the signal before the "active in program" gate so you can hear sources
    // you're preparing, like OBS does.
    this.muteGain.connect(this.monSend);
    this.monSend.connect(engine.monitorBus);
  }

  update(s: AudioSettings): void {
    const t = this.engine.ctx.currentTime;
    this.fader.gain.setTargetAtTime(dbToGain(s.volumeDb), t, 0.015);
    this.muteGain.gain.setTargetAtTime(s.muted ? 0 : 1, t, 0.01);
    this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, s.balance)), t, 0.015);
    this.delay.delayTime.setValueAtTime(Math.max(0, Math.min(9.5, s.syncOffsetMs / 1000)), t);
    this.mono.channelCount = s.mono ? 1 : 2;
    this.mono.channelCountMode = 'explicit';
    this.mono.channelInterpretation = 'speakers';
    this.outSend.gain.setTargetAtTime(s.monitoring === 'monitor-only' ? 0 : 1, t, 0.01);
    this.monSend.gain.setTargetAtTime(s.monitoring === 'off' ? 0 : 1, t, 0.01);
    this.rebuildFilters(s.filters);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.activeGain.gain.setTargetAtTime(active ? 1 : 0, this.engine.ctx.currentTime, 0.02);
  }

  private rebuildFilters(filters: AudioFilter[]) {
    const enabled = filters.filter((f) => f.enabled);
    const key = JSON.stringify(enabled.map((f) => [f.type, f.id]));
    if (key === this.filterKey) {
      // Same structure: just update parameters.
      enabled.forEach((f, i) => this.engine.configureFilter(this.filterUnits[i], f));
      return;
    }
    this.filterKey = key;
    this.input.disconnect();
    for (const u of this.filterUnits) for (const n of u.nodes) n.disconnect();
    this.filterUnits = enabled.map((f) => this.engine.createFilter(f));
    let prev: AudioNode = this.input;
    for (const u of this.filterUnits) {
      prev.connect(u.input);
      prev = u.output;
    }
    prev.connect(this.delay);
  }

  levels(): Levels {
    const l = measure(this.analyserL, this.buf);
    const r = measure(this.analyserR, this.buf);
    return { peak: [l[0], r[0]], rms: [l[1], r[1]] };
  }

  dispose(): void {
    for (const n of [this.input, ...this.filterUnits.flatMap((u) => u.nodes), this.delay, this.mono, this.panner, this.fader, this.muteGain, this.activeGain, this.outSend, this.monSend, this.splitter]) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}

/** Mixes every audio source into the program bus and captures it for the encoder. */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly monitorBus: GainNode;
  private channels = new Map<string, Channel>();
  private capture: AudioWorkletNode | null = null;
  private masterSplit: ChannelSplitterNode;
  private masterL: AnalyserNode;
  private masterR: AnalyserNode;
  private mbuf = new Float32Array(1024);
  readonly ready: Promise<void>;
  private onAudio: ((frame: number, data: Float32Array) => void) | null = null;
  private startResolve: ((frame: number) => void) | null = null;
  workletsAvailable = false;

  constructor(sampleRate: number) {
    this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.monitorBus = this.ctx.createGain();
    this.monitorBus.connect(this.ctx.destination);
    this.masterSplit = this.ctx.createChannelSplitter(2);
    this.masterL = this.ctx.createAnalyser();
    this.masterR = this.ctx.createAnalyser();
    this.masterL.fftSize = 1024;
    this.masterR.fftSize = 1024;
    this.master.connect(this.masterSplit);
    this.masterSplit.connect(this.masterL, 0);
    this.masterSplit.connect(this.masterR, 1);
    this.ready = this.init();
  }

  private async init() {
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.workletsAvailable = true;
    } catch (e) {
      console.error('audio worklets unavailable', e);
      return;
    }
    const node = new AudioWorkletNode(this.ctx, 'streamzar-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = (e: MessageEvent<{ type: string; frame: number; data?: Float32Array }>) => {
      const m = e.data;
      if (m.type === 'started') {
        this.startResolve?.(m.frame);
        this.startResolve = null;
      } else if (m.type === 'audio' && m.data) {
        this.onAudio?.(m.frame, m.data);
      }
    };
    this.master.connect(node);
    // The capture node must be pulled by the graph to run; route it to the output at zero gain.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(this.ctx.destination);
    this.capture = node;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async setMonitoringDevice(deviceId: string): Promise<void> {
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (ctx.setSinkId) {
      try {
        await ctx.setSinkId(deviceId || '');
      } catch (e) {
        console.warn('could not set monitoring device', e);
      }
    }
  }

  channel(sourceId: string): Channel {
    let ch = this.channels.get(sourceId);
    if (!ch) {
      ch = new Channel(this, sourceId);
      this.channels.set(sourceId, ch);
    }
    return ch;
  }

  hasChannel(sourceId: string): boolean {
    return this.channels.has(sourceId);
  }

  removeChannel(sourceId: string): void {
    const ch = this.channels.get(sourceId);
    if (ch) {
      ch.dispose();
      this.channels.delete(sourceId);
    }
  }

  levels(sourceId: string): Levels {
    return this.channels.get(sourceId)?.levels() ?? SILENT;
  }

  masterLevels(): Levels {
    const l = measure(this.masterL, this.mbuf);
    const r = measure(this.masterR, this.mbuf);
    return { peak: [l[0], r[0]], rms: [l[1], r[1]] };
  }

  /** Begin capturing the program mix. Resolves with the sample frame of the first captured sample. */
  async startCapture(onAudio: (frame: number, data: Float32Array) => void): Promise<number> {
    await this.ready;
    if (!this.capture) throw new Error('Audio capture is unavailable (AudioWorklet failed to load).');
    await this.resume();
    this.onAudio = onAudio;
    const started = new Promise<number>((resolve) => {
      this.startResolve = resolve;
    });
    this.capture.port.postMessage({ cmd: 'start' });
    return started;
  }

  stopCapture(): void {
    this.capture?.port.postMessage({ cmd: 'stop' });
    this.onAudio = null;
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  createFilter(f: AudioFilter): FilterUnit {
    const ctx = this.ctx;
    const single = (n: AudioNode): FilterUnit => ({ input: n, output: n, nodes: [n] });
    let unit: FilterUnit;
    switch (f.type) {
      case 'compressor':
      case 'limiter': {
        const comp = ctx.createDynamicsCompressor();
        const makeup = ctx.createGain();
        comp.connect(makeup);
        unit = { input: comp, output: makeup, nodes: [comp, makeup] };
        break;
      }
      case 'eq3': {
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.Q.value = 0.7;
        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        low.connect(mid);
        mid.connect(high);
        unit = { input: low, output: high, nodes: [low, mid, high] };
        break;
      }
      case 'highpass': {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.Q.value = 0.707;
        unit = single(hp);
        break;
      }
      case 'noise_gate':
        unit = single(
          this.workletsAvailable
            ? new AudioWorkletNode(ctx, 'streamzar-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: f.settings })
            : ctx.createGain(),
        );
        break;
      case 'gain':
      default:
        unit = single(ctx.createGain());
    }
    this.configureFilter(unit, f);
    return unit;
  }

  configureFilter(unit: FilterUnit, f: AudioFilter): void {
    const s = f.settings;
    const n = (k: string, d: number) => (typeof s[k] === 'number' ? (s[k] as number) : d);
    const t = this.ctx.currentTime;
    switch (f.type) {
      case 'gain':
        (unit.input as GainNode).gain.setTargetAtTime(dbToGain(n('gainDb', 0)), t, 0.01);
        break;
      case 'compressor': {
        const c = unit.input as DynamicsCompressorNode;
        c.threshold.value = Math.max(-100, Math.min(0, n('threshold', -18)));
        c.ratio.value = Math.max(1, Math.min(20, n('ratio', 4)));
        c.attack.value = Math.max(0, Math.min(1, n('attackMs', 6) / 1000));
        c.release.value = Math.max(0.01, Math.min(1, n('releaseMs', 60) / 1000));
        c.knee.value = Math.max(0, Math.min(40, n('knee', 6)));
        (unit.output as GainNode).gain.value = dbToGain(n('outputGain', 0));
        break;
      }
      case 'limiter': {
        const c = unit.input as DynamicsCompressorNode;
        c.threshold.value = Math.max(-60, Math.min(0, n('threshold', -6)));
        c.ratio.value = 20;
        c.knee.value = 0;
        c.attack.value = 0.001;
        c.release.value = Math.max(0.01, Math.min(1, n('releaseMs', 60) / 1000));
        (unit.output as GainNode).gain.value = 1;
        break;
      }
      case 'eq3': {
        const [low, mid, high] = unit.nodes as BiquadFilterNode[];
        const lf = Math.max(20, Math.min(2000, n('lowFreq', 250)));
        const hf = Math.max(lf * 2, Math.min(18000, n('highFreq', 4000)));
        low.frequency.value = lf;
        low.gain.value = Math.max(-24, Math.min(24, n('low', 0)));
        mid.frequency.value = Math.sqrt(lf * hf);
        mid.gain.value = Math.max(-24, Math.min(24, n('mid', 0)));
        high.frequency.value = hf;
        high.gain.value = Math.max(-24, Math.min(24, n('high', 0)));
        break;
      }
      case 'highpass':
        (unit.input as BiquadFilterNode).frequency.value = Math.max(10, Math.min(2000, n('frequency', 80)));
        break;
      case 'noise_gate':
        if (unit.input instanceof AudioWorkletNode) unit.input.port.postMessage({ ...s });
        break;
    }
  }

  dispose(): void {
    for (const id of [...this.channels.keys()]) this.removeChannel(id);
    void this.ctx.close();
  }
}

