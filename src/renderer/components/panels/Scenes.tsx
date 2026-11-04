import { useState } from 'react';
import { Plus, Trash2, Copy, ChevronUp, ChevronDown, Settings2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { openMenu } from '../ui';
import { openProjector } from '../Editor';

export function ScenesPanel() {
  const scenes = useStore((s) => s.collection.scenes);
  const activeId = useStore((s) => s.collection.activeSceneId);
  const studio = useStore((s) => s.studioMode);
  const previewId = useStore((s) => s.previewSceneId);
  const hotkeys = useStore((s) => s.settings.hotkeys);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const st = useStore.getState();
  const selectedId = studio ? previewId ?? activeId : activeId;

  const startRename = (id: string, name: string) => {
    setRenaming(id);
    setRenameValue(name);
  };
  const commitRename = () => {
    if (renaming) st.renameScene(renaming, renameValue);
    setRenaming(null);
  };
  const addScene = () =>
    st.openDialog({ kind: 'prompt', title: 'Add scene', label: 'Scene name', value: `Scene ${scenes.length + 1}`, onSubmit: (v) => st.addScene(v) });

  const menu = (e: React.MouseEvent, id: string, name: string) => {
    const idx = scenes.findIndex((s) => s.id === id);
    const hk = `scene:${id}`;
    openMenu(e, [
      { heading: name },
      { label: 'Rename', onClick: () => startRename(id, name) },
      { label: 'Duplicate', onClick: () => st.duplicateScene(id) },
      { label: 'Move up', disabled: idx === 0, onClick: () => st.moveScene(id, idx - 1) },
      { label: 'Move down', disabled: idx === scenes.length - 1, onClick: () => st.moveScene(id, idx + 1) },
      { separator: true },
      {
        label: hotkeys[hk] ? `Hotkey: ${hotkeys[hk]} (change…)` : 'Set hotkey…',
        onClick: () => st.openDialog({ kind: 'settings', tab: 'hotkeys' }),
      },
      { label: 'Open projector (program)', onClick: () => openProjector() },
      { separator: true },
      { label: 'Remove', danger: true, disabled: scenes.length <= 1, onClick: () => confirmRemove(id, name) },
    ]);
  };

  const confirmRemove = (id: string, name: string) =>
    st.openDialog({ kind: 'confirm', title: 'Remove scene', message: `Remove the scene "${name}"?`, confirmLabel: 'Remove', danger: true, onConfirm: () => st.removeScene(id) });

  const selIdx = scenes.findIndex((s) => s.id === selectedId);

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="grow">Scenes</span>
        <button className="icon-btn" title="Transitions" onClick={() => st.openDialog({ kind: 'transitions' })}>
          <Settings2 size={15} />
        </button>
      </div>
      <div className="dock-body">
        <ul className="list" role="listbox" aria-label="Scenes">
          {scenes.map((sc) => (
            <li
              key={sc.id}
              className={`row ${sc.id === selectedId ? 'selected' : ''} ${sc.id === activeId ? 'program' : ''} ${studio && sc.id === previewId && sc.id !== activeId ? 'preview' : ''} ${overId === sc.id && dragId !== sc.id ? 'drag-over' : ''}`}
              draggable={renaming !== sc.id}
              onDragStart={() => setDragId(sc.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(sc.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDrop={() => {
                if (dragId && dragId !== sc.id) st.moveScene(dragId, scenes.findIndex((x) => x.id === sc.id));
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => st.selectScene(sc.id)}
              onDoubleClick={() => (studio ? (st.selectScene(sc.id), st.transitionToPreview()) : startRename(sc.id, sc.name))}
              onContextMenu={(e) => menu(e, sc.id, sc.name)}
              title={studio ? 'Click: preview · Double-click: send to program' : 'Click to switch · Double-click to rename'}
            >
              {renaming === sc.id ? (
                <input
                  className="rename"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="name">{sc.name}</span>
              )}
              {sc.id === activeId && <span className="pill live" style={{ fontSize: 9 }}>LIVE</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="dock-foot">
        <button className="icon-btn" title="Add scene" onClick={addScene}>
          <Plus size={16} />
        </button>
        <button className="icon-btn danger" title="Remove scene" disabled={scenes.length <= 1} onClick={() => selIdx >= 0 && confirmRemove(scenes[selIdx].id, scenes[selIdx].name)}>
          <Trash2 size={15} />
        </button>
        <button className="icon-btn" title="Duplicate scene" onClick={() => selIdx >= 0 && st.duplicateScene(scenes[selIdx].id)}>
          <Copy size={15} />
        </button>
        <button className="icon-btn" title="Move up" disabled={selIdx <= 0} onClick={() => st.moveScene(scenes[selIdx].id, selIdx - 1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Move down" disabled={selIdx < 0 || selIdx >= scenes.length - 1} onClick={() => st.moveScene(scenes[selIdx].id, selIdx + 1)}>
          <ChevronDown size={16} />
        </button>
      </div>
    </div>
  );
}
