import { useEffect, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, RefreshCw, Play, X, AlertTriangle } from 'lucide-react';
import type { AlertType, AppSettings, Source, EncoderId, EncoderSettings, QualityPreset, RateControl, RecordingFormat, RecordingQuality, ServerInfo } from '@shared/types';
import type { AppInfo } from '@shared/ipc';
import { ALERT_TYPE_LABELS, ALERT_TYPES, HOTKEY_LABELS } from '@shared/defaults';
import { ENCODERS, RECORDING_FORMAT_LABELS, encoderCodec } from '@shared/ffmpegArgs';
import { QUALITY_PRESETS } from '@shared/platforms';
import { createSource } from '@shared/defaults';
import { deepClone, normalizeOutputSize, uid, formatMoney } from '@shared/util';
import { api } from '../../api';
import { useStore } from '../../state/store';
import { engineOrNull } from '../../state/controller';
import { DestinationsEditor } from '../dialogs/GoLive';
import { ALERT_MEDIA_FILTER, AUDIO_FILTER, Check, ColorInput, Field, FileInput, Modal, NumberInput, SecretInput, Select, Slider, TextInput } from '../ui';

type Tab = 'general' | 'stream' | 'output' | 'video' | 'audio' | 'hotkeys' | 'alerts' | 'chat' | 'remote' | 'advanced';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'stream', label: 'Stream' },
  { id: 'output', label: 'Output' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'hotkeys', label: 'Hotkeys' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'chat', label: 'Chat & Platforms' },
  { id: 'remote', label: 'Remote & Webhooks' },
  { id: 'advanced', label: 'Advanced' },
];

type Draft = AppSettings;
type SetDraft = (fn: (d: Draft) => void) => void;

const PRESET_LABELS: Record<QualityPreset, string> = { speed: 'Speed (lowest CPU/GPU)', balanced: 'Balanced (recommended)', quality: 'Quality', max_quality: 'Max quality (heavy)' };

function EncoderFields(props: { value: EncoderSettings; onChange: (e: EncoderSettings) => void; allowHevc: boolean; disabled: boolean }) {
  const encoders = useStore((s) => s.encoders);
  const e = props.value;
  const set = (p: Partial<EncoderSettings>) => props.onChange({ ...e, ...p });
  const list = ENCODERS.filter((x) => props.allowHevc || x.codec === 'h264').map((x) => {
    const info = encoders.find((i) => i.id === x.id);
    return { value: x.id, label: `${x.label}${info && !info.available ? ' (not available)' : ''}`, disabled: !!info && !info.available };
  });
  const sel = encoders.find((x) => x.id === e.encoder);
  return (
    <fieldset disabled={props.disabled} style={{ border: 0, padding: 0, margin: 0 }}>
      <Field label="Encoder" help="Hardware encoders (NVENC, QuickSync, AMF, VideoToolbox) use your GPU and leave the CPU free for games. Only encoders that passed a test on this computer can be selected.">
        <Select<EncoderId> value={e.encoder} onChange={(v) => set({ encoder: v })} options={list} />
      </Field>
      {sel && !sel.available && (
        <div className="callout warn">
          <AlertTriangle size={15} /> The selected encoder is not available on this computer. Choose another one.
        </div>
      )}
      <div className="field-row">
        <Field label="Rate control" help="CBR is recommended for streaming. Constant quality is best for recordings.">
          <Select<RateControl>
            value={e.rateControl}
            onChange={(v) => set({ rateControl: v })}
            options={[
              { value: 'cbr', label: 'CBR (constant bitrate)' },
              { value: 'vbr', label: 'VBR (variable bitrate)' },
              { value: 'cqp', label: 'Constant quality (CRF/CQ)' },
            ]}
          />
        </Field>
        {e.rateControl === 'cqp' ? (
          <Field label="Quality (lower = better, 16–23 typical)">
            <NumberInput value={e.cq} min={0} max={51} onChange={(v) => set({ cq: v })} />
          </Field>
        ) : (
          <Field label="Video bitrate (kbps)">
            <NumberInput value={e.videoBitrate} min={200} max={200000} step={100} onChange={(v) => set({ videoBitrate: v })} />
          </Field>
        )}
      </div>
      {e.rateControl === 'vbr' && (
        <Field label="Max bitrate (kbps)">
          <NumberInput value={e.maxBitrate} min={e.videoBitrate} max={400000} step={100} onChange={(v) => set({ maxBitrate: v })} />
        </Field>
      )}
      <div className="field-row">
        <Field label="Preset">
          <Select<QualityPreset> value={e.preset} onChange={(v) => set({ preset: v })} options={(Object.keys(PRESET_LABELS) as QualityPreset[]).map((k) => ({ value: k, label: PRESET_LABELS[k] }))} />
        </Field>
        <Field label="Keyframe interval (s)" help="2 s is required by YouTube, Facebook and Twitch.">
          <NumberInput value={e.keyframeSec} min={1} max={10} onChange={(v) => set({ keyframeSec: v })} />
        </Field>
      </div>
      <div className="field-row three">
        <Field label="Profile">
          <Select
            value={encoderCodec(e.encoder) === 'hevc' ? 'main' : e.profile}
            onChange={(v) => set({ profile: v as EncoderSettings['profile'] })}
            options={encoderCodec(e.encoder) === 'hevc' ? [{ value: 'main', label: 'main' }] : [{ value: 'high', label: 'high' }, { value: 'main', label: 'main' }, { value: 'baseline', label: 'baseline' }]}
          />
        </Field>
        <Field label="B-frames">
          <NumberInput value={e.bframes} min={0} max={4} onChange={(v) => set({ bframes: v })} />
        </Field>
        <Field label="Audio bitrate (kbps)">
          <Select value={e.audioBitrate} onChange={(v) => set({ audioBitrate: v })} options={[96, 128, 160, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps AAC` }))} />
        </Field>
      </div>
    </fieldset>
  );
}

function OutputTab({ d, set, locked }: { d: Draft; set: SetDraft; locked: boolean }) {
  const st = useStore.getState();
  const [refreshing, setRefreshing] = useState(false);
  const rec = d.output.recording;
  return (
    <>
      <h3 className="section-title">Output</h3>
      <p className="section-sub">Encoding quality for streaming, recording and the replay buffer.</p>
      {locked && <div className="callout info">Encoder settings can't be changed while streaming, recording or running the replay buffer.</div>}
      <h4>Quick quality presets (streaming)</h4>
      <div className="inline wrap" style={{ marginBottom: 12 }}>
        {QUALITY_PRESETS.map((p) => (
          <button
            key={p.label}
            className="btn small"
            disabled={locked}
            onClick={() =>
              set((x) => {
                x.video.outputWidth = p.width;
                x.video.outputHeight = p.height;
                if (x.video.baseWidth < p.width || x.video.baseHeight < p.height || x.video.baseWidth / x.video.baseHeight !== p.width / p.height) {
                  x.video.baseWidth = p.width;
                  x.video.baseHeight = p.height;
                }
                x.video.fpsNum = p.fps;
                x.video.fpsDen = 1;
                x.output.stream.videoBitrate = p.kbps;
                x.output.stream.rateControl = 'cbr';
                x.output.stream.keyframeSec = 2;
              })
            }
          >
            {p.label} · {(p.kbps / 1000).toFixed(1)} Mbps
          </button>
        ))}
      </div>
      <h4>Streaming</h4>
      <EncoderFields value={d.output.stream} allowHevc={false} disabled={locked} onChange={(e) => set((x) => (x.output.stream = e))} />
      <button
        className="btn small"
        disabled={refreshing}
        onClick={() => {
          setRefreshing(true);
          void api.encoders
            .list(true)
            .then((l) => useStore.setState({ encoders: l }))
            .catch((err: Error) => st.notify('error', err.message))
            .finally(() => setRefreshing(false));
        }}
      >
        <RefreshCw size={13} /> {refreshing ? 'Testing encoders…' : 'Re-detect hardware encoders'}
      </button>

      <h4>Recording</h4>
      <Field label="Recording folder" help="Leave empty to use your Videos folder.">
        <FileInput directory value={rec.path} onChange={(p) => set((x) => (x.output.recording.path = p))} placeholder="Videos/Streamzar" />
      </Field>
      <div className="field-row">
        <Field label="Format" help="MKV and fragmented MP4 survive crashes and power loss.">
          <Select<RecordingFormat> value={rec.format} onChange={(v) => set((x) => (x.output.recording.format = v))} options={(Object.keys(RECORDING_FORMAT_LABELS) as RecordingFormat[]).map((k) => ({ value: k, label: RECORDING_FORMAT_LABELS[k] }))} />
        </Field>
        <Field label="Quality">
          <Select<RecordingQuality>
            value={rec.quality}
            onChange={(v) => set((x) => (x.output.recording.quality = v))}
            options={[
              { value: 'stream', label: 'Same as stream (no extra encoding)' },
              { value: 'high', label: 'High quality, medium file size' },
              { value: 'indistinguishable', label: 'Indistinguishable quality, large files' },
              { value: 'custom', label: 'Custom encoder settings' },
            ]}
          />
        </Field>
      </div>
      {rec.quality === 'custom' && (
        <div className="card">
          <EncoderFields value={rec.encoder} allowHevc disabled={locked} onChange={(e) => set((x) => (x.output.recording.encoder = e))} />
        </div>
      )}
      <Field label="File name format" help="%Y year, %m month, %d day, %H hour, %M minute, %S second">
        <TextInput value={rec.filenameFormat} onChange={(v) => set((x) => (x.output.recording.filenameFormat = v))} />
      </Field>
      <button
        className="btn small"
        onClick={() =>
          void api.files.openFile({ title: 'Choose a recording to convert to MP4', filters: [{ name: 'Recordings', extensions: ['mkv', 'flv', 'mov', 'ts', 'webm'] }] }).then((p) => {
            if (!p) return;
            st.notify('info', 'Converting to MP4…');
            void api.files
              .remux(p)
              .then((out) => st.notify('success', 'Converted to MP4', { label: 'Show', run: () => void api.files.showItemInFolder(out) }))
              .catch((e: Error) => st.notify('error', `Remux failed: ${e.message}`));
          })
        }
      >
        Remux recording to MP4…
      </button>

      <h4>Replay buffer</h4>
      <div className="field-row">
        <Field label="Keep the last (seconds)" help="Uses the recording encoder. Memory ≈ bitrate × duration.">
          <NumberInput value={d.output.replayBuffer.durationSec} min={5} max={600} onChange={(v) => set((x) => (x.output.replayBuffer.durationSec = v))} />
        </Field>
        <Field label="Saved replay format">
          <Select<RecordingFormat> value={d.output.replayBuffer.format} onChange={(v) => set((x) => (x.output.replayBuffer.format = v))} options={(Object.keys(RECORDING_FORMAT_LABELS) as RecordingFormat[]).map((k) => ({ value: k, label: RECORDING_FORMAT_LABELS[k] }))} />
        </Field>
      </div>
    </>
  );
}

const BASE_RES = ['3840x2160', '2560x1440', '1920x1080', '1600x900', '1280x720', '1080x1920', '720x1280'];
const FPS = [
  { v: '24/1', l: '24' },
  { v: '25/1', l: '25' },
  { v: '30000/1001', l: '29.97' },
  { v: '30/1', l: '30' },
  { v: '48/1', l: '48' },
  { v: '50/1', l: '50' },
  { v: '60000/1001', l: '59.94' },
  { v: '60/1', l: '60' },
];

function VideoTab({ d, set, locked }: { d: Draft; set: SetDraft; locked: boolean }) {
  const v = d.video;
  const baseKey = `${v.baseWidth}x${v.baseHeight}`;
  const scales = [1, 1.25, 1.5, 2, 2.5, 3].map((f) => normalizeOutputSize(v.baseWidth / f, v.baseHeight / f)).map((s) => `${s.width}x${s.height}`);
  const outKey = `${v.outputWidth}x${v.outputHeight}`;
  const outOptions = [...new Set([...scales, outKey])];
  const fpsKey = `${v.fpsNum}/${v.fpsDen}`;
  return (
    <>
      <h3 className="section-title">Video</h3>
      <p className="section-sub">Canvas size, output resolution and frame rate.</p>
      {locked && <div className="callout info">Video settings can't be changed while an output is active.</div>}
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field-row">
          <Field label="Base (canvas) resolution" help="The size you design your scenes in. Usually your monitor resolution.">
            <Select
              value={BASE_RES.includes(baseKey) ? baseKey : 'custom'}
              onChange={(k) => {
                if (k === 'custom') return;
                const [w, h] = k.split('x').map(Number);
                set((x) => {
                  x.video.baseWidth = w;
                  x.video.baseHeight = h;
                  const o = normalizeOutputSize(w, h);
                  x.video.outputWidth = o.width;
                  x.video.outputHeight = o.height;
                });
              }}
              options={[...BASE_RES.map((r) => ({ value: r, label: r.replace('x', '×') })), { value: 'custom', label: 'Custom…' }]}
            />
          </Field>
          <Field label="Custom base size">
            <div className="inline">
              <NumberInput value={v.baseWidth} min={64} max={7680} onChange={(n) => set((x) => (x.video.baseWidth = n))} />
              <span>×</span>
              <NumberInput value={v.baseHeight} min={64} max={4320} onChange={(n) => set((x) => (x.video.baseHeight = n))} />
            </div>
          </Field>
        </div>
        <div className="field-row">
          <Field label="Output (scaled) resolution" help="What viewers receive. Lower it if your upload speed or GPU struggles.">
            <Select
              value={outKey}
              onChange={(k) => {
                const [w, h] = k.split('x').map(Number);
                set((x) => {
                  x.video.outputWidth = w;
                  x.video.outputHeight = h;
                });
              }}
              options={outOptions.map((r) => ({ value: r, label: r.replace('x', '×') }))}
            />
          </Field>
          <Field label="Downscale filter">
            <Select
              value={v.scaleFilter}
              onChange={(f) => set((x) => (x.video.scaleFilter = f))}
              options={[
                { value: 'bilinear', label: 'Bilinear (fastest)' },
                { value: 'bicubic', label: 'Bicubic (sharp, recommended)' },
                { value: 'lanczos', label: 'Lanczos (sharpest)' },
              ]}
            />
          </Field>
        </div>
        <Field label="Frame rate (FPS)" help="60 fps looks smoother for games; 30 fps uses half the bandwidth.">
          <Select
            value={FPS.some((f) => f.v === fpsKey) ? fpsKey : '30/1'}
            onChange={(k) => {
              const [n, den] = k.split('/').map(Number);
              set((x) => {
                x.video.fpsNum = n;
                x.video.fpsDen = den;
              });
            }}
            options={FPS.map((f) => ({ value: f.v, label: f.l }))}
          />
        </Field>
      </fieldset>
    </>
  );
}

function AudioTab({ d, set }: { d: Draft; set: SetDraft }) {
  const st = useStore.getState();
  const collection = useStore((s) => s.collection);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((l) => setOuts(l.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default')));
  }, []);
  const globals = collection.globalAudioSourceIds.map((id) => collection.sources.find((s) => s.id === id)).filter(Boolean);
  const addGlobal = (type: 'audio_input' | 'audio_output') => {
    const src = (type === 'audio_output' ? createSource('audio_output', 'Desktop Audio') : createSource('audio_input', 'Mic/Aux')) as Source;
    const names = collection.sources.map((s) => s.name);
    let name = src.name;
    for (let i = 2; names.includes(name); i++) name = `${src.name} ${i}`;
    src.name = name;
    st.mutate((c) => {
      c.sources.push(src);
      c.globalAudioSourceIds.push(src.id);
    });
  };
  return (
    <>
      <h3 className="section-title">Audio</h3>
      <p className="section-sub">Global audio devices are heard in every scene.</p>
      <div className="field-row">
        <Field label="Sample rate" help="Takes effect after restarting Streamzar.">
          <Select value={d.audio.sampleRate} onChange={(v) => set((x) => (x.audio.sampleRate = v))} options={[{ value: 48000, label: '48 kHz (recommended)' }, { value: 44100, label: '44.1 kHz' }]} />
        </Field>
        <Field label="Monitoring device" help="Where 'monitored' sources are played (headphones).">
          <Select value={d.audio.monitoringDeviceId} onChange={(v) => set((x) => (x.audio.monitoringDeviceId = v))} options={[{ value: '', label: 'System default' }, ...outs.map((o, i) => ({ value: o.deviceId, label: o.label || `Output ${i + 1}` }))]} />
        </Field>
      </div>
      <h4>Global audio sources</h4>
      {globals.map(
        (g) =>
          g && (
            <div key={g.id} className="row" style={{ cursor: 'default' }}>
              <span className="name">{g.name}</span>
              <button className="btn small" onClick={() => st.openDialog({ kind: 'properties', sourceId: g.id })}>
                Properties
              </button>
              <button className="icon-btn danger" title="Remove" onClick={() => st.removeSource(g.id)}>
                <X size={14} />
              </button>
            </div>
          ),
      )}
      <div className="inline" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => addGlobal('audio_output')}>
          + Desktop audio
        </button>
        <button className="btn small" onClick={() => addGlobal('audio_input')}>
          + Microphone / input
        </button>
      </div>
    </>
  );
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  PrintScreen: 'PrintScreen',
  Pause: 'MediaPlayPause',
};

/** Convert a keyboard event to an Electron accelerator string, or null for lone modifiers. */
export function eventToAccelerator(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else if (KEY_NAMES[code]) key = KEY_NAMES[code];
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push(api.platform === 'darwin' ? 'Command' : 'Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function HotkeyInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline">
      <input
        className="input kbd-input"
        readOnly
        value={props.value}
        placeholder="Click and press keys"
        onKeyDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Backspace' || e.key === 'Escape') {
            props.onChange('');
            return;
          }
          const acc = eventToAccelerator(e);
          if (acc) props.onChange(acc);
        }}
      />
    </div>
  );
}

function HotkeysTab({ d, set }: { d: Draft; set: SetDraft }) {
  const collection = useStore((s) => s.collection);
  const rows: { action: string; label: string }[] = [
    ...Object.entries(HOTKEY_LABELS).map(([action, label]) => ({ action, label })),
    ...collection.scenes.map((s) => ({ action: `scene:${s.id}`, label: `Switch to scene “${s.name}”` })),
    ...collection.sources.filter((s) => ['audio_input', 'audio_output', 'media', 'browser', 'alert_box'].includes(s.type)).map((s) => ({ action: `mute:${s.id}`, label: `Mute / unmute “${s.name}”` })),
  ];
  const counts = new Map<string, number>();
  for (const v of Object.values(d.hotkeys)) if (v) counts.set(v.toLowerCase(), (counts.get(v.toLowerCase()) ?? 0) + 1);
  return (
    <>
      <h3 className="section-title">Hotkeys</h3>
      <p className="section-sub">Global shortcuts work even while a game has focus. Click a field and press a key combination; Backspace clears it.</p>
      {rows.map((r) => {
        const v = d.hotkeys[r.action] ?? '';
        const dup = !!v && (counts.get(v.toLowerCase()) ?? 0) > 1;
        return (
          <div key={r.action} className={`hotkey-row ${dup ? 'bad' : ''}`} title={dup ? 'This key combination is used twice' : undefined}>
            <span>{r.label}</span>
            <HotkeyInput value={v} onChange={(nv) => set((x) => (x.hotkeys = { ...x.hotkeys, [r.action]: nv }))} />
            <button className="icon-btn" title="Clear" onClick={() => set((x) => (x.hotkeys = { ...x.hotkeys, [r.action]: '' }))}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </>
  );
}

function AlertsTab({ d, set }: { d: Draft; set: SetDraft }) {
  const [type, setType] = useState<AlertType>('follow');
  const c = d.alerts.types[type];
  const setC = (patch: Partial<typeof c>) => set((x) => Object.assign(x.alerts.types[type], patch));
  const test = () => {
    const eng = engineOrNull();
    if (!eng) return;
    // apply the draft so the test uses unsaved changes
    eng.alerts.setSettings(d.alerts);
    eng.alerts.push({ id: uid('test'), type, platform: 'test', name: 'TestUser', amount: 5, currency: 'USD', formattedAmount: type === 'bits' ? '500 bits' : formatMoney(5), message: 'This is a test alert!', months: 3, count: 5, time: Date.now() });
  };
  return (
    <>
      <h3 className="section-title">Alerts</h3>
      <p className="section-sub">How each event looks and sounds in your Alert Box sources.</p>
      <div className="field-row">
        <Field label="Global alert volume">
          <Slider value={Math.round(d.alerts.globalVolume * 100)} min={0} max={100} onChange={(v) => set((x) => (x.alerts.globalVolume = v / 100))} format={(v) => `${v}%`} />
        </Field>
        <Field label="Pause between alerts (ms)">
          <NumberInput value={d.alerts.delayBetweenMs} min={0} max={30000} step={100} onChange={(v) => set((x) => (x.alerts.delayBetweenMs = v))} />
        </Field>
      </div>
      <div className="tabs" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {ALERT_TYPES.map((t) => (
          <div key={t} className={`tab ${t === type ? 'active' : ''}`} onClick={() => setType(t)}>
            {ALERT_TYPE_LABELS[t]}
            {!d.alerts.types[t].enabled && <span className="muted">(off)</span>}
          </div>
        ))}
      </div>
      <div className="inline" style={{ marginBottom: 8 }}>
        <Check checked={c.enabled} onChange={(b) => setC({ enabled: b })} label={`Show ${ALERT_TYPE_LABELS[type]} alerts`} />
        <span style={{ flex: 1 }} />
        <button className="btn small primary" onClick={test}>
          <Play size={13} /> Test
        </button>
      </div>
      <Field label="Message template" help="Placeholders: {name} {amount} {months} {count} {message}">
        <TextInput value={c.messageTemplate} onChange={(v) => setC({ messageTemplate: v })} />
      </Field>
      <div className="field-row">
        <Field label="Image / GIF / video">
          <FileInput value={c.imagePath} onChange={(p) => setC({ imagePath: p })} filters={ALERT_MEDIA_FILTER} />
        </Field>
        <Field label="Sound">
          <FileInput value={c.soundPath} onChange={(p) => setC({ soundPath: p })} filters={AUDIO_FILTER} />
        </Field>
      </div>
      <div className="field-row three">
        <Field label="Sound volume">
          <Slider value={Math.round(c.soundVolume * 100)} min={0} max={100} onChange={(v) => setC({ soundVolume: v / 100 })} format={(v) => `${v}%`} />
        </Field>
        <Field label="Duration (ms)">
          <NumberInput value={c.durationMs} min={1000} max={60000} step={500} onChange={(v) => setC({ durationMs: v })} />
        </Field>
        <Field label="Layout">
          <Select value={c.layout} onChange={(v) => setC({ layout: v })} options={[{ value: 'above', label: 'Image above text' }, { value: 'side', label: 'Image beside text' }, { value: 'text_over', label: 'Text over image' }]} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Animation in">
          <Select value={c.animationIn} onChange={(v) => setC({ animationIn: v })} options={[{ value: 'bounce', label: 'Bounce' }, { value: 'fade', label: 'Fade' }, { value: 'zoom', label: 'Zoom' }, { value: 'slide_down', label: 'Slide down' }, { value: 'slide_up', label: 'Slide up' }]} />
        </Field>
        <Field label="Animation out">
          <Select value={c.animationOut} onChange={(v) => setC({ animationOut: v })} options={[{ value: 'fade', label: 'Fade' }, { value: 'zoom', label: 'Zoom' }, { value: 'slide_down', label: 'Slide down' }, { value: 'slide_up', label: 'Slide up' }]} />
        </Field>
      </div>
      <div className="field-row three">
        <Field label="Text color">
          <ColorInput value={c.textColor} onChange={(v) => setC({ textColor: v })} />
        </Field>
        <Field label="Highlight color (name / amount)">
          <ColorInput value={c.highlightColor} onChange={(v) => setC({ highlightColor: v })} />
        </Field>
        <Field label="Font size">
          <NumberInput value={c.fontSize} min={10} max={200} onChange={(v) => setC({ fontSize: v })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Font">
          <TextInput value={c.fontFamily} onChange={(v) => setC({ fontFamily: v })} />
        </Field>
        <Field label="Minimum amount to alert" help="0 = always (donations, bits, Super Chats)">
          <NumberInput value={c.minAmount} min={0} onChange={(v) => setC({ minAmount: v })} />
        </Field>
      </div>
      <Check checked={c.showUserMessage} onChange={(b) => setC({ showUserMessage: b })} label="Show the viewer's message" />
    </>
  );
}

function ChatTab({ d, set }: { d: Draft; set: SetDraft }) {
  const i = d.integrations;
  return (
    <>
      <h3 className="section-title">Chat &amp; platform events</h3>
      <p className="section-sub">Read chat from every platform in one place, show it on stream with a Chat Box, and trigger alerts from subs, bits, raids and Super Chats.</p>
      <div className="card">
        <Check checked={i.twitch.enabled} onChange={(b) => set((x) => (x.integrations.twitch.enabled = b))} label={<b>Twitch</b>} />
        <div className="field-row">
          <Field label="Channel name">
            <TextInput value={i.twitch.channel} onChange={(v) => set((x) => (x.integrations.twitch.channel = v))} placeholder="yourchannel" />
          </Field>
          <Field label="Username (to send messages)">
            <TextInput value={i.twitch.username} onChange={(v) => set((x) => (x.integrations.twitch.username = v))} />
          </Field>
        </div>
        <Field label="OAuth token (optional, to send messages)" help="Reading chat, subs, bits and raids works without it. Create a chat token with the chat:read and chat:edit scopes.">
          <SecretInput value={i.twitch.oauthToken} onChange={(v) => set((x) => (x.integrations.twitch.oauthToken = v))} placeholder="oauth:…" />
        </Field>
      </div>
      <div className="card">
        <Check checked={i.youtube.enabled} onChange={(b) => set((x) => (x.integrations.youtube.enabled = b))} label={<b>YouTube</b>} />
        <Field label="API key" help="Google Cloud console → enable 'YouTube Data API v3' → Credentials → API key. Reads public live chat and Super Chats.">
          <SecretInput value={i.youtube.apiKey} onChange={(v) => set((x) => (x.integrations.youtube.apiKey = v))} />
        </Field>
        <div className="field-row">
          <Field label="Channel ID (finds your current live stream)">
            <TextInput value={i.youtube.channelId} onChange={(v) => set((x) => (x.integrations.youtube.channelId = v))} placeholder="UC…" />
          </Field>
          <Field label="…or live video ID / URL">
            <TextInput value={i.youtube.videoId} onChange={(v) => set((x) => (x.integrations.youtube.videoId = v))} />
          </Field>
        </div>
        <Field label="OAuth access token (optional, to send messages)">
          <SecretInput value={i.youtube.oauthToken} onChange={(v) => set((x) => (x.integrations.youtube.oauthToken = v))} />
        </Field>
      </div>
      <div className="card">
        <Check checked={i.facebook.enabled} onChange={(b) => set((x) => (x.integrations.facebook.enabled = b))} label={<b>Facebook</b>} />
        <div className="field-row">
          <Field label="Live video ID">
            <TextInput value={i.facebook.liveVideoId} onChange={(v) => set((x) => (x.integrations.facebook.liveVideoId = v))} />
          </Field>
          <Field label="Page access token" help="Needs permission to read the live video's comments (Graph API).">
            <SecretInput value={i.facebook.accessToken} onChange={(v) => set((x) => (x.integrations.facebook.accessToken = v))} />
          </Field>
        </div>
      </div>
      <div className="callout info">Follower alerts need platform webhooks; you can send any event to Streamzar's local webhook (see Remote &amp; Webhooks).</div>
    </>
  );
}

function RemoteTab({ d, set }: { d: Draft; set: SetDraft }) {
  const st = useStore.getState();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    void api.remote.getInfo().then(setInfo);
  }, [d.server]);
  const copy = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => st.notify('success', 'Copied to clipboard'));
  };
  const base = `http://127.0.0.1:${d.server.port}`;
  const alertUrl = `${base}/api/alert?token=${d.server.token}`;
  const kofiUrl = `${base}/api/kofi?token=${d.server.token}&verify=YOUR_KOFI_VERIFICATION_TOKEN`;
  const curl = `curl -X POST "${alertUrl}" -H "Content-Type: application/json" -d '{"type":"donation","name":"Alex","amount":5,"currency":"USD","message":"Great stream!"}'`;
  return (
    <>
      <h3 className="section-title">Remote control &amp; webhooks</h3>
      <p className="section-sub">Control Streamzar from your phone and trigger alerts from donation tools.</p>
      <Check checked={d.server.enabled} onChange={(b) => set((x) => (x.server.enabled = b))} label="Enable the local server" />
      <div className="field-row">
        <Field label="Port">
          <NumberInput value={d.server.port} min={1024} max={65535} onChange={(v) => set((x) => (x.server.port = v))} />
        </Field>
        <Field label=" ">
          <Check checked={d.server.allowLan} onChange={(b) => set((x) => (x.server.allowLan = b))} label="Allow devices on my network (phone remote)" />
        </Field>
      </div>
      {info?.error && <div className="callout error">{info.error}</div>}
      {info?.running && (
        <Field label="Remote control links (open on your phone, keep them private)">
          {info.urls.map((u) => (
            <div key={u} className="inline" style={{ marginBottom: 4 }}>
              <code className="mono" style={{ flex: 1 }}>
                {u}
              </code>
              <button className="icon-btn" title="Copy" onClick={() => copy(u)}>
                <Copy size={14} />
              </button>
              <button className="icon-btn" title="Open" onClick={() => void api.files.openExternal(u)}>
                <ExternalLink size={14} />
              </button>
            </div>
          ))}
        </Field>
      )}
      <button
        className="btn small"
        onClick={() =>
          void api.remote.regenerateToken().then((i) => {
            setInfo(i);
            st.notify('success', 'New token generated. Old links stop working.');
          })
        }
      >
        <RefreshCw size={13} /> Regenerate secret token
      </button>
      <h4>Alert webhook</h4>
      <p className="muted">Send JSON to trigger an alert. type: follow, subscription, gift_sub, donation, bits, raid, superchat, membership, stars.</p>
      <div className="inline" style={{ marginBottom: 8 }}>
        <code className="mono" style={{ flex: 1 }}>
          {curl}
        </code>
        <button className="icon-btn" title="Copy" onClick={() => copy(curl)}>
          <Copy size={14} />
        </button>
      </div>
      <Field label="Ko-fi webhook URL" help="Ko-fi sends to the internet: expose this port with a tunnel (e.g. Cloudflare Tunnel) and enable LAN access.">
        <div className="inline">
          <code className="mono" style={{ flex: 1 }}>
            {kofiUrl}
          </code>
          <button className="icon-btn" title="Copy" onClick={() => copy(kofiUrl)}>
            <Copy size={14} />
          </button>
        </div>
      </Field>
    </>
  );
}

function AdvancedTab({ d, set }: { d: Draft; set: SetDraft }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.system.info().then(setInfo);
  }, [d.advanced.ffmpegPath]);
  return (
    <>
      <h3 className="section-title">Advanced</h3>
      <p className="section-sub">For troubleshooting and power users.</p>
      <Field label="Custom FFmpeg binary" help="Leave empty to use the FFmpeg bundled with Streamzar.">
        <FileInput value={d.advanced.ffmpegPath} onChange={(p) => set((x) => (x.advanced.ffmpegPath = p))} />
      </Field>
      {info && (
        <div className="card mono" style={{ fontSize: 12 }}>
          FFmpeg {info.ffmpegVersion}: {info.ffmpegPath || 'not found'}
          <br />
          Streamzar {info.version} · Electron {info.electron} · {info.platform}/{info.arch}
          <br />
          Data folder: {info.userData}
        </div>
      )}
      <Field label="Encoder process priority">
        <Select value={d.advanced.processPriority} onChange={(v) => set((x) => (x.advanced.processPriority = v))} options={[{ value: 'normal', label: 'Normal' }, { value: 'above_normal', label: 'Above normal (recommended)' }, { value: 'high', label: 'High' }]} />
      </Field>
      <Check checked={d.advanced.hardwareAcceleration} onChange={(b) => set((x) => (x.advanced.hardwareAcceleration = b))} label="GPU acceleration for the compositor (restart required)" />
      <Check checked={d.advanced.verboseLogging} onChange={(b) => set((x) => (x.advanced.verboseLogging = b))} label="Verbose FFmpeg logging" />
      <button className="btn small" onClick={() => void api.system.openLogs()}>
        <FolderOpen size={13} /> Open log folder
      </button>
    </>
  );
}

function GeneralTab({ d, set }: { d: Draft; set: SetDraft }) {
  const g = d.general;
  return (
    <>
      <h3 className="section-title">General</h3>
      <p className="section-sub">Behaviour and appearance.</p>
      <Field label="Theme">
        <Select value={g.theme} onChange={(v) => set((x) => (x.general.theme = v))} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
      </Field>
      <Check checked={d.stream.confirmStart} onChange={(b) => set((x) => (x.stream.confirmStart = b))} label="Show the Go Live window before starting a stream" />
      <Check checked={d.stream.confirmStop} onChange={(b) => set((x) => (x.stream.confirmStop = b))} label="Ask before ending a stream" />
      <Check checked={g.recordWhenStreaming} onChange={(b) => set((x) => (x.general.recordWhenStreaming = b))} label="Record automatically when streaming" />
      <Check checked={g.keepRecordingWhenStreamStops} onChange={(b) => set((x) => (x.general.keepRecordingWhenStreamStops = b))} label="Keep recording when the stream stops" />
      <Check checked={g.replayBufferWhileStreaming} onChange={(b) => set((x) => (x.general.replayBufferWhileStreaming = b))} label="Start the replay buffer automatically when streaming" />
      <h4>Editor</h4>
      <Check checked={g.snapping} onChange={(b) => set((x) => (x.general.snapping = b))} label="Snap sources to edges and other sources (hold Ctrl to bypass)" />
      <Field label="Snap distance (px)">
        <NumberInput value={g.snapDistance} min={1} max={50} onChange={(v) => set((x) => (x.general.snapDistance = v))} />
      </Field>
    </>
  );
}

export function SettingsDialog(props: { tab?: string }) {
  const st = useStore.getState();
  const settings = useStore((s) => s.settings);
  const output = useStore((s) => s.output);
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t.id === props.tab)?.id ?? 'general') as Tab);
  const [draft, setDraft] = useState<Draft>(() => deepClone(settings));
  const [saving, setSaving] = useState(false);
  const locked = output.streaming || output.recording || output.replayBuffer || output.streamStarting;
  const set: SetDraft = (fn) =>
    setDraft((prev) => {
      const next = deepClone(prev);
      fn(next);
      return next;
    });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = async (close: boolean) => {
    setSaving(true);
    try {
      const restartNeeded = draft.audio.sampleRate !== settings.audio.sampleRate || draft.advanced.hardwareAcceleration !== settings.advanced.hardwareAcceleration;
      const chatChanged = JSON.stringify(draft.integrations) !== JSON.stringify(settings.integrations);
      await st.setSettings(draft);
      setDraft(deepClone(useStore.getState().settings));
      if (restartNeeded) st.notify('warning', 'Restart Streamzar to apply the audio sample rate / GPU acceleration change.');
      if (chatChanged) {
        const ints = draft.integrations;
        if (ints.twitch.enabled || ints.youtube.enabled || ints.facebook.enabled) void api.chat.connect().catch((e: Error) => st.notify('error', e.message));
        else void api.chat.disconnect();
      }
      engineOrNull()?.alerts.setSettings(useStore.getState().settings.alerts);
      if (close) st.openDialog(null);
    } catch (e) {
      st.notify('error', `Could not save settings: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    engineOrNull()?.alerts.setSettings(settings.alerts);
    st.openDialog(null);
  };
  return (
    <Modal
      title="Settings"
      size="xwide"
      onClose={cancel}
      bodyStyle={{ padding: 0 }}
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn" disabled={!dirty || saving} onClick={() => void save(false)}>
            Apply
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save(true)}>
            Done
          </button>
        </>
      }
    >
      <div className="split">
        <div className="nav">
          {TABS.map((t) => (
            <div key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </div>
          ))}
        </div>
        <div className="content">
          {tab === 'general' && <GeneralTab d={draft} set={set} />}
          {tab === 'stream' && (
            <>
              <h3 className="section-title">Stream destinations</h3>
              <p className="section-sub">Every enabled destination receives your stream at the same time (multistreaming).</p>
              <DestinationsEditor value={draft.stream.destinations} onChange={(v) => set((x) => (x.stream.destinations = v))} />
              <h4>Connection</h4>
              <Check checked={draft.stream.autoReconnect} onChange={(b) => set((x) => (x.stream.autoReconnect = b))} label="Automatically reconnect if a connection drops" />
              <div className="field-row">
                <Field label="Retry delay (s)">
                  <NumberInput value={draft.stream.reconnectDelaySec} min={1} max={120} onChange={(v) => set((x) => (x.stream.reconnectDelaySec = v))} />
                </Field>
                <Field label="Maximum retries">
                  <NumberInput value={draft.stream.maxRetries} min={0} max={1000} onChange={(v) => set((x) => (x.stream.maxRetries = v))} />
                </Field>
              </div>
              <Field label="Stream delay (s)" help="Viewers see everything this many seconds later (prevents stream sniping). 0 = off.">
                <NumberInput value={draft.stream.delaySec} min={0} max={600} onChange={(v) => set((x) => (x.stream.delaySec = v))} />
              </Field>
            </>
          )}
          {tab === 'output' && <OutputTab d={draft} set={set} locked={locked} />}
          {tab === 'video' && <VideoTab d={draft} set={set} locked={locked} />}
          {tab === 'audio' && <AudioTab d={draft} set={set} />}
          {tab === 'hotkeys' && <HotkeysTab d={draft} set={set} />}
          {tab === 'alerts' && <AlertsTab d={draft} set={set} />}
          {tab === 'chat' && <ChatTab d={draft} set={set} />}
          {tab === 'remote' && <RemoteTab d={draft} set={set} />}
          {tab === 'advanced' && <AdvancedTab d={draft} set={set} />}
        </div>
      </div>
    </Modal>
  );
}
