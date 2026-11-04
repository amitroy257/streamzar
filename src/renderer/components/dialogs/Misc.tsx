import { useEffect, useRef, useState } from 'react';
import type { Transform, TransitionSettings, TransitionType } from '@shared/types';
import type { AppInfo } from '@shared/ipc';
import { api } from '../../api';
import { useStore, itemById } from '../../state/store';
import { engineOrNull } from '../../state/controller';
import { applyFit } from '../menus';
import { Check, ColorInput, Field, FileInput, Modal, NumberInput, Select, Slider, TextInput, VIDEO_FILTER } from '../ui';
import { TRANSITION_LABELS } from '../TransitionBar';

export function PromptDialog(props: { title: string; label: string; value: string; onSubmit: (v: string) => void }) {
  const st = useStore.getState();
  const [v, setV] = useState(props.value);
  const submit = () => {
    if (!v.trim()) return;
    st.openDialog(null);
    props.onSubmit(v.trim());
  };
  return (
    <Modal
      title={props.title}
      onClose={() => st.openDialog(null)}
      footer={
        <>
          <button className="btn" onClick={() => st.openDialog(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!v.trim()} onClick={submit}>
            OK
          </button>
        </>
      }
    >
      <Field label={props.label}>
        <TextInput value={v} onChange={setV} autoFocus onEnter={submit} />
      </Field>
    </Modal>
  );
}

export function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) {
  const st = useStore.getState();
  return (
    <Modal
      title={props.title}
      onClose={() => st.openDialog(null)}
      footer={
        <>
          <button className="btn" onClick={() => st.openDialog(null)}>
            Cancel
          </button>
          <button
            className={`btn ${props.danger ? 'danger' : 'primary'}`}
            autoFocus
            onClick={() => {
              st.openDialog(null);
              props.onConfirm();
            }}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{props.message}</p>
    </Modal>
  );
}

export function TransformDialog(props: { itemId: string }) {
  const st = useStore.getState();
  const item = useStore(() => itemById(props.itemId));
  const key = useRef(`transform-${props.itemId}-${Date.now()}`);
  if (!item) return null;
  const t = item.transform;
  const size = engineOrNull()?.sourceSize(item.sourceId) ?? { width: 0, height: 0 };
  const set = (patch: Partial<Transform>) => st.setItemTransform(item.id, { ...t, ...patch }, { key: key.current });
  const setCrop = (patch: Partial<Transform['crop']>) => set({ crop: { ...t.crop, ...patch } });
  const w = Math.round((size.width - t.crop.left - t.crop.right) * t.scaleX);
  const h = Math.round((size.height - t.crop.top - t.crop.bottom) * t.scaleY);
  return (
    <Modal title="Edit transform" onClose={() => st.openDialog(null)} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      <div className="field-row">
        <Field label="Position X">
          <NumberInput value={t.x} onChange={(x) => set({ x })} />
        </Field>
        <Field label="Position Y">
          <NumberInput value={t.y} onChange={(y) => set({ y })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label={`Width (source ${size.width || '?'} px)`}>
          <NumberInput value={w} min={1} onChange={(nw) => size.width && set({ scaleX: nw / Math.max(1, size.width - t.crop.left - t.crop.right) })} />
        </Field>
        <Field label={`Height (source ${size.height || '?'} px)`}>
          <NumberInput value={h} min={1} onChange={(nh) => size.height && set({ scaleY: nh / Math.max(1, size.height - t.crop.top - t.crop.bottom) })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Rotation (degrees)">
          <NumberInput value={t.rotation} min={-360} max={360} step={0.1} onChange={(r) => set({ rotation: ((r % 360) + 360) % 360 })} />
        </Field>
        <Field label="Flip">
          <div className="inline">
            <Check checked={t.flipH} onChange={(b) => set({ flipH: b })} label="Horizontal" />
            <Check checked={t.flipV} onChange={(b) => set({ flipV: b })} label="Vertical" />
          </div>
        </Field>
      </div>
      <h4>Crop (source pixels) — or Alt+drag a handle in the editor</h4>
      <div className="field-row">
        <Field label="Left">
          <NumberInput value={t.crop.left} min={0} max={Math.max(0, size.width - 1)} onChange={(v) => setCrop({ left: v })} />
        </Field>
        <Field label="Right">
          <NumberInput value={t.crop.right} min={0} max={Math.max(0, size.width - 1)} onChange={(v) => setCrop({ right: v })} />
        </Field>
        <Field label="Top">
          <NumberInput value={t.crop.top} min={0} max={Math.max(0, size.height - 1)} onChange={(v) => setCrop({ top: v })} />
        </Field>
        <Field label="Bottom">
          <NumberInput value={t.crop.bottom} min={0} max={Math.max(0, size.height - 1)} onChange={(v) => setCrop({ bottom: v })} />
        </Field>
      </div>
      <div className="inline wrap">
        <button className="btn small" onClick={() => applyFit(item.id, 'fit')}>
          Fit to screen
        </button>
        <button className="btn small" onClick={() => applyFit(item.id, 'stretch')}>
          Stretch
        </button>
        <button className="btn small" onClick={() => applyFit(item.id, 'center')}>
          Center
        </button>
        <button className="btn small" onClick={() => applyFit(item.id, 'reset')}>
          Reset
        </button>
      </div>
    </Modal>
  );
}

export function TransitionsDialog() {
  const st = useStore.getState();
  const t = useStore((s) => s.collection.transition);
  const set = (patch: Partial<TransitionSettings>) => st.mutate((d) => Object.assign(d.transition, patch), { key: 'transition-settings' });
  return (
    <Modal title="Scene transition" onClose={() => st.openDialog(null)} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      <div className="field-row">
        <Field label="Type">
          <Select<TransitionType> value={t.type} onChange={(v) => set({ type: v })} options={Object.entries(TRANSITION_LABELS).map(([value, label]) => ({ value: value as TransitionType, label }))} />
        </Field>
        {t.type !== 'stinger' && t.type !== 'cut' && (
          <Field label="Duration (ms)">
            <NumberInput value={t.durationMs} min={50} max={10000} step={50} onChange={(v) => set({ durationMs: v })} />
          </Field>
        )}
      </div>
      {(t.type === 'slide' || t.type === 'swipe') && (
        <Field label="Direction">
          <Select value={t.direction} onChange={(v) => set({ direction: v })} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }]} />
        </Field>
      )}
      {t.type === 'fade_color' && (
        <Field label="Color">
          <ColorInput value={t.color} onChange={(c) => set({ color: c })} />
        </Field>
      )}
      {t.type === 'luma_wipe' && (
        <>
          <Field label="Pattern">
            <Select
              value={t.lumaPattern}
              onChange={(v) => set({ lumaPattern: v })}
              options={[
                { value: 'linear_h', label: 'Linear (horizontal)' },
                { value: 'linear_v', label: 'Linear (vertical)' },
                { value: 'radial', label: 'Circle' },
                { value: 'clock', label: 'Clock' },
                { value: 'diamond', label: 'Diamond' },
                { value: 'blinds', label: 'Blinds' },
              ]}
            />
          </Field>
          <Field label="Softness">
            <Slider value={t.softness} min={0} max={0.5} step={0.01} onChange={(v) => set({ softness: v })} />
          </Field>
          <Check checked={t.invert} onChange={(b) => set({ invert: b })} label="Invert" />
        </>
      )}
      {t.type === 'stinger' && (
        <>
          <Field label="Stinger video" help="A video (ideally WebM with transparency) that plays over the cut.">
            <FileInput value={t.stingerPath} onChange={(p) => set({ stingerPath: p })} filters={VIDEO_FILTER} />
          </Field>
          <div className="field-row">
            <Field label="Transition point (ms)" help="When the scene switches behind the stinger.">
              <NumberInput value={t.stingerPointMs} min={0} max={20000} step={10} onChange={(v) => set({ stingerPointMs: v })} />
            </Field>
            <Field label="Stinger volume">
              <Slider value={Math.round(t.stingerVolume * 100)} min={0} max={100} onChange={(v) => set({ stingerVolume: v / 100 })} format={(v) => `${v}%`} />
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}

export function CollectionsDialog() {
  const st = useStore.getState();
  const collections = useStore((s) => s.collections);
  const activeId = useStore((s) => s.collection.id);
  useEffect(() => {
    void st.refreshCollections();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Scene collections" onClose={() => st.openDialog(null)} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      {collections.map((c) => (
        <div key={c.id} className="row" style={{ cursor: 'default' }}>
          <span className="name">
            {c.name} {c.id === activeId && <span className="pill ok">active</span>}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {c.updatedAt ? new Date(c.updatedAt).toLocaleString() : ''}
          </span>
          <button className="btn small" disabled={c.id === activeId} onClick={() => void st.loadCollection(c.id)}>
            Load
          </button>
          <button
            className="btn small"
            disabled={collections.length <= 1}
            onClick={() =>
              st.openDialog({
                kind: 'confirm',
                title: 'Delete scene collection',
                message: `Delete "${c.name}"? This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => void st.deleteCollection(c.id),
              })
            }
          >
            Delete
          </button>
        </div>
      ))}
    </Modal>
  );
}

export function AboutDialog() {
  const st = useStore.getState();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.system.info().then(setInfo);
  }, []);
  return (
    <Modal title="About Streamzar" onClose={() => st.openDialog(null)} footer={<button className="btn primary" onClick={() => st.openDialog(null)}>Close</button>}>
      <p>Streamzar — open streaming studio. Multistream to YouTube, Facebook, Twitch and more.</p>
      {info && (
        <div className="selectable mono" style={{ fontSize: 12 }}>
          Version {info.version} · {info.platform}/{info.arch}
          <br />
          Electron {info.electron} · Chromium {info.chrome}
          <br />
          FFmpeg {info.ffmpegVersion} — {info.ffmpegPath}
        </div>
      )}
    </Modal>
  );
}
