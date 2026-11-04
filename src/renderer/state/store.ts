import { create } from 'zustand';
import type {
  AppSettings,
  ChatStatus,
  CollectionMeta,
  EncoderInfo,
  OutputStatus,
  Scene,
  SceneCollection,
  SceneItem,
  Source,
  SourceSettingsMap,
  SourceType,
  SystemStats,
  Transform,
  VideoFilter,
  AudioSettings,
} from '@shared/types';
import { createCollection, createScene, createSceneItem, createSource, defaultSettings } from '@shared/defaults';
import { deepClone, uid } from '@shared/util';
import { api } from '../api';

export interface Notice {
  id: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
  action?: { label: string; run: () => void };
}

export type DialogState =
  | { kind: 'addSource'; presetType?: SourceType }
  | { kind: 'properties'; sourceId: string; isNew?: boolean }
  | { kind: 'filters'; sourceId: string }
  | { kind: 'transform'; itemId: string }
  | { kind: 'advancedAudio' }
  | { kind: 'settings'; tab?: string }
  | { kind: 'goLive' }
  | { kind: 'transitions' }
  | { kind: 'collections' }
  | { kind: 'about' }
  | { kind: 'prompt'; title: string; label: string; value: string; onSubmit: (v: string) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void };

export const EMPTY_OUTPUT: OutputStatus = {
  streaming: false,
  streamStarting: false,
  streamStopping: false,
  streamStartedAt: null,
  stopCountdownSec: 0,
  delaySec: 0,
  destinations: [],
  recording: false,
  recordingStartedAt: null,
  recordingPath: null,
  replayBuffer: false,
  replayBufferSeconds: 0,
  encoders: [],
  lastError: null,
};

interface MutateOptions {
  /** Record an undo step (default true). */
  history?: boolean;
  /** Consecutive mutations with the same key (e.g. dragging) are merged into one undo step. */
  key?: string;
}

export interface AppState {
  ready: boolean;
  loadError: string | null;
  settings: AppSettings;
  collection: SceneCollection;
  collections: CollectionMeta[];
  studioMode: boolean;
  previewSceneId: string | null;
  selectedItemIds: string[];
  output: OutputStatus;
  system: SystemStats;
  issues: Record<string, string>;
  notices: Notice[];
  chatStatuses: ChatStatus[];
  encoders: EncoderInfo[];
  dialog: DialogState | null;
  past: SceneCollection[];
  future: SceneCollection[];
  lastHistoryKey: string | null;
  lastHistoryAt: number;
  clipboard: { sourceId: string; transform: Transform } | null;
  showChat: boolean;

  // generic
  notify(level: Notice['level'], message: string, action?: Notice['action']): void;
  dismiss(id: string): void;
  openDialog(d: DialogState | null): void;
  setSettings(s: AppSettings): Promise<void>;
  patchSettings(fn: (draft: AppSettings) => void): Promise<void>;

  // collection & history
  mutate(recipe: (draft: SceneCollection) => void, opts?: MutateOptions): void;
  undo(): void;
  redo(): void;
  loadCollection(id: string): Promise<void>;
  newCollection(name: string): Promise<void>;
  duplicateCollection(name: string): Promise<void>;
  renameCollection(name: string): void;
  deleteCollection(id: string): Promise<void>;
  refreshCollections(): Promise<void>;

  // scenes
  editedSceneId(): string;
  selectScene(id: string): void;
  addScene(name: string): void;
  renameScene(id: string, name: string): void;
  duplicateScene(id: string): void;
  removeScene(id: string): void;
  moveScene(id: string, toIndex: number): void;
  setStudioMode(on: boolean): void;
  transitionToPreview(): void;

  // sources & items
  addSource<K extends SourceType>(type: K, name: string, settings?: Partial<SourceSettingsMap[K]>): Source;
  addExistingSource(sourceId: string): void;
  removeItem(itemId: string): void;
  removeSource(sourceId: string): void;
  updateSourceSettings(sourceId: string, patch: Record<string, unknown>, opts?: MutateOptions): void;
  renameSource(sourceId: string, name: string): void;
  updateAudio(sourceId: string, patch: Partial<AudioSettings>, opts?: MutateOptions): void;
  setFilters(sourceId: string, filters: VideoFilter[], opts?: MutateOptions): void;
  setItemTransform(itemId: string, t: Transform, opts?: MutateOptions): void;
  setItemVisible(itemId: string, visible: boolean): void;
  setItemLocked(itemId: string, locked: boolean): void;
  moveItem(itemId: string, where: 'up' | 'down' | 'top' | 'bottom' | number): void;
  selectItems(ids: string[]): void;
  copyItem(itemId: string): void;
  pasteItem(): void;
  duplicateItem(itemId: string): void;
  setGlobalAudio(sourceIds: string[]): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: SceneCollection | null = null;

function scheduleSave(c: SceneCollection) {
  pendingSave = c;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

export function flushSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const c = pendingSave;
  pendingSave = null;
  if (!c) return Promise.resolve();
  return api.collections.save(c).catch((e: Error) => {
    useStore.getState().notify('error', `Could not save the scene collection: ${e.message}`);
  });
}

function findItem(c: SceneCollection, itemId: string): { scene: Scene; item: SceneItem; index: number } | null {
  for (const scene of c.scenes) {
    const index = scene.items.findIndex((i) => i.id === itemId);
    if (index >= 0) return { scene, item: scene.items[index], index };
  }
  return null;
}

/** Scenes that (directly or through nested scenes) contain `sceneId` — adding them would create a loop. */
export function scenesContaining(c: SceneCollection, sceneId: string): Set<string> {
  const result = new Set<string>([sceneId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sc of c.scenes) {
      if (result.has(sc.id)) continue;
      for (const it of sc.items) {
        const src = c.sources.find((s) => s.id === it.sourceId);
        if (src?.type === 'scene' && result.has(src.settings.sceneId)) {
          result.add(sc.id);
          changed = true;
          break;
        }
      }
    }
  }
  return result;
}

function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!existing.includes(n)) return n;
  }
}

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  loadError: null,
  settings: defaultSettings(),
  collection: createCollection('Default'),
  collections: [],
  studioMode: false,
  previewSceneId: null,
  selectedItemIds: [],
  output: EMPTY_OUTPUT,
  system: { cpuPercent: 0, appCpuPercent: 0, memoryMB: 0 },
  issues: {},
  notices: [],
  chatStatuses: [],
  encoders: [],
  dialog: null,
  past: [],
  future: [],
  lastHistoryKey: null,
  lastHistoryAt: 0,
  clipboard: null,
  showChat: true,

  notify(level, message, action) {
    const id = uid('n');
    set((s) => ({ notices: [...s.notices.slice(-4), { id, level, message, action }] }));
    const ttl = level === 'error' ? 12000 : level === 'warning' ? 8000 : 5000;
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },
  openDialog(d) {
    set({ dialog: d });
  },
  async setSettings(next) {
    const saved = await api.settings.set(next);
    set({ settings: saved });
  },
  async patchSettings(fn) {
    const draft = deepClone(get().settings);
    fn(draft);
    await get().setSettings(draft);
  },

  // ---------------------------------------------------------------------------
  // Collection & history
  // ---------------------------------------------------------------------------

  mutate(recipe, opts = {}) {
    const prev = get().collection;
    const draft = deepClone(prev);
    recipe(draft);
    draft.updatedAt = Date.now();
    const now = Date.now();
    const history = opts.history !== false;
    set((s) => {
      let past = s.past;
      if (history) {
        const merge = opts.key && s.lastHistoryKey === opts.key && now - s.lastHistoryAt < 1500;
        if (!merge) past = [...s.past.slice(-99), prev];
      }
      return {
        collection: draft,
        past,
        future: history ? [] : s.future,
        lastHistoryKey: history ? (opts.key ?? null) : s.lastHistoryKey,
        lastHistoryAt: history ? now : s.lastHistoryAt,
      };
    });
    scheduleSave(draft);
  },
  undo() {
    const { past, collection, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ collection: prev, past: past.slice(0, -1), future: [collection, ...future].slice(0, 100), lastHistoryKey: null });
    scheduleSave(prev);
  },
  redo() {
    const { past, collection, future } = get();
    if (!future.length) return;
    const next = future[0];
    set({ collection: next, past: [...past, collection], future: future.slice(1), lastHistoryKey: null });
    scheduleSave(next);
  },
  async loadCollection(id) {
    await flushSave();
    const c = await api.collections.load(id);
    if (!c) {
      get().notify('error', 'That scene collection could not be loaded.');
      return;
    }
    await api.collections.setActive(id);
    set({ collection: c, past: [], future: [], selectedItemIds: [], previewSceneId: get().studioMode ? c.activeSceneId : null });
    await get().refreshCollections();
  },
  async newCollection(name) {
    await flushSave();
    const s = get().settings;
    const c = createCollection(name, { width: s.video.baseWidth, height: s.video.baseHeight });
    await api.collections.save(c);
    await get().loadCollection(c.id);
  },
  async duplicateCollection(name) {
    await flushSave();
    const c = deepClone(get().collection);
    c.id = uid('col');
    c.name = name;
    c.updatedAt = Date.now();
    await api.collections.save(c);
    await get().loadCollection(c.id);
  },
  renameCollection(name) {
    get().mutate((d) => {
      d.name = name;
    });
    void flushSave().then(() => get().refreshCollections());
  },
  async deleteCollection(id) {
    const list = get().collections;
    if (list.length <= 1) {
      get().notify('warning', 'You need at least one scene collection.');
      return;
    }
    const wasActive = get().collection.id === id;
    if (wasActive) {
      const other = list.find((c) => c.id !== id)!;
      await get().loadCollection(other.id);
    }
    await api.collections.delete(id);
    await get().refreshCollections();
  },
  async refreshCollections() {
    set({ collections: await api.collections.list() });
  },

  // ---------------------------------------------------------------------------
  // Scenes
  // ---------------------------------------------------------------------------

  editedSceneId() {
    const s = get();
    return s.studioMode && s.previewSceneId ? s.previewSceneId : s.collection.activeSceneId;
  },
  selectScene(id) {
    const s = get();
    if (!s.collection.scenes.some((x) => x.id === id)) return;
    if (s.studioMode) {
      set({ previewSceneId: id, selectedItemIds: [] });
    } else if (s.collection.activeSceneId !== id) {
      s.mutate(
        (d) => {
          d.activeSceneId = id;
        },
        { history: false },
      );
      set({ selectedItemIds: [] });
    }
  },
  addScene(name) {
    const scene = createScene(uniqueName(get().collection.scenes.map((s) => s.name), name || 'Scene'));
    get().mutate((d) => {
      d.scenes.push(scene);
    });
    get().selectScene(scene.id);
  },
  renameScene(id, name) {
    const n = name.trim();
    if (!n) return;
    get().mutate((d) => {
      const sc = d.scenes.find((s) => s.id === id);
      if (sc) sc.name = n;
    });
  },
  duplicateScene(id) {
    const c = get().collection;
    const src = c.scenes.find((s) => s.id === id);
    if (!src) return;
    const copy: Scene = { id: uid('scene'), name: uniqueName(c.scenes.map((s) => s.name), `${src.name} (copy)`), items: src.items.map((it) => ({ ...deepClone(it), id: uid('item') })) };
    get().mutate((d) => {
      const idx = d.scenes.findIndex((s) => s.id === id);
      d.scenes.splice(idx + 1, 0, copy);
    });
  },
  removeScene(id) {
    const c = get().collection;
    if (c.scenes.length <= 1) {
      get().notify('warning', 'A scene collection needs at least one scene.');
      return;
    }
    get().mutate((d) => {
      const idx = d.scenes.findIndex((s) => s.id === id);
      if (idx < 0) return;
      d.scenes.splice(idx, 1);
      // remove nested scene sources pointing at it
      const dead = new Set(d.sources.filter((s) => s.type === 'scene' && s.settings.sceneId === id).map((s) => s.id));
      d.sources = d.sources.filter((s) => !dead.has(s.id));
      for (const sc of d.scenes) sc.items = sc.items.filter((it) => !dead.has(it.sourceId));
      if (d.activeSceneId === id) d.activeSceneId = d.scenes[Math.max(0, idx - 1)].id;
      // drop sources that are no longer used anywhere (except global audio)
      const used = new Set(d.scenes.flatMap((sc) => sc.items.map((it) => it.sourceId)));
      d.sources = d.sources.filter((s) => used.has(s.id) || d.globalAudioSourceIds.includes(s.id));
    });
    if (get().previewSceneId === id) set({ previewSceneId: get().collection.activeSceneId });
  },
  moveScene(id, toIndex) {
    get().mutate((d) => {
      const idx = d.scenes.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const [sc] = d.scenes.splice(idx, 1);
      d.scenes.splice(Math.max(0, Math.min(d.scenes.length, toIndex)), 0, sc);
    });
  },
  setStudioMode(on) {
    set({ studioMode: on, previewSceneId: on ? get().collection.activeSceneId : null, selectedItemIds: [] });
  },
  transitionToPreview() {
    const s = get();
    if (!s.studioMode || !s.previewSceneId) return;
    const target = s.previewSceneId;
    if (target === s.collection.activeSceneId) return;
    s.mutate(
      (d) => {
        d.activeSceneId = target;
      },
      { history: false },
    );
  },

  // ---------------------------------------------------------------------------
  // Sources & items
  // ---------------------------------------------------------------------------

  addSource(type, name, settings) {
    const s = get();
    const base = { width: s.settings.video.baseWidth, height: s.settings.video.baseHeight };
    const src = createSource(type, uniqueName(s.collection.sources.map((x) => x.name), name), settings, base) as Source;
    const item = createSceneItem(src.id);
    const sceneId = s.editedSceneId();
    s.mutate((d) => {
      d.sources.push(src);
      const sc = d.scenes.find((x) => x.id === sceneId);
      sc?.items.push(item);
      if ((type === 'audio_input' || type === 'audio_output') && !sc) d.globalAudioSourceIds.push(src.id);
    });
    set({ selectedItemIds: [item.id] });
    return src;
  },
  addExistingSource(sourceId) {
    const s = get();
    const sceneId = s.editedSceneId();
    const src = s.collection.sources.find((x) => x.id === sourceId);
    if (!src) return;
    if (src.type === 'scene' && scenesContaining(s.collection, sceneId).has(src.settings.sceneId)) {
      s.notify('warning', 'A scene cannot contain itself.');
      return;
    }
    const item = createSceneItem(sourceId);
    s.mutate((d) => {
      d.scenes.find((x) => x.id === sceneId)?.items.push(item);
    });
    set({ selectedItemIds: [item.id] });
  },
  removeItem(itemId) {
    get().mutate((d) => {
      const f = findItem(d, itemId);
      if (!f) return;
      f.scene.items.splice(f.index, 1);
      const stillUsed = d.scenes.some((sc) => sc.items.some((it) => it.sourceId === f.item.sourceId)) || d.globalAudioSourceIds.includes(f.item.sourceId);
      if (!stillUsed) d.sources = d.sources.filter((x) => x.id !== f.item.sourceId);
    });
    set((s) => ({ selectedItemIds: s.selectedItemIds.filter((i) => i !== itemId) }));
  },
  removeSource(sourceId) {
    get().mutate((d) => {
      d.sources = d.sources.filter((x) => x.id !== sourceId);
      for (const sc of d.scenes) sc.items = sc.items.filter((it) => it.sourceId !== sourceId);
      d.globalAudioSourceIds = d.globalAudioSourceIds.filter((x) => x !== sourceId);
    });
  },
  updateSourceSettings(sourceId, patch, opts) {
    get().mutate((d) => {
      const src = d.sources.find((x) => x.id === sourceId);
      if (src) Object.assign(src.settings, patch);
    }, opts);
  },
  renameSource(sourceId, name) {
    const n = name.trim();
    if (!n) return;
    get().mutate((d) => {
      const src = d.sources.find((x) => x.id === sourceId);
      if (src) src.name = n;
    });
  },
  updateAudio(sourceId, patch, opts) {
    get().mutate((d) => {
      const src = d.sources.find((x) => x.id === sourceId);
      if (src) Object.assign(src.audio, patch);
    }, opts);
  },
  setFilters(sourceId, filters, opts) {
    get().mutate((d) => {
      const src = d.sources.find((x) => x.id === sourceId);
      if (src) src.filters = filters;
    }, opts);
  },
  setItemTransform(itemId, t, opts) {
    get().mutate((d) => {
      const f = findItem(d, itemId);
      if (f) f.item.transform = t;
    }, opts);
  },
  setItemVisible(itemId, visible) {
    get().mutate((d) => {
      const f = findItem(d, itemId);
      if (f) f.item.visible = visible;
    });
  },
  setItemLocked(itemId, locked) {
    get().mutate((d) => {
      const f = findItem(d, itemId);
      if (f) f.item.locked = locked;
    });
  },
  moveItem(itemId, where) {
    get().mutate((d) => {
      const f = findItem(d, itemId);
      if (!f) return;
      const items = f.scene.items;
      items.splice(f.index, 1);
      let to: number;
      // items[0] is the bottom-most layer
      if (where === 'up') to = Math.min(items.length, f.index + 1);
      else if (where === 'down') to = Math.max(0, f.index - 1);
      else if (where === 'top') to = items.length;
      else if (where === 'bottom') to = 0;
      else to = Math.max(0, Math.min(items.length, where));
      items.splice(to, 0, f.item);
    });
  },
  selectItems(ids) {
    set({ selectedItemIds: ids });
  },
  copyItem(itemId) {
    const f = findItem(get().collection, itemId);
    if (f) set({ clipboard: { sourceId: f.item.sourceId, transform: deepClone(f.item.transform) } });
  },
  pasteItem() {
    const s = get();
    const cb = s.clipboard;
    if (!cb || !s.collection.sources.some((x) => x.id === cb.sourceId)) return;
    const sceneId = s.editedSceneId();
    const src = s.collection.sources.find((x) => x.id === cb.sourceId)!;
    if (src.type === 'scene' && scenesContaining(s.collection, sceneId).has(src.settings.sceneId)) {
      s.notify('warning', 'A scene cannot contain itself.');
      return;
    }
    const item = createSceneItem(cb.sourceId, cb.transform);
    s.mutate((d) => {
      d.scenes.find((x) => x.id === sceneId)?.items.push(item);
    });
    set({ selectedItemIds: [item.id] });
  },
  duplicateItem(itemId) {
    const s = get();
    const f = findItem(s.collection, itemId);
    if (!f) return;
    const orig = s.collection.sources.find((x) => x.id === f.item.sourceId);
    if (!orig) return;
    const copy: Source = { ...deepClone(orig), id: uid('src'), name: uniqueName(s.collection.sources.map((x) => x.name), `${orig.name} (copy)`) };
    copy.filters = copy.filters.map((flt) => ({ ...flt, id: uid('vf') }));
    const item: SceneItem = { ...deepClone(f.item), id: uid('item'), sourceId: copy.id, transform: { ...f.item.transform, x: f.item.transform.x + 20, y: f.item.transform.y + 20 } };
    s.mutate((d) => {
      d.sources.push(copy);
      const sc = d.scenes.find((x) => x.id === f.scene.id);
      sc?.items.splice(f.index + 1, 0, item);
    });
    set({ selectedItemIds: [item.id] });
  },
  setGlobalAudio(sourceIds) {
    get().mutate((d) => {
      d.globalAudioSourceIds = sourceIds.filter((id) => d.sources.some((s) => s.id === id));
    });
  },
}));

export function sourceById(id: string): Source | undefined {
  return useStore.getState().collection.sources.find((s) => s.id === id);
}

export function itemById(id: string): SceneItem | undefined {
  const c = useStore.getState().collection;
  for (const sc of c.scenes) {
    const it = sc.items.find((i) => i.id === id);
    if (it) return it;
  }
  return undefined;
}
