import { useState } from 'react';
import { Plus, Trash2, Settings, SlidersHorizontal, ChevronUp, ChevronDown, Eye, EyeOff, Lock, Unlock, AlertTriangle } from 'lucide-react';
import { sourceHasVideo } from '@shared/defaults';
import { useStore } from '../../state/store';
import { itemMenu } from '../menus';
import { openMenu } from '../ui';
import { SourceIcon } from '../icons';

export function SourcesPanel() {
  const collection = useStore((s) => s.collection);
  const sceneId = useStore((s) => (s.studioMode && s.previewSceneId ? s.previewSceneId : s.collection.activeSceneId));
  const selected = useStore((s) => s.selectedItemIds);
  const issues = useStore((s) => s.issues);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const st = useStore.getState();
  const scene = collection.scenes.find((s) => s.id === sceneId);
  const items = scene ? [...scene.items].reverse() : []; // top-most first
  const first = selected.find((id) => items.some((i) => i.id === id));
  const firstItem = items.find((i) => i.id === first);
  const firstSource = firstItem ? collection.sources.find((s) => s.id === firstItem.sourceId) : undefined;

  const dropOn = (targetId: string) => {
    if (!dragId || !scene || dragId === targetId) return;
    // items are displayed reversed: convert display index to render-order index
    const targetIdx = scene.items.findIndex((i) => i.id === targetId);
    st.moveItem(dragId, targetIdx);
  };

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="grow">Sources</span>
        <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          {scene?.name}
        </span>
      </div>
      <div className="dock-body" onClick={(e) => e.target === e.currentTarget && st.selectItems([])}>
        {!items.length && (
          <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
            No sources yet.
            <br />
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => st.openDialog({ kind: 'addSource' })}>
              <Plus size={14} /> Add a source
            </button>
          </div>
        )}
        <ul className="list" aria-label="Sources">
          {items.map((it) => {
            const src = collection.sources.find((s) => s.id === it.sourceId);
            if (!src) return null;
            const issue = issues[src.id];
            return (
              <li
                key={it.id}
                className={`row ${selected.includes(it.id) ? 'selected' : ''} ${overId === it.id && dragId !== it.id ? 'drag-over' : ''}`}
                draggable
                onDragStart={() => setDragId(it.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverId(it.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDrop={() => {
                  dropOn(it.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) st.selectItems(selected.includes(it.id) ? selected.filter((x) => x !== it.id) : [...selected, it.id]);
                  else st.selectItems([it.id]);
                }}
                onDoubleClick={() => st.openDialog({ kind: 'properties', sourceId: src.id })}
                onContextMenu={(e) => {
                  st.selectItems([it.id]);
                  openMenu(e, itemMenu(it.id));
                }}
              >
                <SourceIcon type={src.type} />
                <span className={`name ${it.visible ? '' : 'dim'}`}>{src.name}</span>
                {issue && (
                  <span className="issue" title={issue}>
                    <AlertTriangle size={14} />
                  </span>
                )}
                <span className="icons">
                  {sourceHasVideo(src.type) && (
                    <button
                      className={`icon-btn ${it.visible ? '' : 'off'}`}
                      title={it.visible ? 'Hide' : 'Show'}
                      onClick={(e) => {
                        e.stopPropagation();
                        st.setItemVisible(it.id, !it.visible);
                      }}
                    >
                      {it.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  )}
                  <button
                    className={`icon-btn ${it.locked ? 'on' : 'off'}`}
                    title={it.locked ? 'Unlock' : 'Lock'}
                    onClick={(e) => {
                      e.stopPropagation();
                      st.setItemLocked(it.id, !it.locked);
                    }}
                  >
                    {it.locked ? <Lock size={14} /> : <Unlock size={14} />}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="dock-foot">
        <button className="icon-btn" title="Add source" onClick={() => st.openDialog({ kind: 'addSource' })}>
          <Plus size={16} />
        </button>
        <button className="icon-btn danger" title="Remove source" disabled={!firstItem} onClick={() => firstItem && st.removeItem(firstItem.id)}>
          <Trash2 size={15} />
        </button>
        <button className="icon-btn" title="Properties" disabled={!firstSource} onClick={() => firstSource && st.openDialog({ kind: 'properties', sourceId: firstSource.id })}>
          <Settings size={15} />
        </button>
        <button
          className="icon-btn"
          title="Filters"
          disabled={!firstSource || !sourceHasVideo(firstSource.type)}
          onClick={() => firstSource && st.openDialog({ kind: 'filters', sourceId: firstSource.id })}
        >
          <SlidersHorizontal size={15} />
        </button>
        <button className="icon-btn" title="Move up" disabled={!firstItem} onClick={() => firstItem && st.moveItem(firstItem.id, 'up')}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Move down" disabled={!firstItem} onClick={() => firstItem && st.moveItem(firstItem.id, 'down')}>
          <ChevronDown size={16} />
        </button>
      </div>
    </div>
  );
}
