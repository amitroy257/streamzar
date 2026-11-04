import type {
  AlertEvent,
  AppSettings,
  BrowserSourceFrame,
  BrowserSourceOptions,
  CaptureRequest,
  CaptureSourceInfo,
  ChatMessage,
  ChatStatus,
  CollectionMeta,
  EncoderInfo,
  OutputStatus,
  RemoteCommand,
  RemoteState,
  SceneCollection,
  ServerInfo,
  SystemStats,
} from './types';

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',
  collectionsList: 'collections:list',
  collectionsLoad: 'collections:load',
  collectionsSave: 'collections:save',
  collectionsDelete: 'collections:delete',
  collectionsGetActive: 'collections:get-active',
  collectionsSetActive: 'collections:set-active',
  collectionsExport: 'collections:export',
  collectionsImport: 'collections:import',

  outputStartStream: 'output:start-stream',
  outputStopStream: 'output:stop-stream',
  outputStartRecording: 'output:start-recording',
  outputStopRecording: 'output:stop-recording',
  outputStartReplay: 'output:start-replay',
  outputStopReplay: 'output:stop-replay',
  outputSaveReplay: 'output:save-replay',
  outputStatus: 'output:status',
  outputGetStatus: 'output:get-status',
  outputNotice: 'output:notice',
  captureRequest: 'capture:request',

  encodersList: 'encoders:list',
  captureSources: 'capture:sources',

  dialogOpenFile: 'dialog:open-file',
  dialogOpenFiles: 'dialog:open-files',
  dialogOpenDirectory: 'dialog:open-directory',
  shellShowItem: 'shell:show-item',
  shellOpenPath: 'shell:open-path',
  shellOpenExternal: 'shell:open-external',
  fsReadText: 'fs:read-text',
  saveScreenshot: 'fs:save-screenshot',
  remux: 'media:remux',

  browserCreate: 'browser-source:create',
  browserUpdate: 'browser-source:update',
  browserDestroy: 'browser-source:destroy',
  browserRefresh: 'browser-source:refresh',
  browserInteract: 'browser-source:interact',
  browserFrame: 'browser-source:frame',
  browserMediaSourceId: 'browser-source:media-id',

  chatConnect: 'chat:connect',
  chatDisconnect: 'chat:disconnect',
  chatSend: 'chat:send',
  chatMessage: 'chat:message',
  chatStatus: 'chat:status',
  alertEvent: 'alert:event',

  hotkeysRegister: 'hotkeys:register',
  hotkeyTriggered: 'hotkeys:triggered',

  remotePublishState: 'remote:publish-state',
  remoteCommand: 'remote:command',
  serverInfo: 'server:info',
  serverRegenerateToken: 'server:regenerate-token',

  systemStats: 'system:stats',
  appInfo: 'app:info',
  openLogs: 'app:open-logs',
  log: 'app:log',
} as const;

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  ffmpegPath: string;
  ffmpegVersion: string;
  userData: string;
  defaultRecordingPath: string;
}

export interface OpenFileOptions {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface Unsubscribe {
  (): void;
}

/** Raw A/V uplink from the renderer to the main-process MediaHub. */
export interface RawCaptureLink {
  open(port: number, token: string): Promise<void>;
  writeVideo(timestampUs: number, frame: Uint8Array): boolean;
  writeAudio(timestampUs: number, samples: Float32Array): void;
  /** Bytes queued in the socket but not yet sent. */
  backlog(): number;
  close(): void;
}

export interface StreamzarApi {
  platform: string;
  settings: {
    get(): Promise<AppSettings>;
    set(settings: AppSettings): Promise<AppSettings>;
    onChanged(cb: (s: AppSettings) => void): Unsubscribe;
  };
  collections: {
    list(): Promise<CollectionMeta[]>;
    load(id: string): Promise<SceneCollection | null>;
    save(c: SceneCollection): Promise<void>;
    delete(id: string): Promise<void>;
    getActive(): Promise<string | null>;
    setActive(id: string): Promise<void>;
    exportTo(c: SceneCollection): Promise<string | null>;
    importFrom(): Promise<SceneCollection | null>;
  };
  output: {
    startStream(): Promise<void>;
    stopStream(force?: boolean): Promise<void>;
    startRecording(): Promise<void>;
    stopRecording(): Promise<void>;
    startReplayBuffer(): Promise<void>;
    stopReplayBuffer(): Promise<void>;
    saveReplay(): Promise<string>;
    getStatus(): Promise<OutputStatus>;
    onStatus(cb: (s: OutputStatus) => void): Unsubscribe;
    onNotice(cb: (n: { level: 'info' | 'warning' | 'error'; message: string }) => void): Unsubscribe;
    onCaptureRequest(cb: (r: CaptureRequest) => void): Unsubscribe;
  };
  capture: RawCaptureLink;
  encoders: { list(refresh?: boolean): Promise<EncoderInfo[]> };
  desktop: {
    getSources(kinds: ('screen' | 'window')[]): Promise<CaptureSourceInfo[]>;
  };
  files: {
    openFile(opts?: OpenFileOptions): Promise<string | null>;
    openFiles(opts?: OpenFileOptions): Promise<string[]>;
    openDirectory(title?: string): Promise<string | null>;
    readText(path: string): Promise<string>;
    showItemInFolder(path: string): Promise<void>;
    openPath(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    saveScreenshot(png: Uint8Array): Promise<string>;
    remux(path: string): Promise<string>;
    /** URL the renderer can load a local file from */
    mediaUrl(path: string): string;
    /** URL for remote images that must not taint WebGL textures */
    remoteUrl(url: string): string;
  };
  browserSources: {
    create(id: string, opts: BrowserSourceOptions): Promise<void>;
    update(id: string, opts: BrowserSourceOptions): Promise<void>;
    destroy(id: string): Promise<void>;
    refresh(id: string): Promise<void>;
    mediaSourceId(id: string): Promise<string | null>;
    interact(id: string, event: { type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel'; x: number; y: number; deltaY?: number }): Promise<void>;
    onFrame(cb: (f: BrowserSourceFrame) => void): Unsubscribe;
  };
  chat: {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(platform: 'twitch' | 'youtube' | 'facebook', text: string): Promise<void>;
    onMessage(cb: (m: ChatMessage) => void): Unsubscribe;
    onStatus(cb: (s: ChatStatus[]) => void): Unsubscribe;
    onAlert(cb: (a: AlertEvent) => void): Unsubscribe;
  };
  hotkeys: {
    register(map: Record<string, string>): Promise<Record<string, boolean>>;
    onTriggered(cb: (action: string) => void): Unsubscribe;
  };
  remote: {
    publishState(state: RemoteState): void;
    onCommand(cb: (c: RemoteCommand) => void): Unsubscribe;
    getInfo(): Promise<ServerInfo>;
    regenerateToken(): Promise<ServerInfo>;
  };
  system: {
    onStats(cb: (s: SystemStats) => void): Unsubscribe;
    info(): Promise<AppInfo>;
    openLogs(): Promise<void>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
  };
}
