import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import type { AlertType, CaptureSourceInfo, Source, SourceOf, StreamLabelKind, TextStyle } from '@shared/types';
import { ALERT_TYPE_LABELS, ALERT_TYPES, SOURCE_TYPE_INFO } from '@shared/defaults';
import { deepClone } from '@shared/util';
import { api } from '../../api';
import { scenesContaining, useStore } from '../../state/store';
import { engineOrNull } from '../../state/controller';
import { Check, ColorInput, Field, FileInput, IMAGE_FILTER, Modal, NumberInput, Select, Slider, TextInput, VIDEO_FILTER } from '../ui';

type Patch = Record<string, unknown>;

let fontCache: string[] | null = null;
async function systemFonts(): Promise<string[]> {
  if (fontCache) return fontCache;
  const common = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Helvetica', 'Impact', 'Inter', 'Montserrat', 'Roboto', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (q) {
      const fonts = await q();
      fontCache = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      return fontCache;
    }
  } catch {
    /* permission denied */
  }
  fontCache = common;
  return common;
}

export function TextStyleFields(props: { value: TextStyle; onChange: (p: Partial<TextStyle>) => void; compact?: boolean }) {
  const v = props.value;
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    void systemFonts().then(setFonts);
  }, []);
  return (
    <>
      <div className="field-row">
        <Field label="Font">
          <input className="input" list="sz-fonts" value={v.fontFamily} onChange={(e) => props.onChange({ fontFamily: e.target.value })} />
          <datalist id="sz-fonts">
            {fonts.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label="Size">
          <NumberInput value={v.fontSize} min={6} max={400} onChange={(n) => props.onChange({ fontSize: n })} />
        </Field>
      </div>
      <div className="inline wrap">
        <Check checked={v.bold} onChange={(b) => props.onChange({ bold: b })} label="Bold" />
        <Check checked={v.italic} onChange={(b) => props.onChange({ italic: b })} label="Italic" />
        {!props.compact && <Check checked={v.underline} onChange={(b) => props.onChange({ underline: b })} label="Underline" />}
      </div>
      <div className="field-row">
        <Field label="Text color">
          <ColorInput value={v.color} onChange={(c) => props.onChange({ color: c })} />
        </Field>
        {!props.compact && (
          <Field label="Alignment">
            <Select value={v.align} onChange={(a) => props.onChange({ align: a })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
          </Field>
        )}
      </div>
      <Check checked={v.outline} onChange={(b) => props.onChange({ outline: b })} label="Outline" />
      {v.outline && (
        <div className="field-row">
          <Field label="Outline color">
            <ColorInput value={v.outlineColor} onChange={(c) => props.onChange({ outlineColor: c })} />
          </Field>
          <Field label="Outline width">
            <NumberInput value={v.outlineWidth} min={1} max={40} onChange={(n) => props.onChange({ outlineWidth: n })} />
          </Field>
        </div>
      )}
      <Check checked={v.shadow} onChange={(b) => props.onChange({ shadow: b })} label="Drop shadow" />
      {v.shadow && (
        <div className="field-row three">
          <Field label="Shadow color">
            <ColorInput value={v.shadowColor} onChange={(c) => props.onChange({ shadowColor: c })} />
          </Field>
          <Field label="Blur">
            <NumberInput value={v.shadowBlur} min={0} max={60} onChange={(n) => props.onChange({ shadowBlur: n })} />
          </Field>
          <Field label="Offset">
            <NumberInput value={v.shadowOffset} min={-40} max={40} onChange={(n) => props.onChange({ shadowOffset: n })} />
          </Field>
        </div>
      )}
    </>
  );
}

function SizeFields(props: { w: number; h: number; onChange: (p: Patch) => void; label?: string }) {
  return (
    <div className="field-row">
      <Field label={`${props.label ?? ''}Width`}>
        <NumberInput value={props.w} min={16} max={7680} onChange={(n) => props.onChange({ width: n })} />
      </Field>
      <Field label={`${props.label ?? ''}Height`}>
        <NumberInput value={props.h} min={16} max={4320} onChange={(n) => props.onChange({ height: n })} />
      </Field>
    </div>
  );
}

function BackgroundFields(props: { color: string; opacity: number; onChange: (p: Patch) => void }) {
  return (
    <div className="field-row">
      <Field label="Background color">
        <ColorInput value={props.color} onChange={(c) => props.onChange({ backgroundColor: c })} />
      </Field>
      <Field label="Background opacity">
        <Slider value={Math.round(props.opacity * 100)} min={0} max={100} onChange={(n) => props.onChange({ backgroundOpacity: n / 100 })} format={(n) => `${n}%`} />
      </Field>
    </div>
  );
}

function AlertTypesField(props: { value: AlertType[]; onChange: (v: AlertType[]) => void; help: string }) {
  return (
    <Field label="Show these event types" help={props.help}>
      <div className="inline wrap">
        {ALERT_TYPES.map((t) => (
          <Check
            key={t}
            label={ALERT_TYPE_LABELS[t]}
            checked={!props.value.length || props.value.includes(t)}
            onChange={(on) => {
              const all = props.value.length ? props.value : [...ALERT_TYPES];
              const next = on ? [...new Set([...all, t])] : all.filter((x) => x !== t);
              props.onChange(next.length === ALERT_TYPES.length ? [] : next);
            }}
          />
        ))}
      </div>
    </Field>
  );
}

function DevicePicker(props: { kind: 'videoinput' | 'audioinput'; value: string; onChange: (id: string, label: string) => void; allowDefault?: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const load = async () => {
    try {
      // Labels are only exposed after permission was granted once.
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.kind === props.kind && d.label)) {
        const s = await navigator.mediaDevices.getUserMedia(props.kind === 'videoinput' ? { video: true } : { audio: true }).catch(() => null);
        s?.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      setDevices(list.filter((d) => d.kind === props.kind && d.deviceId !== 'communications'));
    } catch {
      setDevices([]);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const options = devices.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `${props.kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}` }));
  if (props.allowDefault) options.unshift({ value: 'default', label: 'Default device' });
  if (props.value && !options.some((o) => o.value === props.value)) options.unshift({ value: props.value, label: 'Saved device (not connected)' });
  if (!options.length) options.push({ value: '', label: 'No devices found' });
  return (
    <div className="inline">
      <Select
        value={props.value || options[0].value}
        onChange={(id) => {
          const d = devices.find((x) => x.deviceId === id);
          props.onChange(id, d?.label ?? (id === 'default' ? 'Default' : ''));
        }}
        options={options}
      />
      <button className="btn" onClick={() => void load()} title="Refresh device list">
        <RefreshCw size={14} />
      </button>
    </div>
  );
}

function CapturePicker(props: { kind: 'screen' | 'window'; value: string; onChange: (s: CaptureSourceInfo) => void }) {
  const [list, setList] = useState<CaptureSourceInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    api.desktop
      .getSources([props.kind])
      .then(setList)
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(load, [props.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field
      label={
        <span className="inline">
          {props.kind === 'screen' ? 'Display' : 'Window'}
          <button className="btn small" onClick={load}>
            <RefreshCw size={12} /> Refresh
          </button>
        </span>
      }
      help={props.kind === 'window' ? 'Games running in exclusive full screen may need borderless/windowed mode to be captured. On macOS allow Screen Recording in System Settings → Privacy & Security.' : 'On macOS allow Screen Recording in System Settings → Privacy & Security.'}
    >
      {err && <div className="callout error">{err}</div>}
      {!list && !err && <div className="muted">Loading…</div>}
      {list && !list.length && <div className="muted">Nothing found.</div>}
      <div className="thumbs">
        {list?.map((s) => (
          <div key={s.id} className={`thumb ${s.id === props.value ? 'selected' : ''}`} onClick={() => props.onChange(s)} title={s.name}>
            {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div style={{ aspectRatio: '16/9', background: '#000', borderRadius: 4 }} />}
            <div className="n">{s.name}</div>
          </div>
        ))}
      </div>
    </Field>
  );
}

const RESOLUTIONS = [
  { value: '3840x2160', label: '3840×2160 (4K)' },
  { value: '2560x1440', label: '2560×1440' },
  { value: '1920x1080', label: '1920×1080 (1080p)' },
  { value: '1280x720', label: '1280×720 (720p)' },
  { value: '960x540', label: '960×540' },
  { value: '640x480', label: '640×480' },
];

const LABEL_KINDS: { value: StreamLabelKind; label: string; template: string; empty: string }[] = [
  { value: 'latest_follower', label: 'Latest follower', template: 'Latest follower: {name}', empty: 'Latest follower: —' },
  { value: 'latest_subscriber', label: 'Latest subscriber / member', template: 'Latest sub: {name}', empty: 'Latest sub: —' },
  { value: 'latest_donation', label: 'Latest donation', template: 'Latest tip: {name} ({amount})', empty: 'Latest tip: —' },
  { value: 'top_donation', label: 'Top donation', template: 'Top tip: {name} ({amount})', empty: 'Top tip: —' },
  { value: 'latest_cheer', label: 'Latest cheer (bits)', template: 'Latest cheer: {name} ({amount})', empty: 'Latest cheer: —' },
  { value: 'latest_raid', label: 'Latest raid', template: 'Latest raid: {name} ({count})', empty: 'Latest raid: —' },
  { value: 'latest_superchat', label: 'Latest Super Chat', template: 'Latest Super Chat: {name} ({amount})', empty: 'Latest Super Chat: —' },
  { value: 'latest_member', label: 'Latest YouTube member', template: 'Newest member: {name}', empty: 'Newest member: —' },
  { value: 'session_follower_count', label: 'Followers this stream', template: 'New followers: {count}', empty: '' },
  { value: 'session_subscriber_count', label: 'Subscribers this stream', template: 'New subs: {count}', empty: '' },
  { value: 'session_donation_total', label: 'Donations this stream', template: 'Tips today: {amount}', empty: '' },
  { value: 'viewer_count', label: 'Live viewer count', template: '👀 {count}', empty: '' },
];

function toLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Form(props: { source: Source; set: (p: Patch) => void }) {
  const { source: src, set } = props;
  const collection = useStore((s) => s.collection);
  switch (src.type) {
    case 'color': {
      const s = src.settings;
      return (
        <>
          <Field label="Color">
            <ColorInput value={s.color} onChange={(c) => set({ color: c })} />
          </Field>
          <SizeFields w={s.width} h={s.height} onChange={set} />
        </>
      );
    }
    case 'image':
      return (
        <Field label="Image file" help="PNG, JPG, GIF (animated), WebP, APNG or SVG.">
          <FileInput value={src.settings.path} onChange={(p) => set({ path: p })} filters={IMAGE_FILTER} />
        </Field>
      );
    case 'slideshow': {
      const s = src.settings;
      const move = (i: number, d: number) => {
        const p = [...s.paths];
        const [x] = p.splice(i, 1);
        p.splice(Math.max(0, Math.min(p.length, i + d)), 0, x);
        set({ paths: p });
      };
      return (
        <>
          <Field label="Images">
            <div className="card" style={{ maxHeight: 200, overflow: 'auto', padding: 4 }}>
              {s.paths.map((p, i) => (
                <div key={`${p}-${i}`} className="row" style={{ cursor: 'default' }}>
                  <span className="name mono" title={p}>
                    {p.split(/[\\/]/).pop()}
                  </span>
                  <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ChevronUp size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === s.paths.length - 1}>
                    <ChevronDown size={14} />
                  </button>
                  <button className="icon-btn danger" onClick={() => set({ paths: s.paths.filter((_, k) => k !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {!s.paths.length && <div className="muted" style={{ padding: 8 }}>No images yet.</div>}
            </div>
            <div>
              <button className="btn" onClick={() => void api.files.openFiles({ filters: IMAGE_FILTER }).then((ps) => ps.length && set({ paths: [...s.paths, ...ps] }))}>
                <Plus size={14} /> Add images
              </button>
            </div>
          </Field>
          <div className="field-row">
            <Field label="Time between slides (ms)">
              <NumberInput value={s.intervalMs} min={500} max={600000} step={100} onChange={(n) => set({ intervalMs: n })} />
            </Field>
            <Field label="Transition">
              <Select value={s.transition} onChange={(v) => set({ transition: v })} options={[{ value: 'fade', label: 'Fade' }, { value: 'cut', label: 'Cut' }]} />
            </Field>
          </div>
          {s.transition === 'fade' && (
            <Field label="Fade duration (ms)">
              <NumberInput value={s.transitionMs} min={0} max={10000} step={50} onChange={(n) => set({ transitionMs: n })} />
            </Field>
          )}
          <div className="inline wrap">
            <Check checked={s.loop} onChange={(b) => set({ loop: b })} label="Loop" />
            <Check checked={s.shuffle} onChange={(b) => set({ shuffle: b })} label="Shuffle" />
          </div>
          <SizeFields w={s.width} h={s.height} onChange={set} label="Bounding box " />
        </>
      );
    }
    case 'media': {
      const s = src.settings;
      return (
        <>
          <Field label="Media file" help="MP4 (H.264/AAC), WebM, MOV (H.264), MP3, WAV, OGG, FLAC, M4A.">
            <FileInput value={s.path} onChange={(p) => set({ path: p })} filters={VIDEO_FILTER} />
          </Field>
          <Check checked={s.loop} onChange={(b) => set({ loop: b })} label="Loop" />
          <Check checked={s.restartOnActivate} onChange={(b) => set({ restartOnActivate: b })} label="Restart playback when the source becomes active (and pause when hidden)" />
          <Field label="Speed">
            <Slider value={s.speedPercent} min={25} max={400} step={5} onChange={(n) => set({ speedPercent: n })} format={(n) => `${n}%`} />
          </Field>
        </>
      );
    }
    case 'text': {
      const s = src.settings;
      return (
        <>
          <Check checked={s.readFromFile} onChange={(b) => set({ readFromFile: b })} label="Read text from a file (updates live)" />
          {s.readFromFile ? (
            <Field label="Text file">
              <FileInput value={s.filePath} onChange={(p) => set({ filePath: p })} filters={[{ name: 'Text', extensions: ['txt', 'md', 'csv', 'json', 'log'] }]} />
            </Field>
          ) : (
            <Field label="Text">
              <textarea className="input text" rows={4} value={s.text} onChange={(e) => set({ text: e.target.value })} />
            </Field>
          )}
          <TextStyleFields value={s} onChange={set} />
          <BackgroundFields color={s.backgroundColor} opacity={s.backgroundOpacity} onChange={set} />
          <div className="field-row three">
            <Field label="Wrap width (0 = off)">
              <NumberInput value={s.wrapWidth} min={0} max={7680} onChange={(n) => set({ wrapWidth: n })} />
            </Field>
            <Field label="Padding">
              <NumberInput value={s.padding} min={0} max={400} onChange={(n) => set({ padding: n })} />
            </Field>
            <Field label="Line spacing">
              <NumberInput value={s.lineSpacing} min={0.8} max={4} step={0.1} onChange={(n) => set({ lineSpacing: n })} />
            </Field>
          </div>
        </>
      );
    }
    case 'browser': {
      const s = src.settings;
      return (
        <>
          <Field label="URL" help="Any web page or overlay/widget URL (e.g. alerts from other services).">
            <TextInput value={s.url} onChange={(v) => set({ url: v })} />
          </Field>
          <div className="field-row three">
            <Field label="Width">
              <NumberInput value={s.width} min={16} max={3840} onChange={(n) => set({ width: n })} />
            </Field>
            <Field label="Height">
              <NumberInput value={s.height} min={16} max={2160} onChange={(n) => set({ height: n })} />
            </Field>
            <Field label="FPS">
              <NumberInput value={s.fps} min={1} max={60} onChange={(n) => set({ fps: n })} />
            </Field>
          </div>
          <Field label="Custom CSS">
            <textarea className="input" rows={4} value={s.css} onChange={(e) => set({ css: e.target.value })} />
          </Field>
          <Check checked={s.captureAudio} onChange={(b) => set({ captureAudio: b })} label="Capture page audio into the mixer" />
          <button className="btn" onClick={() => void api.browserSources.refresh(src.id)}>
            <RefreshCw size={14} /> Refresh page
          </button>
        </>
      );
    }
    case 'video_capture': {
      const s = src.settings;
      return (
        <>
          <Field label="Device">
            <DevicePicker kind="videoinput" value={s.deviceId} onChange={(id, label) => set({ deviceId: id, deviceLabel: label })} />
          </Field>
          <div className="field-row">
            <Field label="Resolution" help="The camera picks the closest mode it supports.">
              <Select
                value={`${s.width}x${s.height}`}
                onChange={(v) => {
                  const [w, h] = v.split('x').map(Number);
                  set({ width: w, height: h });
                }}
                options={RESOLUTIONS.some((r) => r.value === `${s.width}x${s.height}`) ? RESOLUTIONS : [{ value: `${s.width}x${s.height}`, label: `${s.width}×${s.height}` }, ...RESOLUTIONS]}
              />
            </Field>
            <Field label="Frame rate">
              <Select value={s.fps} onChange={(v) => set({ fps: v })} options={[24, 25, 30, 50, 60].map((f) => ({ value: f, label: `${f} fps` }))} />
            </Field>
          </div>
        </>
      );
    }
    case 'display_capture': {
      const s = src.settings;
      return (
        <>
          <CapturePicker kind="screen" value={s.captureId} onChange={(c) => set({ captureId: c.id, captureName: c.name })} />
          <Field label="Capture frame rate">
            <Select value={s.fps} onChange={(v) => set({ fps: v })} options={[15, 24, 30, 60].map((f) => ({ value: f, label: `${f} fps` }))} />
          </Field>
        </>
      );
    }
    case 'window_capture': {
      const s = src.settings;
      return (
        <>
          <CapturePicker kind="window" value={s.captureId} onChange={(c) => set({ captureId: c.id, captureName: c.name })} />
          <Field label="Capture frame rate">
            <Select value={s.fps} onChange={(v) => set({ fps: v })} options={[15, 24, 30, 60].map((f) => ({ value: f, label: `${f} fps` }))} />
          </Field>
        </>
      );
    }
    case 'audio_input': {
      const s = src.settings;
      return (
        <>
          <Field label="Device" help="On Linux, desktop audio appears here as “Monitor of …”.">
            <DevicePicker kind="audioinput" allowDefault value={s.deviceId} onChange={(id, label) => set({ deviceId: id, deviceLabel: label })} />
          </Field>
          <Check checked={s.noiseSuppression} onChange={(b) => set({ noiseSuppression: b })} label="Noise suppression" />
          <Check checked={s.echoCancellation} onChange={(b) => set({ echoCancellation: b })} label="Echo cancellation (useful without headphones)" />
          <Check checked={s.autoGainControl} onChange={(b) => set({ autoGainControl: b })} label="Automatic gain control" />
          <div className="muted">More processing (noise gate, compressor, EQ…) is available in the mixer → Advanced audio.</div>
        </>
      );
    }
    case 'audio_output':
      return (
        <div className="callout info">
          <div>
            Captures everything your computer plays (games, music, browser).
            <br />
            {api.platform === 'win32' && 'Windows: captures the default output device.'}
            {api.platform === 'darwin' && 'macOS 13+: allow “Screen & System Audio Recording” for Streamzar in System Settings → Privacy & Security.'}
            {api.platform === 'linux' && 'Linux: uses the PulseAudio/PipeWire “Monitor of …” device of your output.'}
          </div>
        </div>
      );
    case 'scene': {
      const blocked = scenesContaining(collection, useStore.getState().editedSceneId());
      return (
        <Field label="Scene" help="Scenes that already contain the current scene cannot be nested (that would create a loop).">
          <Select
            value={src.settings.sceneId}
            onChange={(v) => set({ sceneId: v })}
            options={[{ value: '', label: '— choose a scene —' }, ...collection.scenes.map((sc) => ({ value: sc.id, label: sc.name, disabled: blocked.has(sc.id) }))]}
          />
        </Field>
      );
    }
    case 'alert_box': {
      const s = src.settings;
      return (
        <>
          <div className="callout info">
            <div>
              Design your alerts (text, image/GIF/video, sound, animation) in <b>Settings → Alerts</b>. Alerts come from Twitch/YouTube chat events, the local webhook (Ko-fi, donation tools) and the “Test alert” button.
            </div>
          </div>
          <SizeFields w={s.width} h={s.height} onChange={set} />
          <AlertTypesField value={s.types} onChange={(t) => set({ types: t })} help="Use several Alert Boxes to place different alert types in different spots." />
          <button className="btn" onClick={() => useStore.getState().openDialog({ kind: 'settings', tab: 'alerts' })}>
            Open alert settings
          </button>
        </>
      );
    }
    case 'chat_box': {
      const s = src.settings;
      return (
        <>
          <SizeFields w={s.width} h={s.height} onChange={set} />
          <div className="field-row">
            <Field label="Max messages">
              <NumberInput value={s.maxMessages} min={1} max={100} onChange={(n) => set({ maxMessages: n })} />
            </Field>
            <Field label="Hide messages after (seconds, 0 = never)">
              <NumberInput value={s.hideAfterSec} min={0} max={3600} onChange={(n) => set({ hideAfterSec: n })} />
            </Field>
          </div>
          <div className="inline wrap">
            <Check checked={s.showPlatformIcon} onChange={(b) => set({ showPlatformIcon: b })} label="Platform icons" />
            <Check checked={s.messageBackground} onChange={(b) => set({ messageBackground: b })} label="Message bubbles" />
          </div>
          <TextStyleFields value={s} onChange={set} compact />
          <BackgroundFields color={s.backgroundColor} opacity={s.backgroundOpacity} onChange={set} />
        </>
      );
    }
    case 'event_list': {
      const s = src.settings;
      return (
        <>
          <SizeFields w={s.width} h={s.height} onChange={set} />
          <Field label="Number of events">
            <NumberInput value={s.maxEvents} min={1} max={20} onChange={(n) => set({ maxEvents: n })} />
          </Field>
          <AlertTypesField value={s.types} onChange={(t) => set({ types: t })} help="" />
          <TextStyleFields value={s} onChange={set} compact />
          <BackgroundFields color={s.backgroundColor} opacity={s.backgroundOpacity} onChange={set} />
        </>
      );
    }
    case 'goal': {
      const s = src.settings;
      return (
        <>
          <Field label="Title">
            <TextInput value={s.title} onChange={(v) => set({ title: v })} />
          </Field>
          <div className="field-row">
            <Field label="Goal type" help="Progress updates automatically from matching events.">
              <Select
                value={s.goalType}
                onChange={(v) => set({ goalType: v })}
                options={[
                  { value: 'follower', label: 'Followers' },
                  { value: 'subscriber', label: 'Subscribers / members' },
                  { value: 'donation', label: 'Donations (incl. Super Chats)' },
                  { value: 'superchat', label: 'Super Chats only' },
                  { value: 'bits', label: 'Bits' },
                  { value: 'custom', label: 'Custom (manual)' },
                ]}
              />
            </Field>
            {(s.goalType === 'donation' || s.goalType === 'superchat') && (
              <Field label="Currency">
                <TextInput value={s.currency} onChange={(v) => set({ currency: v.toUpperCase().slice(0, 3) })} />
              </Field>
            )}
          </div>
          <div className="field-row">
            <Field label="Current">
              <NumberInput value={s.current} min={0} step={1} onChange={(n) => set({ current: n })} />
            </Field>
            <Field label="Target">
              <NumberInput value={s.target} min={1} step={1} onChange={(n) => set({ target: n })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Bar color">
              <ColorInput value={s.barColor} onChange={(c) => set({ barColor: c })} />
            </Field>
            <Field label="Bar background">
              <ColorInput value={s.barBackground} onChange={(c) => set({ barBackground: c })} />
            </Field>
          </div>
          <SizeFields w={s.width} h={s.height} onChange={set} />
          <TextStyleFields value={s} onChange={set} compact />
        </>
      );
    }
    case 'countdown': {
      const s = src.settings;
      return (
        <>
          <Field label="Mode">
            <Select
              value={s.mode}
              onChange={(v) => set({ mode: v })}
              options={[
                { value: 'countdown', label: 'Countdown' },
                { value: 'stopwatch', label: 'Stopwatch (counts up while shown)' },
                { value: 'clock', label: 'Clock' },
                { value: 'stream_uptime', label: 'Stream uptime' },
              ]}
            />
          </Field>
          {s.mode === 'countdown' && (
            <>
              <div className="field-row">
                <Field label="Duration (minutes)" help="Starts when the source becomes visible in program.">
                  <NumberInput value={Math.floor(s.durationSec / 60)} min={0} max={1440} onChange={(m) => set({ durationSec: m * 60 + (s.durationSec % 60) })} />
                </Field>
                <Field label="+ seconds">
                  <NumberInput value={s.durationSec % 60} min={0} max={59} onChange={(sec) => set({ durationSec: Math.floor(s.durationSec / 60) * 60 + sec })} />
                </Field>
              </div>
              <Field label="…or count down to a date & time" help="Overrides the duration when set.">
                <div className="inline">
                  <input className="input" type="datetime-local" value={toLocalInput(s.targetTime)} onChange={(e) => set({ targetTime: e.target.value ? new Date(e.target.value).toISOString() : '' })} />
                  {s.targetTime && (
                    <button className="btn" onClick={() => set({ targetTime: '' })}>
                      Clear
                    </button>
                  )}
                </div>
              </Field>
              <Field label="Text when finished">
                <TextInput value={s.endText} onChange={(v) => set({ endText: v })} />
              </Field>
              <Field label="Format">
                <Select value={s.format} onChange={(v) => set({ format: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'mm:ss', label: 'MM:SS' }, { value: 'hh:mm:ss', label: 'HH:MM:SS' }]} />
              </Field>
            </>
          )}
          {s.mode === 'clock' && <Check checked={s.clock24h} onChange={(b) => set({ clock24h: b })} label="24-hour clock" />}
          <Field label="Prefix text">
            <TextInput value={s.prefix} onChange={(v) => set({ prefix: v })} placeholder="e.g. Starting in " />
          </Field>
          <TextStyleFields value={s} onChange={set} compact />
          <BackgroundFields color={s.backgroundColor} opacity={s.backgroundOpacity} onChange={set} />
        </>
      );
    }
    case 'stream_label': {
      const s = src.settings;
      return (
        <>
          <Field label="Label">
            <Select
              value={s.kind}
              onChange={(v) => {
                const k = LABEL_KINDS.find((x) => x.value === v)!;
                set({ kind: v, template: k.template, emptyText: k.empty });
              }}
              options={LABEL_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            />
          </Field>
          <Field label="Template" help="Placeholders: {name}, {amount}, {count}">
            <TextInput value={s.template} onChange={(v) => set({ template: v })} />
          </Field>
          <Field label="Text when there is no data yet">
            <TextInput value={s.emptyText} onChange={(v) => set({ emptyText: v })} />
          </Field>
          <TextStyleFields value={s} onChange={set} compact />
          <BackgroundFields color={s.backgroundColor} opacity={s.backgroundOpacity} onChange={set} />
        </>
      );
    }
  }
}

export function SourcePropertiesDialog(props: { sourceId: string; isNew?: boolean }) {
  const st = useStore.getState();
  const source = useStore((s) => s.collection.sources.find((x) => x.id === props.sourceId));
  const issue = useStore((s) => s.issues[props.sourceId]);
  const original = useRef<Source | null>(source ? deepClone(source) : null);
  const [name, setName] = useState(source?.name ?? '');
  const key = useRef(`props-${props.sourceId}-${Date.now()}`);
  if (!source) return null;

  const set = (patch: Patch) => st.updateSourceSettings(source.id, patch, { key: key.current });
  const close = () => {
    if (name.trim() && name !== source.name) st.renameSource(source.id, name);
    st.openDialog(null);
    // Size new visual sources sensibly once their size is known.
    if (props.isNew) fitNewSource(source.id);
  };
  const cancel = () => {
    const orig = original.current;
    if (props.isNew) {
      // Cancelling the creation of a new source removes it again.
      const item = useStore.getState().collection.scenes.flatMap((sc) => sc.items).find((it) => it.sourceId === source.id);
      if (item) st.removeItem(item.id);
      else st.removeSource(source.id);
    } else if (orig) {
      st.mutate(
        (d) => {
          const i = d.sources.findIndex((x) => x.id === orig.id);
          if (i >= 0) d.sources[i] = { ...d.sources[i], settings: orig.settings } as Source;
        },
        { key: key.current },
      );
    }
    st.openDialog(null);
  };

  return (
    <Modal
      title={`${props.isNew ? 'Add' : 'Properties'}: ${SOURCE_TYPE_INFO[source.type].label}`}
      onClose={cancel}
      size="wide"
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={close}>
            {props.isNew ? 'Done' : 'OK'}
          </button>
        </>
      }
    >
      {issue && <div className="callout warn">{issue}</div>}
      <Field label="Name">
        <TextInput value={name} onChange={setName} />
      </Field>
      <Form source={source} set={set} />
    </Modal>
  );
}

/** After adding a source, scale it down to fit the canvas if it is larger (like Streamlabs). */
export function fitNewSource(sourceId: string) {
  const started = Date.now();
  const check = () => {
    const eng = engineOrNull();
    const s = useStore.getState();
    const item = s.collection.scenes.flatMap((sc) => sc.items).find((it) => it.sourceId === sourceId);
    if (!eng || !item) return;
    const size = eng.sourceSize(sourceId);
    if (!size.width || !size.height) {
      if (Date.now() - started < 8000) setTimeout(check, 250);
      return;
    }
    const W = s.settings.video.baseWidth;
    const H = s.settings.video.baseHeight;
    const src = s.collection.sources.find((x) => x.id === sourceId) as SourceOf<'display_capture'> | undefined;
    const fullFrame = src && ['display_capture', 'window_capture', 'video_capture', 'media', 'scene', 'slideshow'].includes(src.type);
    if (size.width > W || size.height > H || (fullFrame && item.transform.scaleX === 1 && item.transform.x === 0 && item.transform.y === 0)) {
      const sc = Math.min(W / size.width, H / size.height);
      s.setItemTransform(item.id, { ...item.transform, scaleX: sc, scaleY: sc, x: (W - size.width * sc) / 2, y: (H - size.height * sc) / 2 }, { history: false });
    }
  };
  setTimeout(check, 100);
}
