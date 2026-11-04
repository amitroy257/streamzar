import type { Destination, PlatformId } from './types';

export interface PlatformServer {
  label: string;
  url: string;
}

export interface PlatformInfo {
  id: PlatformId;
  label: string;
  color: string;
  servers: PlatformServer[];
  /** Whether the user normally has to paste a per-stream server URL */
  serverEditable: boolean;
  /** Recommended upper limit for video bitrate (kbps). Used for warnings only. */
  maxVideoKbps: number;
  maxHeight: number;
  maxFps: number;
  keyHelp: string;
  dashboardUrl: string;
}

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    color: '#ff0033',
    servers: [
      { label: 'Primary (RTMPS, recommended)', url: 'rtmps://a.rtmps.youtube.com:443/live2' },
      { label: 'Backup (RTMPS)', url: 'rtmps://b.rtmps.youtube.com:443/live2?backup=1' },
      { label: 'Primary (RTMP)', url: 'rtmp://a.rtmp.youtube.com/live2' },
      { label: 'Backup (RTMP)', url: 'rtmp://b.rtmp.youtube.com/live2?backup=1' },
    ],
    serverEditable: false,
    maxVideoKbps: 51000,
    maxHeight: 2160,
    maxFps: 60,
    keyHelp: 'YouTube Studio → Create → Go live → Stream → copy "Stream key".',
    dashboardUrl: 'https://studio.youtube.com/channel/UC/livestreaming',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook',
    color: '#1877f2',
    servers: [{ label: 'Facebook Live (RTMPS)', url: 'rtmps://live-api-s.facebook.com:443/rtmp' }],
    serverEditable: false,
    maxVideoKbps: 9000,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'Facebook → Live video → Streaming software → copy the persistent "Stream key".',
    dashboardUrl: 'https://www.facebook.com/live/producer',
  },
  twitch: {
    id: 'twitch',
    label: 'Twitch',
    color: '#9146ff',
    servers: [
      { label: 'Auto (closest, RTMP)', url: 'rtmp://live.twitch.tv/app' },
      { label: 'Auto (closest, RTMPS)', url: 'rtmps://live.twitch.tv:443/app' },
    ],
    serverEditable: false,
    maxVideoKbps: 8500,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'Twitch Creator Dashboard → Settings → Stream → "Primary Stream key".',
    dashboardUrl: 'https://dashboard.twitch.tv/settings/stream',
  },
  kick: {
    id: 'kick',
    label: 'Kick',
    color: '#53fc18',
    servers: [{ label: 'Kick (RTMPS)', url: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app' }],
    serverEditable: true,
    maxVideoKbps: 8000,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'Kick dashboard → Settings → Stream URL & Key. Paste both the Stream URL and the key.',
    dashboardUrl: 'https://kick.com/dashboard/settings/stream',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    color: '#25f4ee',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 6000,
    maxHeight: 1920,
    maxFps: 60,
    keyHelp: 'TikTok LIVE Studio / LIVE Center → "Server URL" and "Stream key" (changes for every stream).',
    dashboardUrl: 'https://www.tiktok.com/live/creators',
  },
  x: {
    id: 'x',
    label: 'X (Twitter)',
    color: '#e7e9ea',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 9000,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'X Media Studio → Producer → Sources → create a source and copy the RTMP URL and key.',
    dashboardUrl: 'https://studio.x.com/producer',
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    color: '#0a66c2',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 6000,
    maxHeight: 1080,
    maxFps: 30,
    keyHelp: 'LinkedIn Live event → "Stream URL" and "Stream key".',
    dashboardUrl: 'https://www.linkedin.com/video/golive/now',
  },
  trovo: {
    id: 'trovo',
    label: 'Trovo',
    color: '#19d66b',
    servers: [{ label: 'Trovo', url: 'rtmp://livepush.trovo.live/live' }],
    serverEditable: true,
    maxVideoKbps: 9000,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'Trovo Creator Studio → Stream settings → Stream key.',
    dashboardUrl: 'https://studio.trovo.live/',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    color: '#e1306c',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 6000,
    maxHeight: 1920,
    maxFps: 30,
    keyHelp: 'Instagram (web) → Create → Live video → copy the "Stream URL" and "Stream key".',
    dashboardUrl: 'https://www.instagram.com/',
  },
  rumble: {
    id: 'rumble',
    label: 'Rumble',
    color: '#85c742',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 9000,
    maxHeight: 1080,
    maxFps: 60,
    keyHelp: 'Rumble → Go Live → Live stream settings → copy the "Stream URL" and "Stream key".',
    dashboardUrl: 'https://rumble.com/live',
  },
  custom: {
    id: 'custom',
    label: 'Custom RTMP / SRT',
    color: '#8b95a7',
    servers: [],
    serverEditable: true,
    maxVideoKbps: 100000,
    maxHeight: 4320,
    maxFps: 120,
    keyHelp: 'Any RTMP(S) or SRT server. Leave the key empty if it is already part of the URL.',
    dashboardUrl: '',
  },
};

export const PLATFORM_ORDER: PlatformId[] = [
  'youtube',
  'facebook',
  'twitch',
  'kick',
  'tiktok',
  'x',
  'instagram',
  'linkedin',
  'trovo',
  'rumble',
  'custom',
];

export type OutputProtocol = 'rtmp' | 'srt';

/**
 * Compose the final ingest URL from a server URL and a stream key.
 * Throws a user-readable Error if the destination is not usable.
 */
export function buildIngestUrl(server: string, streamKey: string): { url: string; protocol: OutputProtocol } {
  const s = server.trim();
  const key = streamKey.trim();
  if (!s) throw new Error('No server URL configured');
  if (/\s/.test(key)) throw new Error('Stream key must not contain spaces');
  const lower = s.toLowerCase();
  if (lower.startsWith('srt://')) {
    // SRT: the key (if any) is passed as the streamid parameter.
    if (!key) return { url: s, protocol: 'srt' };
    const sep = s.includes('?') ? '&' : '?';
    return { url: `${s}${sep}streamid=${encodeURIComponent(key)}`, protocol: 'srt' };
  }
  if (!lower.startsWith('rtmp://') && !lower.startsWith('rtmps://')) {
    throw new Error('Server URL must start with rtmp://, rtmps:// or srt://');
  }
  if (!key) return { url: s, protocol: 'rtmp' };
  // Servers such as YouTube's backup ingest carry a query string ("?backup=1") that must stay
  // attached to the application path, so insert the key before the query.
  const q = s.indexOf('?');
  const base = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, '');
  const query = q >= 0 ? s.slice(q) : '';
  if (query) {
    // e.g. rtmps://b.rtmps.youtube.com:443/live2?backup=1 -> rtmps://b.rtmps.youtube.com:443/live2/KEY?backup=1
    return { url: `${base}/${key}${key.includes('?') ? query.replace('?', '&') : query}`, protocol: 'rtmp' };
  }
  return { url: `${base}/${key}`, protocol: 'rtmp' };
}

export function validateDestination(d: Destination): string | null {
  if (!d.server.trim()) return `${d.name}: server URL is missing`;
  if (d.platform !== 'custom' && !d.streamKey.trim()) return `${d.name}: stream key is missing`;
  try {
    buildIngestUrl(d.server, d.streamKey);
  } catch (e) {
    return `${d.name}: ${(e as Error).message}`;
  }
  return null;
}

/** Hide a stream key / URL secret for logs. */
export function redactUrl(url: string, key: string): string {
  let out = url;
  if (key) out = out.split(key).join('••••');
  const enc = key ? encodeURIComponent(key) : '';
  if (enc && enc !== key) out = out.split(enc).join('••••');
  return out;
}

export interface BitratePreset {
  label: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

export const QUALITY_PRESETS: BitratePreset[] = [
  { label: '4K 60fps (YouTube only)', width: 3840, height: 2160, fps: 60, kbps: 35000 },
  { label: '1440p 60fps', width: 2560, height: 1440, fps: 60, kbps: 18000 },
  { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, kbps: 9000 },
  { label: '1080p 30fps', width: 1920, height: 1080, fps: 30, kbps: 6000 },
  { label: '720p 60fps', width: 1280, height: 720, fps: 60, kbps: 6000 },
  { label: '720p 30fps', width: 1280, height: 720, fps: 30, kbps: 4000 },
  { label: '480p 30fps', width: 854, height: 480, fps: 30, kbps: 2000 },
];

export function bitrateWarnings(destinations: Destination[], kbps: number, height: number, fps: number): string[] {
  const out: string[] = [];
  for (const d of destinations) {
    if (!d.enabled) continue;
    const p = PLATFORMS[d.platform];
    if (kbps > p.maxVideoKbps) out.push(`${d.name}: ${kbps} kbps is above the recommended ${p.maxVideoKbps} kbps for ${p.label}.`);
    if (height > p.maxHeight) out.push(`${d.name}: ${p.label} accepts up to ${p.maxHeight}p.`);
    if (fps > p.maxFps + 0.01) out.push(`${d.name}: ${p.label} accepts up to ${p.maxFps} fps.`);
  }
  return out;
}
