// Boots the app: loads settings & the scene collection, creates the engine, and wires every event
// source (main-process status, chat, alerts, hotkeys, remote control) to the store and engine.

import type { RemoteCommand, RemoteState } from '@shared/types';
import { validateDestination } from '@shared/platforms';
import { api } from '../api';
import { Engine } from '../engine/engine';
import { flushSave, useStore } from './store';

let engine: Engine | null = null;

export function getEngine(): Engine {
  if (!engine) throw new Error('engine not started');
  return engine;
}

export function engineOrNull(): Engine | null {
  return engine;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Output actions (used by buttons, hotkeys and the remote)
// ---------------------------------------------------------------------------

export async function startStreaming(): Promise<void> {
  const s = useStore.getState();
  if (s.output.streaming || s.output.streamStarting) return;
  const dests = s.settings.stream.destinations.filter((d) => d.enabled);
  if (!dests.length) {
    s.openDialog({ kind: 'goLive' });
    return;
  }
  for (const d of dests) {
    const problem = validateDestination(d);
    if (problem) {
      s.notify('error', problem);
      s.openDialog({ kind: 'goLive' });
      return;
    }
  }
  try {
    await flushSave();
    await api.output.startStream();
  } catch (e) {
    s.notify('error', `Could not go live: ${errMsg(e)}`);
  }
}

export async function stopStreaming(force = false): Promise<void> {
  try {
    await api.output.stopStream(force);
  } catch (e) {
    useStore.getState().notify('error', errMsg(e));
  }
}

/** Ask for confirmation (if enabled) before ending the stream. */
export function requestStopStreaming(): void {
  const s = useStore.getState();
  if (!s.output.streaming) return;
  if (s.settings.stream.confirmStop) {
    s.openDialog({
      kind: 'confirm',
      title: 'End stream?',
      message: s.output.delaySec ? `Your stream has a ${s.output.delaySec}s delay: the remaining delayed video will still be sent before it ends.` : 'Viewers on every platform will see the stream end.',
      confirmLabel: 'End Stream',
      danger: true,
      onConfirm: () => void stopStreaming(),
    });
  } else {
    void stopStreaming();
  }
}

export async function toggleRecording(): Promise<void> {
  const s = useStore.getState();
  try {
    if (s.output.recording) await api.output.stopRecording();
    else await api.output.startRecording();
  } catch (e) {
    s.notify('error', `Recording: ${errMsg(e)}`);
  }
}

export async function toggleReplayBuffer(): Promise<void> {
  const s = useStore.getState();
  try {
    if (s.output.replayBuffer) await api.output.stopReplayBuffer();
    else await api.output.startReplayBuffer();
  } catch (e) {
    s.notify('error', `Replay buffer: ${errMsg(e)}`);
  }
}

export async function saveReplay(): Promise<void> {
  try {
    await api.output.saveReplay();
  } catch (e) {
    useStore.getState().notify('error', errMsg(e));
  }
}

export async function takeScreenshot(): Promise<void> {
  try {
    const path = await getEngine().screenshot();
    useStore.getState().notify('success', 'Screenshot saved', { label: 'Show', run: () => void api.files.showItemInFolder(path) });
  } catch (e) {
    useStore.getState().notify('error', `Screenshot failed: ${errMsg(e)}`);
  }
}

export function runAction(action: string): void {
  const s = useStore.getState();
  switch (action) {
    case 'toggleStream':
      if (s.output.streaming) requestStopStreaming();
      else void startStreaming();
      break;
    case 'startStream':
      void startStreaming();
      break;
    case 'stopStream':
      void stopStreaming();
      break;
    case 'toggleRecording':
      void toggleRecording();
      break;
    case 'startRecording':
      if (!s.output.recording) void toggleRecording();
      break;
    case 'stopRecording':
      if (s.output.recording) void toggleRecording();
      break;
    case 'toggleReplayBuffer':
      void toggleReplayBuffer();
      break;
    case 'saveReplay':
      void saveReplay();
      break;
    case 'toggleStudioMode':
      s.setStudioMode(!s.studioMode);
      break;
    case 'transition':
      s.transitionToPreview();
      break;
    case 'screenshot':
      void takeScreenshot();
      break;
    default:
      if (action.startsWith('scene:')) s.selectScene(action.slice(6));
      else if (action.startsWith('mute:')) {
        const id = action.slice(5);
        const src = s.collection.sources.find((x) => x.id === id);
        if (src) s.updateAudio(id, { muted: !src.audio.muted }, { history: false });
      }
  }
}

function handleRemote(c: RemoteCommand) {
  const s = useStore.getState();
  switch (c.type) {
    case 'switchScene':
      if (s.studioMode) {
        s.selectScene(c.sceneId);
        s.transitionToPreview();
      } else s.selectScene(c.sceneId);
      break;
    case 'previewScene':
      s.selectScene(c.sceneId);
      break;
    case 'transition':
      s.transitionToPreview();
      break;
    case 'toggleMute': {
      const src = s.collection.sources.find((x) => x.id === c.sourceId);
      if (src) s.updateAudio(src.id, { muted: !src.audio.muted }, { history: false });
      break;
    }
    case 'setVolume':
      s.updateAudio(c.sourceId, { volumeDb: c.volumeDb }, { history: false });
      break;
    case 'toggleStudioMode':
      s.setStudioMode(!s.studioMode);
      break;
    case 'hotkey':
      runAction(c.action);
      break;
  }
}

/** Audio sources shown in the mixer: global ones plus those used in the program/edited scenes. */
export function mixerSourceIds(): string[] {
  const s = useStore.getState();
  const c = s.collection;
  const ids: string[] = [...c.globalAudioSourceIds];
  const audioTypes = new Set(['audio_input', 'audio_output', 'media', 'browser', 'alert_box']);
  const visit = (sceneId: string, depth: number) => {
    const sc = c.scenes.find((x) => x.id === sceneId);
    if (!sc || depth > 8) return;
    for (const it of sc.items) {
      const src = c.sources.find((x) => x.id === it.sourceId);
      if (!src) continue;
      if (src.type === 'scene') visit(src.settings.sceneId, depth + 1);
      else if (audioTypes.has(src.type) && !ids.includes(src.id)) {
        if (src.type === 'browser' && !src.settings.captureAudio) continue;
        ids.push(src.id);
      }
    }
  };
  visit(c.activeSceneId, 0);
  if (s.studioMode && s.previewSceneId) visit(s.previewSceneId, 0);
  return ids.filter((id) => c.sources.some((x) => x.id === id));
}

function publishRemote() {
  const s = useStore.getState();
  const c = s.collection;
  const state: RemoteState = {
    scenes: c.scenes.map((x) => ({ id: x.id, name: x.name })),
    activeSceneId: c.activeSceneId,
    previewSceneId: s.previewSceneId,
    studioMode: s.studioMode,
    audio: mixerSourceIds().map((id) => {
      const src = c.sources.find((x) => x.id === id)!;
      return { id, name: src.name, muted: src.audio.muted, volumeDb: src.audio.volumeDb };
    }),
    output: {
      streaming: s.output.streaming,
      recording: s.output.recording,
      replayBuffer: s.output.replayBuffer,
      streamStartedAt: s.output.streamStartedAt,
      recordingStartedAt: s.output.recordingStartedAt,
    },
  };
  api.remote.publishState(state);
}

/** Global hotkeys: fixed actions plus per-scene "switch to" hotkeys stored as scene:<id>. */
export async function registerHotkeys(): Promise<Record<string, boolean>> {
  const map = useStore.getState().settings.hotkeys;
  try {
    const result = await api.hotkeys.register(map);
    const failed = Object.entries(result).filter(([, ok]) => !ok);
    if (failed.length) useStore.getState().notify('warning', `${failed.length} hotkey(s) could not be registered (already used by another app or invalid).`);
    return result;
  } catch (e) {
    useStore.getState().notify('error', `Hotkeys: ${errMsg(e)}`);
    return {};
  }
}

export async function boot(): Promise<void> {
  const store = useStore;
  try {
    const settings = await api.settings.get();
    const activeId = await api.collections.getActive();
    const collection = activeId ? await api.collections.load(activeId) : null;
    if (!collection) throw new Error('No scene collection could be loaded.');
    const collections = await api.collections.list();
    const output = await api.output.getStatus();
    store.setState({ settings, collection, collections, output, showChat: settings.general.showChat });

    engine = new Engine(api, settings, {
      patchSourceSettings: (id, patch) => store.getState().updateSourceSettings(id, patch, { history: false }),
      onIssues: (issues) => store.setState({ issues }),
    });
    engine.setCollection(collection);
    engine.setStreamStartedAt(output.streamStartedAt);

    // Keep the engine in sync with the store.
    store.subscribe((s, prev) => {
      if (!engine) return;
      if (s.settings !== prev.settings) engine.setSettings(s.settings);
      if (s.collection !== prev.collection) engine.setCollection(s.collection);
      if (s.studioMode !== prev.studioMode || s.previewSceneId !== prev.previewSceneId) engine.setStudio(s.studioMode, s.previewSceneId);
      if (s.output.streamStartedAt !== prev.output.streamStartedAt) engine.setStreamStartedAt(s.output.streamStartedAt);
      if (s.collection !== prev.collection || s.output !== prev.output || s.studioMode !== prev.studioMode || s.previewSceneId !== prev.previewSceneId) publishRemote();
      if (s.settings.hotkeys !== prev.settings.hotkeys) void registerHotkeys();
    });

    api.output.onStatus((o) => {
      const prev = store.getState().output;
      store.setState({ output: o });
      if (o.streaming && !prev.streaming) store.getState().notify('success', 'You are live!');
      if (!o.streaming && prev.streaming) store.getState().notify('info', 'Stream ended.');
    });
    api.output.onNotice((n) => {
      const st = store.getState();
      const isSaved = /^(Recording|Replay) saved: (.+)$/.exec(n.message);
      if (isSaved) {
        const path = isSaved[2];
        st.notify('success', `${isSaved[1]} saved`, { label: 'Show file', run: () => void api.files.showItemInFolder(path) });
      } else st.notify(n.level, n.message);
    });
    api.output.onCaptureRequest((req) => {
      void engine?.handleCaptureRequest(req).then(() => {
        if (engine?.captureError) store.getState().notify('error', `Video capture failed: ${engine.captureError}`);
      });
    });
    api.system.onStats((st) => store.setState({ system: st }));
    api.chat.onMessage((m) => engine?.chat.add(m));
    api.chat.onStatus((st) => {
      engine?.chat.setStatuses(st);
      store.setState({ chatStatuses: st });
    });
    api.chat.onAlert((a) => engine?.alerts.push(a));
    api.hotkeys.onTriggered((action) => runAction(action));
    api.remote.onCommand((c) => handleRemote(c));
    api.settings.onChanged((s) => store.setState({ settings: s }));
    api.browserSources.onFrame((f) => {
      const rt = engine?.runtime(f.id) as { onFrame?: (x: typeof f) => void } | undefined;
      rt?.onFrame?.(f);
    });

    // Re-open failed capture devices when hardware is plugged in.
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      const c = store.getState().collection;
      for (const src of c.sources) {
        if (store.getState().issues[src.id] && (src.type === 'video_capture' || src.type === 'audio_input' || src.type === 'audio_output')) {
          engine?.runtime(src.id)?.reload?.();
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      void flushSave();
    });

    store.setState({ ready: true });
    // Debug/automation handle (used by the end-to-end tests and handy in DevTools).
    (window as unknown as { __streamzar: unknown }).__streamzar = { store, engine, runAction };
    publishRemote();
    void registerHotkeys();
    api.encoders
      .list()
      .then((list) => store.setState({ encoders: list }))
      .catch((e: Error) => store.getState().notify('error', e.message));
    const ints = settings.integrations;
    if (ints.twitch.enabled || ints.youtube.enabled || ints.facebook.enabled) void api.chat.connect().catch(() => undefined);
  } catch (e) {
    store.setState({ loadError: errMsg(e) });
    api.system.log('error', `boot failed: ${errMsg(e)}`);
  }
}
