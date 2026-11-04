import { useState } from 'react';
import type { SourceType } from '@shared/types';
import { SOURCE_TYPE_INFO } from '@shared/defaults';
import { scenesContaining, useStore } from '../../state/store';
import { Field, Modal, TextInput } from '../ui';
import { SourceIcon } from '../icons';

const GROUPS: { id: 'capture' | 'standard' | 'widget'; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'standard', label: 'Standard' },
  { id: 'widget', label: 'Widgets' },
];

export function AddSourceDialog(props: { presetType?: SourceType }) {
  const st = useStore.getState();
  const collection = useStore((s) => s.collection);
  const [type, setType] = useState<SourceType | null>(props.presetType ?? null);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(props.presetType ? SOURCE_TYPE_INFO[props.presetType].label : '');
  const [existing, setExisting] = useState<string>('');
  const sceneId = st.editedSceneId();
  const blocked = scenesContaining(collection, sceneId);
  const existingOfType = type ? collection.sources.filter((s) => s.type === type && !(s.type === 'scene' && blocked.has(s.settings.sceneId))) : [];

  const create = () => {
    if (!type) return;
    if (mode === 'existing') {
      if (!existing) return;
      st.addExistingSource(existing);
      st.openDialog(null);
      return;
    }
    let settings: Record<string, unknown> | undefined;
    if (type === 'scene') {
      const target = collection.scenes.find((s) => !blocked.has(s.id));
      if (!target) {
        st.notify('warning', 'Create another scene first: a scene cannot contain itself.');
        return;
      }
      settings = { sceneId: target.id };
    }
    const src = st.addSource(type, name.trim() || SOURCE_TYPE_INFO[type].label, settings as never);
    st.openDialog({ kind: 'properties', sourceId: src.id, isNew: true });
  };

  return (
    <Modal
      title={type ? `Add ${SOURCE_TYPE_INFO[type].label}` : 'Add a source'}
      onClose={() => st.openDialog(null)}
      size="wide"
      footer={
        type ? (
          <>
            <div className="left">
              {!props.presetType && (
                <button className="btn" onClick={() => setType(null)}>
                  ← Back
                </button>
              )}
            </div>
            <button className="btn" onClick={() => st.openDialog(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={mode === 'existing' && !existing} onClick={create}>
              {mode === 'existing' ? 'Add existing' : 'Add source'}
            </button>
          </>
        ) : undefined
      }
    >
      {!type &&
        GROUPS.map((g) => (
          <div key={g.id}>
            <h4>{g.label}</h4>
            <div className="grid-cards">
              {(Object.keys(SOURCE_TYPE_INFO) as SourceType[])
                .filter((t) => SOURCE_TYPE_INFO[t].group === g.id)
                .map((t) => (
                  <div
                    key={t}
                    className="type-card"
                    onClick={() => {
                      setType(t);
                      setName(SOURCE_TYPE_INFO[t].label);
                      setMode('new');
                      setExisting('');
                    }}
                  >
                    <div className="t">
                      <SourceIcon type={t} size={17} /> {SOURCE_TYPE_INFO[t].label}
                    </div>
                    <div className="d">{SOURCE_TYPE_INFO[t].description}</div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      {type && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {SOURCE_TYPE_INFO[type].description}
          </p>
          <label className="check">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Create a new source
          </label>
          {mode === 'new' && (
            <Field label="Name">
              <TextInput value={name} onChange={setName} autoFocus onEnter={create} />
            </Field>
          )}
          <label className="check" style={existingOfType.length ? undefined : { opacity: 0.5 }}>
            <input type="radio" disabled={!existingOfType.length} checked={mode === 'existing'} onChange={() => setMode('existing')} /> Add an existing source (shared between scenes)
          </label>
          {mode === 'existing' && (
            <div className="card" style={{ padding: 4 }}>
              {existingOfType.map((s) => (
                <div key={s.id} className={`row ${existing === s.id ? 'selected' : ''}`} onClick={() => setExisting(s.id)} onDoubleClick={() => {
                    st.addExistingSource(s.id);
                    st.openDialog(null);
                  }}>
                  <SourceIcon type={s.type} />
                  <span className="name">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
