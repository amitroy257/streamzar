import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { IPC, type AppInfo } from '../shared/ipc';
import type { AppSettings, BrowserSourceOptions, CaptureSourceInfo, RemoteState, SceneCollection } from '../shared/types';
import { buildRemuxArgs } from '../shared/ffmpegArgs';
import { formatFilename, uid } from '../shared/util';
import { initLogger, log, getLogDir } from './logger';
import { APP_HOST, APP_ORIGIN, handleAppProtocol, registerSchemes } from './protocol';
import { Store, validateCollection } from './store';
import { OutputManager } from './output/outputManager';
import { FfmpegLocator } from './output/ffmpegLocator';
import { runFfmpeg } from './output/replayBuffer';
import { BrowserSourceManager } from './browserSources';
import { ChatService } from './services/chat';
import { LocalServer } from './services/server';
import { Hotkeys } from './services/hotkeys';
import { StatsSampler } from './services/stats';

// ---------------------------------------------------------------------------
// Early setup (before 'ready')
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.env.STREAMZAR_USER_DATA) app.setPath('userData', process.env.STREAMZAR_USER_DATA);
app.setName('Streamzar');
initLogger(path.join(app.getPath('userData'), 'logs'));
log('info', `Streamzar ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}/${process.arch})`);

const store = new Store(app.getPath('userData'));
store.cleanupTemp();

// The compositor must keep running at full speed while the window is minimised or covered by a game.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
if (process.platform === 'darwin') app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
if (!store.getSettings().advanced.hardwareAcceleration) app.disableHardwareAcceleration();

registerSchemes();

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

let mainWindow: BrowserWindow | null = null;
let quitting = false;

const locator = new FfmpegLocator(log);
const resolveFfmpeg = async () => (await locator.resolve(store.getSettings().advanced.ffmpegPath)).path;
const defaultRecordingDir = () => path.join(app.getPath('videos'), 'Streamzar');

function send(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// The renderer's AudioContext is created once with this rate; a change applies after a restart.
const startupSampleRate = store.getSettings().audio.sampleRate;

const outputs = new OutputManager({
  getSettings: () => store.getSettings(),
  sampleRate: () => startupSampleRate,
  resolveFfmpeg,
  defaultRecordingDir,
  log,
  onStatus: (s) => {
    send(IPC.outputStatus, s);
    server.publishState(remoteStateWithOutput());
  },
  onCaptureRequest: (r) => send(IPC.captureRequest, r),
  onNotice: (level, message) => {
    log(level === 'warning' ? 'warn' : level, message);
    send(IPC.outputNotice, { level, message });
  },
});

const browserSources = new BrowserSourceManager(() => mainWindow?.webContents ?? null);
const chat = new ChatService(() => store.getSettings().integrations);
const server = new LocalServer();
const hotkeys = new Hotkeys((action) => send(IPC.hotkeyTriggered, action));
const stats = new StatsSampler();
let remoteState: RemoteState | null = null;

function remoteStateWithOutput(): RemoteState {
  const o = outputs.status();
  const base: RemoteState = remoteState ?? { scenes: [], activeSceneId: '', previewSceneId: null, studioMode: false, audio: [], output: o };
  return { ...base, output: { streaming: o.streaming, recording: o.recording, replayBuffer: o.replayBuffer, streamStartedAt: o.streamStartedAt, recordingStartedAt: o.recordingStartedAt } };
}

chat.on('message', (m) => send(IPC.chatMessage, m));
chat.on('status', (s) => send(IPC.chatStatus, s));
chat.on('alert', (a) => send(IPC.alertEvent, a));
server.on('alert', (a) => send(IPC.alertEvent, a));
server.on('command', (c) => send(IPC.remoteCommand, c));

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** All invoke handlers return {ok,value}|{ok:false,error} so the renderer gets clean messages. */
function handle<A extends unknown[], T>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => T | Promise<T>) {
  ipcMain.handle(channel, async (e, ...args): Promise<Result<T>> => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
    try {
      return { ok: true, value: await fn(e, ...(args as A)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `${channel} failed: ${message}`);
      return { ok: false, error: message };
    }
  });
}

function isTrustedSender(e: { senderFrame: Electron.WebFrameMain | null }): boolean {
  const url = e.senderFrame?.url ?? '';
  return url.startsWith(`${APP_ORIGIN}/`);
}

function on(channel: string, fn: (...args: unknown[]) => void) {
  ipcMain.on(channel, (e, ...args) => {
    if (isTrustedSender(e)) fn(...args);
  });
}

function registerIpc() {
  handle(IPC.settingsGet, () => store.getSettings());
  handle(IPC.settingsSet, async (_e, next: AppSettings) => {
    const saved = await store.setSettings(next);
    void server.apply(saved.server);
    return saved;
  });

  handle(IPC.collectionsList, () => store.listCollections());
  handle(IPC.collectionsLoad, (_e, id: string) => store.loadCollection(id));
  handle(IPC.collectionsSave, (_e, c: SceneCollection) => store.saveCollection(c));
  handle(IPC.collectionsDelete, (_e, id: string) => store.deleteCollection(id));
  handle(IPC.collectionsGetActive, () => store.ensureCollection());
  handle(IPC.collectionsSetActive, (_e, id: string) => store.setActiveCollectionId(id));
  handle(IPC.collectionsExport, async (_e, c: SceneCollection) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export scene collection',
      defaultPath: `${c.name.replace(/[<>:"/\\|?*]/g, '-')}.streamzar.json`,
      filters: [{ name: 'Streamzar scene collection', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, JSON.stringify(c, null, 2), 'utf8');
    return r.filePath;
  });
  handle(IPC.collectionsImport, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: 'Import scene collection', properties: ['openFile'], filters: [{ name: 'Streamzar scene collection', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const raw = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8')) as SceneCollection;
    raw.id = uid('col');
    const c = validateCollection(raw);
    c.name = `${c.name} (imported)`;
    c.updatedAt = Date.now();
    await store.saveCollection(c);
    return c;
  });

  handle(IPC.outputStartStream, () => outputs.startStream());
  handle(IPC.outputStopStream, (_e, force?: boolean) => outputs.stopStream(!!force));
  handle(IPC.outputStartRecording, () => outputs.startRecording());
  handle(IPC.outputStopRecording, () => outputs.stopRecording());
  handle(IPC.outputStartReplay, () => outputs.startReplayBuffer());
  handle(IPC.outputStopReplay, () => outputs.stopReplayBuffer());
  handle(IPC.outputSaveReplay, () => outputs.saveReplay());
  handle(IPC.outputGetStatus, () => outputs.status());

  handle(IPC.encodersList, (_e, refresh?: boolean) => locator.encoders(store.getSettings().advanced.ffmpegPath, !!refresh));

  handle(IPC.captureSources, async (_e, kinds: ('screen' | 'window')[]) => {
    const types = kinds.filter((k) => k === 'screen' || k === 'window');
    const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return sources
      .filter((s) => !s.name.startsWith('Streamzar') || s.id.startsWith('screen'))
      .map(
        (s): CaptureSourceInfo => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen') ? 'screen' : 'window',
          thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
          displayId: s.display_id || undefined,
        }),
      );
  });

  handle(IPC.dialogOpenFile, async (_e, opts?: { title?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts?.title, properties: ['openFile'], filters: opts?.filters });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle(IPC.dialogOpenFiles, async (_e, opts?: { title?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts?.title, properties: ['openFile', 'multiSelections'], filters: opts?.filters });
    return r.canceled ? [] : r.filePaths;
  });
  handle(IPC.dialogOpenDirectory, async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle(IPC.fsReadText, async (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('invalid path');
    const st = await fs.stat(p);
    if (st.size > 1024 * 1024) throw new Error('File is larger than 1 MB');
    return fs.readFile(p, 'utf8');
  });
  handle(IPC.shellShowItem, (_e, p: string) => {
    if (typeof p === 'string' && existsSync(p)) shell.showItemInFolder(p);
  });
  handle(IPC.shellOpenPath, async (_e, p: string) => {
    if (typeof p === 'string' && existsSync(p)) await shell.openPath(p);
  });
  handle(IPC.shellOpenExternal, async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  handle(IPC.saveScreenshot, async (_e, png: Uint8Array) => {
    const s = store.getSettings();
    const dir = s.output.recording.path.trim() || defaultRecordingDir();
    await fs.mkdir(dir, { recursive: true });
    let file = path.join(dir, `Screenshot ${formatFilename('%Y-%m-%d %H-%M-%S', new Date())}.png`);
    for (let i = 1; existsSync(file); i++) file = path.join(dir, `Screenshot ${formatFilename('%Y-%m-%d %H-%M-%S', new Date())} (${i}).png`);
    await fs.writeFile(file, Buffer.from(png));
    return file;
  });
  handle(IPC.remux, async (_e, input: string) => {
    if (typeof input !== 'string' || !existsSync(input)) throw new Error('File not found');
    const ext = path.extname(input).toLowerCase();
    if (!['.mkv', '.flv', '.ts', '.mov', '.webm'].includes(ext)) throw new Error('Choose an MKV, FLV, TS or MOV recording');
    const base = input.slice(0, -ext.length);
    let out = `${base}.mp4`;
    for (let i = 1; existsSync(out); i++) out = `${base} (${i}).mp4`;
    await runFfmpeg(await resolveFfmpeg(), buildRemuxArgs(input, out, 'mp4'));
    return out;
  });

  handle(IPC.browserCreate, (_e, id: string, opts: BrowserSourceOptions) => browserSources.create(id, opts));
  handle(IPC.browserUpdate, (_e, id: string, opts: BrowserSourceOptions) => browserSources.update(id, opts));
  handle(IPC.browserDestroy, (_e, id: string) => browserSources.destroy(id));
  handle(IPC.browserRefresh, (_e, id: string) => browserSources.refresh(id));
  handle(IPC.browserMediaSourceId, (e, id: string) => browserSources.mediaSourceId(id, e.sender));
  handle(IPC.browserInteract, (_e, id: string, ev: Parameters<BrowserSourceManager['interact']>[1]) => browserSources.interact(id, ev));

  handle(IPC.chatConnect, () => chat.connect());
  handle(IPC.chatDisconnect, () => chat.disconnect());
  handle(IPC.chatSend, (_e, platform: 'twitch' | 'youtube' | 'facebook', text: string) => chat.send(platform, text));

  handle(IPC.hotkeysRegister, (_e, map: Record<string, string>) => hotkeys.register(map));

  on(IPC.remotePublishState, (state) => {
    remoteState = state as RemoteState;
    server.publishState(remoteStateWithOutput());
  });
  handle(IPC.serverInfo, () => server.getInfo());
  handle(IPC.serverRegenerateToken, async () => {
    const s = store.getSettings();
    const saved = await store.setSettings({ ...s, server: { ...s.server, token: '' } });
    send(IPC.settingsChanged, saved);
    return server.apply(saved.server);
  });

  handle(IPC.appInfo, async (): Promise<AppInfo> => {
    let ffmpegPath = '';
    let ffmpegVersion = 'not found';
    try {
      const ff = await locator.resolve(store.getSettings().advanced.ffmpegPath);
      ffmpegPath = ff.path;
      ffmpegVersion = ff.version;
    } catch {
      /* reported in UI */
    }
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      ffmpegPath,
      ffmpegVersion,
      userData: app.getPath('userData'),
      defaultRecordingPath: defaultRecordingDir(),
    };
  });
  handle(IPC.openLogs, async () => {
    await shell.openPath(getLogDir());
  });
  on(IPC.log, (level, message) => {
    if ((level === 'info' || level === 'warn' || level === 'error') && typeof message === 'string') log(level, `[ui] ${message.slice(0, 2000)}`);
  });
}

// ---------------------------------------------------------------------------
// Sessions, permissions, capture
// ---------------------------------------------------------------------------

function configureSession() {
  const ses = session.defaultSession;
  handleAppProtocol(ses, RENDERER_DIR);
  const allowed = new Set(['media', 'display-capture', 'local-fonts', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(`${APP_ORIGIN}/`) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => origin.startsWith(APP_ORIGIN) && allowed.has(permission));
  // getDisplayMedia() is only used for desktop (loopback) audio. Video is discarded by the renderer.
  ses.setDisplayMediaRequestHandler(
    (_req, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) return callback({});
          if (process.platform === 'linux') return callback({ video: sources[0] });
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  // Block navigation to anything outside the app.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (ev, url) => {
      if (wc.getType() === 'window' && wc.session === ses && !url.startsWith(`${APP_ORIGIN}/`)) ev.preventDefault();
    });
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createMainWindow() {
  const theme = store.getSettings().general.theme;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Streamzar',
    icon: process.platform === 'darwin' ? undefined : path.join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: theme === 'light' ? '#f3f4f7' : '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs Node's net module for the high-bandwidth raw capture link.
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${APP_ORIGIN}/projector.html`)) {
      const params = new URL(url).searchParams;
      const displayId = params.get('display');
      const display = displayId ? screen.getAllDisplays().find((d) => String(d.id) === displayId) : undefined;
      const b = display?.bounds;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Streamzar Projector',
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          width: b ? b.width : 960,
          height: b ? b.height : 540,
          x: b?.x,
          y: b?.y,
          fullscreen: !!display,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-finish-load', () => {
    // A reload while live must re-establish the capture link.
    outputs.resendCaptureRequest();
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('error', `renderer process gone: ${details.reason} (${details.exitCode})`);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) setTimeout(() => mainWindow?.webContents.reload(), 1000);
  });
  mainWindow.on('close', (e) => {
    if (quitting || !outputs.active) return;
    const st = outputs.status();
    const what = [st.streaming && 'streaming', st.recording && 'recording', st.replayBuffer && 'running the replay buffer'].filter(Boolean).join(' and ');
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Stop and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Streamzar',
      message: `You are currently ${what}.`,
      detail: 'Quitting will end it. Recordings are saved before Streamzar closes.',
    });
    if (choice !== 0) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    void shutdown();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Off-screen browser-source windows keep 'window-all-closed' from firing, so quit explicitly.
    void shutdown();
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  try {
    await Promise.race([outputs.shutdown(), new Promise((r) => setTimeout(r, 20000))]);
  } catch (e) {
    log('error', `shutdown error: ${(e as Error).message}`);
  }
  hotkeys.clear();
  chat.disconnect();
  browserSources.destroyAll();
  await server.stop();
  stats.stop();
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', (e) => {
  if (!quitting && outputs.active) {
    e.preventDefault();
    mainWindow?.close();
  } else if (!quitting) {
    quitting = true;
  }
});

app.on('window-all-closed', () => {
  void shutdown();
});

app.on('will-quit', () => hotkeys.clear());

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      ]),
    );
  }
  configureSession();
  registerIpc();
  await store.ensureCollection();
  void server.apply(store.getSettings().server);
  stats.start(2000, (s) => send(IPC.systemStats, s));
  createMainWindow();
  // Warm up FFmpeg discovery and hardware encoder detection in the background.
  void locator.encoders(store.getSettings().advanced.ffmpegPath).catch((e: Error) => log('error', e.message));
  log('info', `ready; renderer at ${APP_ORIGIN} (${APP_HOST})`);
});

process.on('uncaughtException', (err) => log('error', `uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log('error', `unhandled rejection: ${(err as Error)?.stack ?? String(err)}`));
