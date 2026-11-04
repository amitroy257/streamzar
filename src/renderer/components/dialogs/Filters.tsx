import { useRef, useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Eye, EyeOff } from 'lucide-react';
import type { AudioFilter, AudioFilterType, VideoFilter, VideoFilterType } from '@shared/types';
import { AUDIO_FILTER_INFO, VIDEO_FILTER_INFO, createAudioFilter, createVideoFilter } from '@shared/defaults';
import { useStore } from '../../state/store';
import { mixerSourceIds } from '../../state/controller';
import { Check, ColorInput, Field, FileInput, IMAGE_FILTER, Modal, NumberInput, Select, Slider, openMenu } from '../ui';

type Settings = Record<string, number | string | boolean>;

function num(s: Settings, k: string, d = 0) {
  return typeof s[k] === 'number' ? (s[k] as number) : d;
}
function str(s: Settings, k: string, d = '') {
  return typeof s[k] === 'string' ? (s[k] as string) : d;
}

function SliderField(props: { label: string; s: Settings; k: string; min: number; max: number; step?: number; d?: number; unit?: string; set: (p: Settings) => void }) {
  const v = num(props.s, props.k, props.d ?? 0);
  return (
    <Field label={props.label}>
      <Slider value={v} min={props.min} max={props.max} step={props.step ?? 1} onChange={(n) => props.set({ [props.k]: n })} format={(n) => `${Math.round(n * 100) / 100}${props.unit ?? ''}`} />
    </Field>
  );
}

function VideoFilterForm(props: { f: VideoFilter; set: (p: Settings) => void }) {
  const { f, set } = props;
  const s = f.settings;
  switch (f.type) {
    case 'chroma_key':
      return (
        <>
          <Field label="Key color" help="Pick the color of your green/blue screen.">
            <div className="inline">
              <Select
                value={['#00ff00', '#0000ff', '#ff00ff'].includes(str(s, 'keyColor')) ? str(s, 'keyColor') : 'custom'}
                onChange={(v) => v !== 'custom' && set({ keyColor: v })}
                options={[
                  { value: '#00ff00', label: 'Green' },
                  { value: '#0000ff', label: 'Blue' },
                  { value: '#ff00ff', label: 'Magenta' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
              <ColorInput value={str(s, 'keyColor', '#00ff00')} onChange={(c) => set({ keyColor: c })} />
            </div>
          </Field>
          <SliderField label="Similarity" s={s} k="similarity" min={1} max={1000} d={400} set={set} />
          <SliderField label="Smoothness" s={s} k="smoothness" min={1} max={1000} d={80} set={set} />
          <SliderField label="Key color spill reduction" s={s} k="spill" min={1} max={1000} d={100} set={set} />
          <SliderField label="Opacity" s={s} k="opacity" min={0} max={100} d={100} unit="%" set={set} />
          <SliderField label="Contrast" s={s} k="contrast" min={-1} max={1} step={0.01} set={set} />
          <SliderField label="Brightness" s={s} k="brightness" min={-1} max={1} step={0.01} set={set} />
          <SliderField label="Gamma" s={s} k="gamma" min={-1} max={1} step={0.01} set={set} />
        </>
      );
    case 'color_key':
      return (
        <>
          <Field label="Key color">
            <ColorInput value={str(s, 'keyColor', '#00ff00')} onChange={(c) => set({ keyColor: c })} />
          </Field>
          <SliderField label="Similarity" s={s} k="similarity" min={1} max={1000} d={80} set={set} />
          <SliderField label="Smoothness" s={s} k="smoothness" min={1} max={1000} d={50} set={set} />
          <SliderField label="Opacity" s={s} k="opacity" min={0} max={100} d={100} unit="%" set={set} />
        </>
      );
    case 'color_correction':
      return (
        <>
          <SliderField label="Gamma" s={s} k="gamma" min={-3} max={3} step={0.01} set={set} />
          <SliderField label="Contrast" s={s} k="contrast" min={-2} max={2} step={0.01} set={set} />
          <SliderField label="Brightness" s={s} k="brightness" min={-1} max={1} step={0.01} set={set} />
          <SliderField label="Saturation" s={s} k="saturation" min={-1} max={5} step={0.01} set={set} />
          <SliderField label="Hue shift" s={s} k="hue" min={-180} max={180} unit="°" set={set} />
          <SliderField label="Opacity" s={s} k="opacity" min={0} max={100} d={100} unit="%" set={set} />
          <div className="field-row">
            <Field label="Color multiply">
              <ColorInput value={str(s, 'colorMultiply', '#ffffff')} onChange={(c) => set({ colorMultiply: c })} />
            </Field>
            <Field label="Color add">
              <ColorInput value={str(s, 'colorAdd', '#000000')} onChange={(c) => set({ colorAdd: c })} />
            </Field>
          </div>
        </>
      );
    case 'blur':
      return <SliderField label="Radius" s={s} k="radius" min={0} max={48} d={8} unit=" px" set={set} />;
    case 'sharpen':
      return <SliderField label="Sharpness" s={s} k="amount" min={0} max={1} step={0.01} d={0.08} set={set} />;
    case 'pixelate':
      return <SliderField label="Block size" s={s} k="size" min={2} max={128} d={16} unit=" px" set={set} />;
    case 'scroll':
      return (
        <>
          <SliderField label="Horizontal speed" s={s} k="speedX" min={-1000} max={1000} d={50} unit=" px/s" set={set} />
          <SliderField label="Vertical speed" s={s} k="speedY" min={-1000} max={1000} d={0} unit=" px/s" set={set} />
          <Check checked={s.loop !== false} onChange={(b) => set({ loop: b })} label="Loop" />
        </>
      );
    case 'image_mask':
      return (
        <>
          <Field label="Mask / blend image">
            <FileInput value={str(s, 'path')} onChange={(p) => set({ path: p })} filters={IMAGE_FILTER} />
          </Field>
          <Field label="Type">
            <Select
              value={str(s, 'mode', 'alpha_mask_alpha')}
              onChange={(v) => set({ mode: v })}
              options={[
                { value: 'alpha_mask_alpha', label: 'Alpha mask (image alpha channel)' },
                { value: 'alpha_mask_color', label: 'Alpha mask (image brightness)' },
                { value: 'blend_multiply', label: 'Blend (multiply)' },
                { value: 'blend_add', label: 'Blend (add)' },
                { value: 'blend_subtract', label: 'Blend (subtract)' },
              ]}
            />
          </Field>
          <Field label="Color">
            <ColorInput value={str(s, 'color', '#ffffff')} onChange={(c) => set({ color: c })} />
          </Field>
          <SliderField label="Opacity" s={s} k="opacity" min={0} max={100} d={100} unit="%" set={set} />
        </>
      );
    case 'lut':
      return (
        <>
          <Field label="LUT file (.cube)" help="3D LUTs exported from DaVinci Resolve, Premiere, Photoshop…">
            <FileInput value={str(s, 'path')} onChange={(p) => set({ path: p })} filters={[{ name: 'Cube LUT', extensions: ['cube'] }]} />
          </Field>
          <SliderField label="Amount" s={s} k="amount" min={0} max={100} d={100} unit="%" set={set} />
        </>
      );
  }
}

/** Generic list + editor used by both video and audio filters. */
function FilterEditor<F extends { id: string; type: string; name: string; enabled: boolean; settings: Settings }>(props: {
  filters: F[];
  setFilters: (f: F[]) => void;
  addMenu: { label: string; create: () => F }[];
  form: (f: F, set: (p: Settings) => void) => React.ReactNode;
  emptyText: string;
}) {
  const [sel, setSel] = useState<string | null>(props.filters[0]?.id ?? null);
  const current = props.filters.find((f) => f.id === sel) ?? null;
  const update = (id: string, patch: Partial<F>) => props.setFilters(props.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const move = (id: string, d: number) => {
    const list = [...props.filters];
    const i = list.findIndex((f) => f.id === id);
    const [x] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + d)), 0, x);
    props.setFilters(list);
  };
  return (
    <div className="filters-layout">
      <div className="list-pane">
        <div style={{ flex: 1, overflow: 'auto' }}>
          <ul className="list">
            {props.filters.map((f) => (
              <li key={f.id} className={`row ${f.id === sel ? 'selected' : ''}`} onClick={() => setSel(f.id)}>
                <span className={`name ${f.enabled ? '' : 'dim'}`}>{f.name}</span>
                <button
                  className={`icon-btn ${f.enabled ? '' : 'off'}`}
                  title={f.enabled ? 'Disable' : 'Enable'}
                  onClick={(e) => {
                    e.stopPropagation();
                    update(f.id, { enabled: !f.enabled } as Partial<F>);
                  }}
                >
                  {f.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </li>
            ))}
          </ul>
          {!props.filters.length && <div className="muted" style={{ padding: 10 }}>{props.emptyText}</div>}
        </div>
        <div className="dock-foot">
          <button
            className="icon-btn"
            title="Add filter"
            onClick={(e) =>
              openMenu(
                e,
                props.addMenu.map((m) => ({
                  label: m.label,
                  onClick: () => {
                    const f = m.create();
                    props.setFilters([...props.filters, f]);
                    setSel(f.id);
                  },
                })),
              )
            }
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-btn danger"
            title="Remove filter"
            disabled={!current}
            onClick={() => {
              if (!current) return;
              props.setFilters(props.filters.filter((f) => f.id !== current.id));
              setSel(null);
            }}
          >
            <Trash2 size={15} />
          </button>
          <button className="icon-btn" title="Move up" disabled={!current} onClick={() => current && move(current.id, -1)}>
            <ChevronUp size={16} />
          </button>
          <button className="icon-btn" title="Move down" disabled={!current} onClick={() => current && move(current.id, 1)}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {current ? (
          <>
            <Field label="Filter name">
              <input className="input" value={current.name} onChange={(e) => update(current.id, { name: e.target.value } as Partial<F>)} />
            </Field>
            {props.form(current, (p) => update(current.id, { settings: { ...current.settings, ...p } } as Partial<F>))}
          </>
        ) : (
          <div className="muted">Select or add a filter.</div>
        )}
      </div>
    </div>
  );
}

export function FiltersDialog(props: { sourceId: string }) {
  const st = useStore.getState();
  const source = useStore((s) => s.collection.sources.find((x) => x.id === props.sourceId));
  const key = useRef(`filters-${props.sourceId}-${Date.now()}`);
  if (!source) return null;
  return (
    <Modal title={`Filters: ${source.name}`} onClose={() => st.openDialog(null)} size="wide" bodyStyle={{ height: 520 }} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      <FilterEditor<VideoFilter>
        filters={source.filters}
        setFilters={(f) => st.setFilters(source.id, f, { key: key.current })}
        addMenu={(Object.keys(VIDEO_FILTER_INFO) as VideoFilterType[]).map((t) => ({ label: VIDEO_FILTER_INFO[t].label, create: () => createVideoFilter(t) }))}
        form={(f, set) => <VideoFilterForm f={f} set={set} />}
        emptyText="No filters. Click + to add Chroma Key, Color Correction, Blur, LUT…"
      />
    </Modal>
  );
}

function AudioFilterForm(props: { f: AudioFilter; set: (p: Settings) => void }) {
  const { f, set } = props;
  const s = f.settings;
  switch (f.type) {
    case 'gain':
      return <SliderField label="Gain" s={s} k="gainDb" min={-30} max={30} step={0.1} unit=" dB" set={set} />;
    case 'noise_gate':
      return (
        <>
          <SliderField label="Close threshold" s={s} k="closeThreshold" min={-96} max={0} d={-32} unit=" dB" set={set} />
          <SliderField label="Open threshold" s={s} k="openThreshold" min={-96} max={0} d={-26} unit=" dB" set={set} />
          <SliderField label="Attack" s={s} k="attackMs" min={1} max={500} d={25} unit=" ms" set={set} />
          <SliderField label="Hold" s={s} k="holdMs" min={0} max={2000} d={200} unit=" ms" set={set} />
          <SliderField label="Release" s={s} k="releaseMs" min={1} max={2000} d={150} unit=" ms" set={set} />
        </>
      );
    case 'compressor':
      return (
        <>
          <SliderField label="Ratio" s={s} k="ratio" min={1} max={20} step={0.5} d={4} unit=":1" set={set} />
          <SliderField label="Threshold" s={s} k="threshold" min={-60} max={0} step={0.5} d={-18} unit=" dB" set={set} />
          <SliderField label="Attack" s={s} k="attackMs" min={0} max={500} d={6} unit=" ms" set={set} />
          <SliderField label="Release" s={s} k="releaseMs" min={10} max={1000} d={60} unit=" ms" set={set} />
          <SliderField label="Knee" s={s} k="knee" min={0} max={40} d={6} unit=" dB" set={set} />
          <SliderField label="Output gain" s={s} k="outputGain" min={-20} max={32} step={0.5} unit=" dB" set={set} />
        </>
      );
    case 'limiter':
      return (
        <>
          <SliderField label="Threshold" s={s} k="threshold" min={-60} max={0} step={0.5} d={-6} unit=" dB" set={set} />
          <SliderField label="Release" s={s} k="releaseMs" min={10} max={1000} d={60} unit=" ms" set={set} />
        </>
      );
    case 'eq3':
      return (
        <>
          <SliderField label="Low" s={s} k="low" min={-20} max={20} step={0.5} unit=" dB" set={set} />
          <SliderField label="Mid" s={s} k="mid" min={-20} max={20} step={0.5} unit=" dB" set={set} />
          <SliderField label="High" s={s} k="high" min={-20} max={20} step={0.5} unit=" dB" set={set} />
          <SliderField label="Low/mid crossover" s={s} k="lowFreq" min={50} max={1000} d={250} unit=" Hz" set={set} />
          <SliderField label="Mid/high crossover" s={s} k="highFreq" min={1000} max={16000} step={100} d={4000} unit=" Hz" set={set} />
        </>
      );
    case 'highpass':
      return <SliderField label="Cutoff frequency" s={s} k="frequency" min={20} max={500} d={80} unit=" Hz" set={set} />;
  }
}

export function AudioFiltersEditor(props: { sourceId: string }) {
  const st = useStore.getState();
  const source = useStore((s) => s.collection.sources.find((x) => x.id === props.sourceId));
  const key = useRef(`afilters-${props.sourceId}-${Date.now()}`);
  if (!source) return null;
  return (
    <FilterEditor<AudioFilter>
      key={source.id}
      filters={source.audio.filters}
      setFilters={(f) => st.updateAudio(source.id, { filters: f }, { key: key.current })}
      addMenu={(Object.keys(AUDIO_FILTER_INFO) as AudioFilterType[]).map((t) => ({ label: AUDIO_FILTER_INFO[t].label, create: () => createAudioFilter(t) }))}
      form={(f, set) => <AudioFilterForm f={f} set={set} />}
      emptyText="No audio filters. Click + to add a Noise Gate, Compressor, EQ…"
    />
  );
}

export function AdvancedAudioDialog() {
  const st = useStore.getState();
  const collection = useStore((s) => s.collection);
  const ids = mixerSourceIds();
  const [sel, setSel] = useState<string | null>(ids[0] ?? null);
  const src = collection.sources.find((s) => s.id === sel);
  return (
    <Modal title="Advanced audio properties" onClose={() => st.openDialog(null)} size="xwide" bodyStyle={{ padding: 0 }} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      <div className="split">
        <div className="nav">
          {ids.map((id) => {
            const s = collection.sources.find((x) => x.id === id)!;
            return (
              <div key={id} className={`nav-item ${sel === id ? 'active' : ''}`} onClick={() => setSel(id)}>
                {s.name}
              </div>
            );
          })}
        </div>
        <div className="content">
          {src ? (
            <>
              <h3 className="section-title">{src.name}</h3>
              <p className="section-sub">Volume, sync, monitoring and audio filters.</p>
              <div className="field-row three">
                <Field label="Volume (dB)">
                  <NumberInput value={src.audio.volumeDb} min={-100} max={26} step={0.1} onChange={(v) => st.updateAudio(src.id, { volumeDb: v })} />
                </Field>
                <Field label="Sync offset (ms)" help="Delays this audio to match a laggy camera.">
                  <NumberInput value={src.audio.syncOffsetMs} min={0} max={9500} step={10} onChange={(v) => st.updateAudio(src.id, { syncOffsetMs: v })} />
                </Field>
                <Field label="Monitoring">
                  <Select
                    value={src.audio.monitoring}
                    onChange={(v) => st.updateAudio(src.id, { monitoring: v })}
                    options={[
                      { value: 'off', label: 'Monitor off' },
                      { value: 'monitor-only', label: 'Monitor only (mute output)' },
                      { value: 'monitor-output', label: 'Monitor and output' },
                    ]}
                  />
                </Field>
              </div>
              <div className="field-row">
                <Field label="Balance">
                  <Slider value={src.audio.balance} min={-1} max={1} step={0.01} onChange={(v) => st.updateAudio(src.id, { balance: v }, { key: `bal-${src.id}` })} format={(v) => (v === 0 ? 'Center' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)} />
                </Field>
                <Field label=" ">
                  <div className="inline">
                    <Check checked={src.audio.mono} onChange={(b) => st.updateAudio(src.id, { mono: b })} label="Downmix to mono" />
                    <Check checked={src.audio.muted} onChange={(b) => st.updateAudio(src.id, { muted: b })} label="Muted" />
                  </div>
                </Field>
              </div>
              <h4>Audio filters</h4>
              <div style={{ height: 380 }}>
                <AudioFiltersEditor sourceId={src.id} />
              </div>
            </>
          ) : (
            <div className="muted">No audio sources.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
