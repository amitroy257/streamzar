import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import net from 'node:net';
import { IPC, type RawCaptureLink, type StreamzarApi } from '../shared/ipc';
import { RAW_HEADER_SIZE, RAW_TYPE_AUDIO, RAW_TYPE_VIDEO, writeRawHeader } from '../shared/rawProtocol';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r || typeof r !== 'object') throw new Error('No response from the app');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void) {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * High-bandwidth uplink for the program output (raw I420 frames, ~180 MB/s at 1080p60). It goes over a
 * local TCP socket straight to the MediaHub instead of IPC.
 */
class CaptureLink implements RawCaptureLink {
  private sock: net.Socket | null = null;
  private header = new Uint8Array(RAW_HEADER_SIZE);
  private view = new DataView(this.header.buffer);

  open(port: number, token: string): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.setNoDelay(true);
      const fail = (err: Error) => {
        s.destroy();
        if (this.sock === s) this.sock = null;
        reject(err);
      };
      s.once('error', fail);
      s.once('connect', () => {
        s.off('error', fail);
        s.on('error', () => undefined);
        s.on('close', () => {
          if (this.sock === s) this.sock = null;
        });
        s.write(`${token}\n`);
        this.sock = s;
        resolve();
      });
    });
  }

  private writeFrame(type: number, tsUs: number, payload: Uint8Array): boolean {
    const s = this.sock;
    if (!s || s.destroyed) return false;
    writeRawHeader(this.view, type, payload.byteLength, tsUs);
    s.write(Buffer.from(this.header));
    // contextBridge hands us a copy, so the buffer can be queued without copying again.
    s.write(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    return true;
  }

  writeVideo(tsUs: number, frame: Uint8Array): boolean {
    return this.writeFrame(RAW_TYPE_VIDEO, tsUs, frame);
  }

  writeAudio(tsUs: number, samples: Float32Array): void {
    this.writeFrame(RAW_TYPE_AUDIO, tsUs, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  backlog(): number {
    return this.sock ? this.sock.writableLength : 0;
  }

  close(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }
}

const capture = new CaptureLink();

const api: StreamzarApi = {
  platform: process.platform,
  settings: {
    get: () => call(IPC.settingsGet),
    set: (s) => call(IPC.settingsSet, s),
    onChanged: (cb) => subscribe(IPC.settingsChanged, cb),
  },
  collections: {
    list: () => call(IPC.collectionsList),
    load: (id) => call(IPC.collectionsLoad, id),
    save: (c) => call(IPC.collectionsSave, c),
    delete: (id) => call(IPC.collectionsDelete, id),
    getActive: () => call(IPC.collectionsGetActive),
    setActive: (id) => call(IPC.collectionsSetActive, id),
    exportTo: (c) => call(IPC.collectionsExport, c),
    importFrom: () => call(IPC.collectionsImport),
  },
  output: {
    startStream: () => call(IPC.outputStartStream),
    stopStream: (force) => call(IPC.outputStopStream, !!force),
    startRecording: () => call(IPC.outputStartRecording),
    stopRecording: () => call(IPC.outputStopRecording),
    startReplayBuffer: () => call(IPC.outputStartReplay),
    stopReplayBuffer: () => call(IPC.outputStopReplay),
    saveReplay: () => call(IPC.outputSaveReplay),
    getStatus: () => call(IPC.outputGetStatus),
    onStatus: (cb) => subscribe(IPC.outputStatus, cb),
    onNotice: (cb) => subscribe(IPC.outputNotice, cb),
    onCaptureRequest: (cb) => subscribe(IPC.captureRequest, cb),
  },
  capture: {
    open: (port, token) => capture.open(port, token),
    writeVideo: (ts, frame) => capture.writeVideo(ts, frame),
    writeAudio: (ts, samples) => capture.writeAudio(ts, samples),
    backlog: () => capture.backlog(),
    close: () => capture.close(),
  },
  encoders: { list: (refresh) => call(IPC.encodersList, !!refresh) },
  desktop: { getSources: (kinds) => call(IPC.captureSources, kinds) },
  files: {
    openFile: (opts) => call(IPC.dialogOpenFile, opts),
    openFiles: (opts) => call(IPC.dialogOpenFiles, opts),
    openDirectory: (title) => call(IPC.dialogOpenDirectory, title),
    readText: (p) => call(IPC.fsReadText, p),
    showItemInFolder: (p) => call(IPC.shellShowItem, p),
    openPath: (p) => call(IPC.shellOpenPath, p),
    openExternal: (url) => call(IPC.shellOpenExternal, url),
    saveScreenshot: (png) => call(IPC.saveScreenshot, png),
    remux: (p) => call(IPC.remux, p),
    mediaUrl: (p) => `app://streamzar/__media/${encodeURIComponent(p)}`,
    remoteUrl: (u) => `app://streamzar/__remote?url=${encodeURIComponent(u)}`,
  },
  browserSources: {
    create: (id, opts) => call(IPC.browserCreate, id, opts),
    update: (id, opts) => call(IPC.browserUpdate, id, opts),
    destroy: (id) => call(IPC.browserDestroy, id),
    refresh: (id) => call(IPC.browserRefresh, id),
    mediaSourceId: (id) => call(IPC.browserMediaSourceId, id),
    interact: (id, ev) => call(IPC.browserInteract, id, ev),
    onFrame: (cb) => subscribe(IPC.browserFrame, cb),
  },
  chat: {
    connect: () => call(IPC.chatConnect),
    disconnect: () => call(IPC.chatDisconnect),
    send: (platform, text) => call(IPC.chatSend, platform, text),
    onMessage: (cb) => subscribe(IPC.chatMessage, cb),
    onStatus: (cb) => subscribe(IPC.chatStatus, cb),
    onAlert: (cb) => subscribe(IPC.alertEvent, cb),
  },
  hotkeys: {
    register: (map) => call(IPC.hotkeysRegister, map),
    onTriggered: (cb) => subscribe(IPC.hotkeyTriggered, cb),
  },
  remote: {
    publishState: (state) => ipcRenderer.send(IPC.remotePublishState, state),
    onCommand: (cb) => subscribe(IPC.remoteCommand, cb),
    getInfo: () => call(IPC.serverInfo),
    regenerateToken: () => call(IPC.serverRegenerateToken),
  },
  system: {
    onStats: (cb) => subscribe(IPC.systemStats, cb),
    info: () => call(IPC.appInfo),
    openLogs: () => call(IPC.openLogs),
    log: (level, message) => ipcRenderer.send(IPC.log, level, message),
  },
};

contextBridge.exposeInMainWorld('streamzar', api);
