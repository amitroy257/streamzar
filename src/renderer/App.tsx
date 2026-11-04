import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from './state/store';
import { TitleBar } from './components/TitleBar';
import { Editor } from './components/Editor';
import { ScenesPanel } from './components/panels/Scenes';
import { SourcesPanel } from './components/panels/Sources';
import { MixerPanel } from './components/panels/Mixer';
import { Sidebar } from './components/panels/Sidebar';
import { ControlsBar, StatusBar } from './components/StatusBar';
import { ContextMenuHost } from './components/ui';
import { AddSourceDialog } from './components/dialogs/AddSource';
import { SourcePropertiesDialog } from './components/dialogs/SourceProperties';
import { FiltersDialog, AdvancedAudioDialog } from './components/dialogs/Filters';
import { AboutDialog, CollectionsDialog, ConfirmDialog, PromptDialog, TransformDialog, TransitionsDialog } from './components/dialogs/Misc';
import { GoLiveDialog } from './components/dialogs/GoLive';
import { SettingsDialog } from './components/settings/Settings';
import { applyFit } from './components/menus';

function DialogHost() {
  const d = useStore((s) => s.dialog);
  if (!d) return null;
  switch (d.kind) {
    case 'addSource':
      return <AddSourceDialog presetType={d.presetType} />;
    case 'properties':
      return <SourcePropertiesDialog key={d.sourceId} sourceId={d.sourceId} isNew={d.isNew} />;
    case 'filters':
      return <FiltersDialog sourceId={d.sourceId} />;
    case 'transform':
      return <TransformDialog itemId={d.itemId} />;
    case 'advancedAudio':
      return <AdvancedAudioDialog />;
    case 'settings':
      return <SettingsDialog tab={d.tab} />;
    case 'goLive':
      return <GoLiveDialog />;
    case 'transitions':
      return <TransitionsDialog />;
    case 'collections':
      return <CollectionsDialog />;
    case 'about':
      return <AboutDialog />;
    case 'prompt':
      return <PromptDialog title={d.title} label={d.label} value={d.value} onSubmit={d.onSubmit} />;
    case 'confirm':
      return <ConfirmDialog title={d.title} message={d.message} confirmLabel={d.confirmLabel} danger={d.danger} onConfirm={d.onConfirm} />;
  }
}

function Toasts() {
  const notices = useStore((s) => s.notices);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.level}`}>
          <div className="msg">{n.message}</div>
          {n.action && (
            <button
              className="btn small"
              onClick={() => {
                n.action!.run();
                dismiss(n.id);
              }}
            >
              {n.action.label}
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(n.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** Editor keyboard shortcuts (only when no dialog is open and focus is not in a text field). */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || isTyping(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const sel = s.selectedItemIds;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if (mod && key === 'c' && sel[0]) {
        s.copyItem(sel[0]);
      } else if (mod && key === 'v') {
        s.pasteItem();
      } else if (mod && key === 'e' && sel[0]) {
        e.preventDefault();
        s.openDialog({ kind: 'transform', itemId: sel[0] });
      } else if (mod && key === 'f' && sel[0]) {
        e.preventDefault();
        applyFit(sel[0], 'fit');
      } else if (mod && key === 's' && sel[0]) {
        e.preventDefault();
        applyFit(sel[0], 'stretch');
      } else if (mod && key === 'd' && sel[0]) {
        e.preventDefault();
        applyFit(sel[0], 'center');
      } else if (mod && key === 'r' && sel[0]) {
        e.preventDefault();
        applyFit(sel[0], 'reset');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
        e.preventDefault();
        for (const id of sel) s.removeItem(id);
      } else if (e.key.startsWith('Arrow') && sel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        for (const id of sel) {
          const it = s.collection.scenes.flatMap((sc) => sc.items).find((x) => x.id === id);
          if (it && !it.locked) s.setItemTransform(id, { ...it.transform, x: it.transform.x + dx, y: it.transform.y + dy }, { key: `nudge-${id}` });
        }
      } else if (e.key === 'Escape') {
        s.selectItems([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Draggable divider between the editor and the docks. */
function useDockHeight(): [number, (e: React.PointerEvent) => void] {
  const [h, setH] = useState(() => {
    const v = Number(localStorage.getItem('streamzar.dockHeight'));
    return Number.isFinite(v) && v >= 160 ? v : 290;
  });
  const start = useRef<{ y: number; h: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, h };
    const move = (ev: PointerEvent) => {
      if (!start.current) return;
      const next = Math.max(160, Math.min(window.innerHeight - 300, start.current.h - (ev.clientY - start.current.y)));
      setH(next);
    };
    const up = () => {
      start.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setH((v) => {
        try {
          localStorage.setItem('streamzar.dockHeight', String(Math.round(v)));
        } catch {
          /* ignore */
        }
        return v;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [h, onDown];
}

export function App() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const theme = useStore((s) => s.settings.general.theme);
  const [dockH, onDividerDown] = useDockHeight();
  useShortcuts();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (loadError) {
    return (
      <div className="error-screen">
        <h2>Streamzar could not start</h2>
        <div className="callout error selectable">{loadError}</div>
        <p className="muted">If this mentions WebGL, update your graphics driver. You can also try disabling GPU acceleration in the settings file.</p>
        <button className="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!ready) return <div className="loading-screen">Starting Streamzar…</div>;

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <div className="editor-wrap">
          <Editor />
          <div className="resize-handle" onPointerDown={onDividerDown} title="Drag to resize" />
          <div className="docks" style={{ height: dockH }}>
            <ScenesPanel />
            <SourcesPanel />
            <MixerPanel />
          </div>
        </div>
        <Sidebar />
      </div>
      <ControlsBar />
      <StatusBar />
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
