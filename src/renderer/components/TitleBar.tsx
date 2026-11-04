import { Undo2, Redo2, Settings, MessageSquare, Sun, Moon, Columns2, ChevronDown, Monitor } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../state/store';
import { openMenu } from './ui';
import { openProjector } from './Editor';

export function TitleBar() {
  const collection = useStore((s) => s.collection);
  const collections = useStore((s) => s.collections);
  const studio = useStore((s) => s.studioMode);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const showChat = useStore((s) => s.showChat);
  const theme = useStore((s) => s.settings.general.theme);
  const st = useStore.getState();

  const collectionMenu = (e: React.MouseEvent) => {
    openMenu(e, [
      { heading: 'Scene collections' },
      ...collections.map((c) => ({ label: c.name, checked: c.id === collection.id, onClick: () => void st.loadCollection(c.id) })),
      { separator: true },
      { label: 'New collection…', onClick: () => st.openDialog({ kind: 'prompt', title: 'New scene collection', label: 'Name', value: 'New collection', onSubmit: (v) => void st.newCollection(v) }) },
      { label: 'Duplicate current…', onClick: () => st.openDialog({ kind: 'prompt', title: 'Duplicate scene collection', label: 'Name', value: `${collection.name} (copy)`, onSubmit: (v) => void st.duplicateCollection(v) }) },
      { label: 'Rename current…', onClick: () => st.openDialog({ kind: 'prompt', title: 'Rename scene collection', label: 'Name', value: collection.name, onSubmit: (v) => st.renameCollection(v) }) },
      { label: 'Manage collections…', onClick: () => st.openDialog({ kind: 'collections' }) },
      { separator: true },
      {
        label: 'Import…',
        onClick: () =>
          void api.collections
            .importFrom()
            .then(async (c) => {
              if (c) {
                await st.refreshCollections();
                await st.loadCollection(c.id);
                st.notify('success', `Imported "${c.name}"`);
              }
            })
            .catch((err: Error) => st.notify('error', `Import failed: ${err.message}`)),
      },
      {
        label: 'Export current…',
        onClick: () =>
          void api.collections
            .exportTo(collection)
            .then((p) => p && st.notify('success', `Exported to ${p}`))
            .catch((err: Error) => st.notify('error', `Export failed: ${err.message}`)),
      },
    ]);
  };

  return (
    <header className="titlebar">
      <div className="brand">
        <div className="brand-logo">S</div>
        Streamzar
      </div>
      <button className="btn ghost" onClick={collectionMenu} title="Scene collection">
        {collection.name} <ChevronDown size={14} />
      </button>
      <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => st.undo()}>
        <Undo2 size={16} />
      </button>
      <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => st.redo()}>
        <Redo2 size={16} />
      </button>
      <div className="spacer" />
      <button className={`btn small ${studio ? 'active' : ''}`} onClick={() => st.setStudioMode(!studio)} title="Studio mode: edit a preview scene, then transition it to program">
        <Columns2 size={14} /> Studio Mode
      </button>
      <button className="icon-btn" title="Open projector" onClick={(e) => void projectorMenu(e)}>
        <Monitor size={16} />
      </button>
      <button className={`icon-btn ${showChat ? 'on' : ''}`} title="Show/hide chat & events" onClick={() => useStore.setState({ showChat: !showChat })}>
        <MessageSquare size={16} />
      </button>
      <button className="icon-btn" title="Toggle theme" onClick={() => void st.patchSettings((d) => (d.general.theme = theme === 'dark' ? 'light' : 'dark'))}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="icon-btn" title="Settings" onClick={() => st.openDialog({ kind: 'settings' })}>
        <Settings size={16} />
      </button>
    </header>
  );
}

async function projectorMenu(e: React.MouseEvent) {
  const pos = { clientX: e.clientX, clientY: e.clientY };
  let screens: { name: string; displayId?: string }[] = [];
  try {
    screens = (await api.desktop.getSources(['screen'])).filter((x) => x.displayId);
  } catch {
    /* windowed projector still works */
  }
  openMenu(pos, [
    { label: 'Windowed projector (program)', onClick: () => openProjector() },
    ...(screens.length ? [{ separator: true as const }, { heading: 'Full-screen projector' }] : []),
    ...screens.map((x) => ({ label: x.name, onClick: () => openProjector(x.displayId) })),
  ]);
}
