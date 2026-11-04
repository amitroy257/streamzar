import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFile, rename, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStorage } from 'electron';
import type { AppSettings, CollectionMeta, SceneCollection } from '../shared/types';
import { COLLECTION_VERSION, createCollection, defaultSettings, defaultTransition } from '../shared/defaults';
import { mergeDefaults, normalizeOutputSize } from '../shared/util';
import { log } from './logger';

const ENC_PREFIX = 'enc:v1:';

function encrypt(value: string): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch {
    /* fall through */
  }
  return value;
}

function decrypt(value: string): string {
  if (!value || !value.startsWith(ENC_PREFIX)) return value ?? '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    log('warn', 'could not decrypt a stored secret (keychain changed?) - it has been cleared');
    return '';
  }
}

/** Apply fn to every secret field (stream keys, tokens). */
function mapSecrets(s: AppSettings, fn: (v: string) => string): AppSettings {
  const c = JSON.parse(JSON.stringify(s)) as AppSettings;
  c.stream.destinations = c.stream.destinations.map((d) => ({ ...d, streamKey: fn(d.streamKey) }));
  c.integrations.twitch.oauthToken = fn(c.integrations.twitch.oauthToken);
  c.integrations.youtube.apiKey = fn(c.integrations.youtube.apiKey);
  c.integrations.youtube.oauthToken = fn(c.integrations.youtube.oauthToken);
  c.integrations.facebook.accessToken = fn(c.integrations.facebook.accessToken);
  c.server.token = fn(c.server.token);
  return c;
}

function writeAtomicSync(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Clamp settings values that would otherwise break the pipeline. */
export function sanitizeSettings(input: unknown): AppSettings {
  const s = mergeDefaults(defaultSettings(), input);
  const v = s.video;
  v.baseWidth = Math.max(64, Math.min(7680, Math.round(v.baseWidth) || 1920));
  v.baseHeight = Math.max(64, Math.min(4320, Math.round(v.baseHeight) || 1080));
  const out = normalizeOutputSize(v.outputWidth || v.baseWidth, v.outputHeight || v.baseHeight);
  v.outputWidth = out.width;
  v.outputHeight = out.height;
  if (!(v.fpsNum > 0) || !(v.fpsDen > 0) || v.fpsNum / v.fpsDen > 240) {
    v.fpsNum = 30;
    v.fpsDen = 1;
  }
  if (s.audio.sampleRate !== 44100 && s.audio.sampleRate !== 48000) s.audio.sampleRate = 48000;
  for (const enc of [s.output.stream, s.output.recording.encoder]) {
    enc.videoBitrate = Math.max(200, Math.min(200000, Math.round(enc.videoBitrate) || 6000));
    enc.maxBitrate = Math.max(enc.videoBitrate, Math.min(400000, Math.round(enc.maxBitrate) || enc.videoBitrate));
    enc.audioBitrate = Math.max(64, Math.min(512, Math.round(enc.audioBitrate) || 160));
    enc.keyframeSec = Math.max(1, Math.min(10, Math.round(enc.keyframeSec) || 2));
    enc.cq = Math.max(0, Math.min(51, Math.round(enc.cq)));
    enc.bframes = Math.max(0, Math.min(4, Math.round(enc.bframes)));
  }
  s.stream.delaySec = Math.max(0, Math.min(600, Math.round(s.stream.delaySec) || 0));
  s.stream.reconnectDelaySec = Math.max(1, Math.min(120, Math.round(s.stream.reconnectDelaySec) || 5));
  s.stream.maxRetries = Math.max(0, Math.min(1000, Math.round(s.stream.maxRetries)));
  s.stream.destinations = s.stream.destinations.filter((d) => d && typeof d.id === 'string');
  s.output.replayBuffer.durationSec = Math.max(5, Math.min(600, Math.round(s.output.replayBuffer.durationSec) || 30));
  s.server.port = Math.max(1024, Math.min(65535, Math.round(s.server.port) || 59650));
  if (!s.server.token) s.server.token = crypto.randomBytes(16).toString('hex');
  return s;
}

export class Store {
  readonly dir: string;
  private settingsFile: string;
  private stateFile: string;
  private collectionsDir: string;
  private settings: AppSettings;

  constructor(userData: string) {
    this.dir = userData;
    this.settingsFile = path.join(userData, 'settings.json');
    this.stateFile = path.join(userData, 'state.json');
    this.collectionsDir = path.join(userData, 'scene-collections');
    mkdirSync(this.collectionsDir, { recursive: true });
    this.settings = this.loadSettingsSync();
  }

  private loadSettingsSync(): AppSettings {
    let raw: unknown = undefined;
    if (existsSync(this.settingsFile)) {
      try {
        raw = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
      } catch (e) {
        log('error', `settings file is corrupt, using defaults: ${(e as Error).message}`);
        try {
          renameSync(this.settingsFile, `${this.settingsFile}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }
    const s = sanitizeSettings(raw ? mapSecrets(mergeDefaults(defaultSettings(), raw), decrypt) : undefined);
    // Persist right away so migrations and generated values (API token) are stable across launches.
    try {
      this.persistSettingsSync(s);
    } catch (e) {
      log('error', `could not write settings: ${(e as Error).message}`);
    }
    return s;
  }

  private persistSettingsSync(s: AppSettings) {
    writeAtomicSync(this.settingsFile, JSON.stringify(mapSecrets(s, encrypt), null, 2));
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  async setSettings(next: unknown): Promise<AppSettings> {
    const s = sanitizeSettings(next);
    this.settings = s;
    await writeAtomic(this.settingsFile, JSON.stringify(mapSecrets(s, encrypt), null, 2));
    return s;
  }

  // ---------------------------------------------------------------------------
  // Scene collections
  // ---------------------------------------------------------------------------

  private collectionFile(id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid collection id');
    return path.join(this.collectionsDir, `${id}.json`);
  }

  async listCollections(): Promise<CollectionMeta[]> {
    const out: CollectionMeta[] = [];
    for (const f of await readdir(this.collectionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await readFile(path.join(this.collectionsDir, f), 'utf8')) as SceneCollection;
        if (c && typeof c.id === 'string' && typeof c.name === 'string') out.push({ id: c.id, name: c.name, updatedAt: c.updatedAt ?? 0 });
      } catch {
        log('warn', `skipping unreadable scene collection ${f}`);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadCollection(id: string): Promise<SceneCollection | null> {
    const file = this.collectionFile(id);
    if (!existsSync(file)) return null;
    try {
      return validateCollection(JSON.parse(await readFile(file, 'utf8')));
    } catch (e) {
      log('error', `failed to load scene collection ${id}: ${(e as Error).message}`);
      return null;
    }
  }

  async saveCollection(c: SceneCollection): Promise<void> {
    const valid = validateCollection(c);
    await writeAtomic(this.collectionFile(valid.id), JSON.stringify(valid));
  }

  async deleteCollection(id: string): Promise<void> {
    await rm(this.collectionFile(id), { force: true });
  }

  getActiveCollectionId(): string | null {
    try {
      const st = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { activeCollectionId?: string };
      return st.activeCollectionId && ID_RE.test(st.activeCollectionId) ? st.activeCollectionId : null;
    } catch {
      return null;
    }
  }

  async setActiveCollectionId(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error('invalid collection id');
    await writeAtomic(this.stateFile, JSON.stringify({ activeCollectionId: id }));
  }

  /** Make sure at least one collection exists; returns the active one's id. */
  async ensureCollection(): Promise<string> {
    const list = await this.listCollections();
    const active = this.getActiveCollectionId();
    if (active && list.some((c) => c.id === active)) return active;
    if (list.length) {
      await this.setActiveCollectionId(list[0].id);
      return list[0].id;
    }
    const c = createCollection('Default', { width: this.settings.video.baseWidth, height: this.settings.video.baseHeight });
    await this.saveCollection(c);
    await this.setActiveCollectionId(c.id);
    return c.id;
  }

  /** Remove leftover temp files from interrupted writes. */
  cleanupTemp(): void {
    for (const dir of [this.dir, this.collectionsDir]) {
      try {
        for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) rmSync(path.join(dir, f), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Structural validation for collections coming from disk, import or IPC. */
export function validateCollection(input: unknown): SceneCollection {
  if (!input || typeof input !== 'object') throw new Error('not a scene collection');
  const c = input as SceneCollection;
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) throw new Error('scene collection has an invalid id');
  if (typeof c.name !== 'string') throw new Error('scene collection has no name');
  if (!Array.isArray(c.scenes) || !Array.isArray(c.sources)) throw new Error('scene collection is missing scenes or sources');
  if (!c.scenes.length) throw new Error('scene collection has no scenes');
  for (const sc of c.scenes) {
    if (typeof sc.id !== 'string' || !Array.isArray(sc.items)) throw new Error('invalid scene');
  }
  for (const so of c.sources) {
    if (typeof so.id !== 'string' || typeof so.type !== 'string' || typeof so.settings !== 'object') throw new Error('invalid source');
  }
  if (!c.scenes.some((s) => s.id === c.activeSceneId)) c.activeSceneId = c.scenes[0].id;
  if (!Array.isArray(c.globalAudioSourceIds)) c.globalAudioSourceIds = [];
  c.transition = mergeDefaults(defaultTransition(), c.transition);
  c.version = c.version || COLLECTION_VERSION;
  return c;
}
