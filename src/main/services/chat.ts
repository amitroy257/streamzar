import { EventEmitter } from 'node:events';
import { net } from 'electron';
import WebSocket from 'ws';
import type { AlertEvent, ChatMessage, ChatStatus, IntegrationSettings } from '../../shared/types';
import {
  facebookToMessage,
  parseIrcLine,
  twitchToEvents,
  youtubeToEvents,
  type FacebookComment,
  type YouTubeChatItem,
} from '../../shared/chatParsers';
import { log } from '../logger';

type Platform = ChatStatus['platform'];
const FB_GRAPH = 'https://graph.facebook.com/v23.0';
const YT_API = 'https://www.googleapis.com/youtube/v3';

async function getJson<T>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> {
  const res = await net.fetch(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to the chat of every enabled platform and emits unified `message`, `alert` and `status`
 * events.
 */
export class ChatService extends EventEmitter {
  private statuses = new Map<Platform, ChatStatus>();
  private generation = 0;
  private twitch: { ws: WebSocket | null; channel: string; authed: boolean; username: string } | null = null;
  private youtube: { liveChatId: string; auth: { key?: string; token?: string } } | null = null;

  constructor(private readonly getSettings: () => IntegrationSettings) {
    super();
  }

  statusList(): ChatStatus[] {
    return [...this.statuses.values()];
  }

  private setStatus(platform: Platform, state: ChatStatus['state'], detail?: string, viewers?: number) {
    const prev = this.statuses.get(platform);
    this.statuses.set(platform, { platform, state, detail, viewers: viewers ?? prev?.viewers });
    this.emit('status', this.statusList());
  }

  async connect(): Promise<void> {
    this.disconnect();
    const gen = ++this.generation;
    const s = this.getSettings();
    if (s.twitch.enabled && s.twitch.channel.trim()) void this.runTwitch(gen, s.twitch);
    if (s.youtube.enabled && (s.youtube.apiKey.trim() || s.youtube.oauthToken.trim())) void this.runYouTube(gen, s.youtube);
    if (s.facebook.enabled && s.facebook.liveVideoId.trim() && s.facebook.accessToken.trim()) void this.runFacebook(gen, s.facebook);
    this.emit('status', this.statusList());
  }

  disconnect(): void {
    this.generation++;
    if (this.twitch?.ws) {
      try {
        this.twitch.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.twitch = null;
    this.youtube = null;
    this.statuses.clear();
    this.emit('status', []);
  }

  private alive(gen: number) {
    return gen === this.generation;
  }

  // ---------------------------------------------------------------------------
  // Twitch (IRC over WebSocket)
  // ---------------------------------------------------------------------------

  private async runTwitch(gen: number, cfg: IntegrationSettings['twitch']) {
    const channel = cfg.channel.trim().replace(/^#/, '').toLowerCase();
    const token = cfg.oauthToken.trim().replace(/^oauth:/i, '');
    const username = cfg.username.trim().toLowerCase();
    const authed = !!(token && username);
    let attempt = 0;
    while (this.alive(gen)) {
      this.setStatus('twitch', 'connecting', `#${channel}`);
      const closed = await new Promise<string>((resolve) => {
        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        this.twitch = { ws, channel, authed, username };
        let buffer = '';
        ws.on('open', () => {
          ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          if (authed) {
            ws.send(`PASS oauth:${token}`);
            ws.send(`NICK ${username}`);
          } else {
            ws.send('PASS SCHMOOPIIE');
            ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
          }
          ws.send(`JOIN #${channel}`);
        });
        ws.on('message', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\r\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const m = parseIrcLine(line);
            if (!m) continue;
            if (m.command === 'PING') {
              ws.send(`PONG :${m.params[0] ?? 'tmi.twitch.tv'}`);
            } else if (m.command === 'JOIN') {
              attempt = 0;
              this.setStatus('twitch', 'connected', `#${channel}${authed ? '' : ' (read-only)'}`);
            } else if (m.command === 'NOTICE' && /authentication failed|improperly formatted auth/i.test(m.params[1] ?? '')) {
              this.setStatus('twitch', 'error', 'Twitch login failed: check the OAuth token and username.');
              ws.close();
            } else if (m.command === 'RECONNECT') {
              ws.close();
            } else {
              const { message, alert } = twitchToEvents(m);
              if (message) this.emit('message', message);
              if (alert) this.emit('alert', alert);
            }
          }
        });
        ws.on('error', (err) => log('warn', `twitch chat error: ${err.message}`));
        ws.on('close', () => resolve('closed'));
      });
      void closed;
      if (!this.alive(gen)) return;
      const cur = this.statuses.get('twitch');
      if (cur?.state === 'error') return; // auth problems don't fix themselves
      attempt++;
      this.setStatus('twitch', 'connecting', 'Reconnecting…');
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube Data API v3
  // ---------------------------------------------------------------------------

  private ytUrl(path: string, params: Record<string, string>, auth: { key?: string; token?: string }) {
    const u = new URL(`${YT_API}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (!auth.token && auth.key) u.searchParams.set('key', auth.key);
    return u.toString();
  }

  private ytHeaders(auth: { key?: string; token?: string }): Record<string, string> {
    return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
  }

  private async runYouTube(gen: number, cfg: IntegrationSettings['youtube']) {
    const auth = { key: cfg.apiKey.trim() || undefined, token: cfg.oauthToken.trim() || undefined };
    while (this.alive(gen)) {
      try {
        this.setStatus('youtube', 'connecting', 'Looking for your live stream…');
        let videoId = cfg.videoId.trim();
        const urlMatch = /(?:v=|youtu\.be\/|\/live\/)([\w-]{11})/.exec(videoId);
        if (urlMatch) videoId = urlMatch[1];
        if (!videoId) {
          if (!cfg.channelId.trim()) throw new Error('Enter your channel ID or the live video ID/URL.');
          const search = await getJson<{ items?: { id: { videoId: string } }[] }>(
            this.ytUrl('search', { part: 'id', channelId: cfg.channelId.trim(), eventType: 'live', type: 'video', maxResults: '1' }, auth),
            { headers: this.ytHeaders(auth) },
          );
          videoId = search.items?.[0]?.id.videoId ?? '';
          if (!videoId) {
            this.setStatus('youtube', 'connecting', 'Waiting for the channel to go live…');
            await sleep(30000);
            continue;
          }
        }
        const vids = await getJson<{ items?: { liveStreamingDetails?: { activeLiveChatId?: string; concurrentViewers?: string } }[] }>(
          this.ytUrl('videos', { part: 'liveStreamingDetails', id: videoId }, auth),
          { headers: this.ytHeaders(auth) },
        );
        const details = vids.items?.[0]?.liveStreamingDetails;
        const liveChatId = details?.activeLiveChatId;
        if (!liveChatId) {
          this.setStatus('youtube', 'connecting', 'The video has no active live chat yet…');
          await sleep(20000);
          continue;
        }
        this.youtube = { liveChatId, auth };
        this.setStatus('youtube', 'connected', auth.token ? undefined : 'read-only', details?.concurrentViewers ? Number(details.concurrentViewers) : undefined);
        await this.pollYouTube(gen, liveChatId, videoId, auth);
      } catch (e) {
        if (!this.alive(gen)) return;
        const msg = (e as Error).message;
        log('warn', `youtube chat: ${msg}`);
        this.setStatus('youtube', 'error', msg);
        if (/API key not valid|forbidden|invalid credentials|quota/i.test(msg)) return;
        await sleep(15000);
      }
    }
  }

  private async pollYouTube(gen: number, liveChatId: string, videoId: string, auth: { key?: string; token?: string }) {
    let pageToken = '';
    let first = true;
    let lastViewerCheck = Date.now();
    const seen = new Set<string>();
    while (this.alive(gen)) {
      const params: Record<string, string> = { liveChatId, part: 'snippet,authorDetails', maxResults: '200' };
      if (pageToken) params.pageToken = pageToken;
      const res = await getJson<{ items?: YouTubeChatItem[]; nextPageToken?: string; pollingIntervalMillis?: number; offlineAt?: string }>(
        this.ytUrl('liveChat/messages', params, auth),
        { headers: this.ytHeaders(auth) },
      );
      if (!this.alive(gen)) return;
      for (const item of res.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const { message, alert } = youtubeToEvents(item);
        if (message) this.emit('message', message);
        // The first page contains recent history: show it, but don't replay alerts for it.
        if (alert && !first) this.emit('alert', alert);
      }
      if (seen.size > 5000) seen.clear();
      first = false;
      pageToken = res.nextPageToken ?? pageToken;
      if (res.offlineAt) {
        this.setStatus('youtube', 'disconnected', 'The live stream has ended.');
        return;
      }
      if (Date.now() - lastViewerCheck > 60000) {
        lastViewerCheck = Date.now();
        try {
          const v = await getJson<{ items?: { liveStreamingDetails?: { concurrentViewers?: string } }[] }>(
            this.ytUrl('videos', { part: 'liveStreamingDetails', id: videoId }, auth),
            { headers: this.ytHeaders(auth) },
          );
          const n = v.items?.[0]?.liveStreamingDetails?.concurrentViewers;
          if (n !== undefined) this.setStatus('youtube', 'connected', auth.token ? undefined : 'read-only', Number(n));
        } catch {
          /* non-fatal */
        }
      }
      await sleep(Math.max(3000, res.pollingIntervalMillis ?? 5000));
    }
  }

  // ---------------------------------------------------------------------------
  // Facebook Graph API
  // ---------------------------------------------------------------------------

  private async runFacebook(gen: number, cfg: IntegrationSettings['facebook']) {
    const videoId = cfg.liveVideoId.trim();
    const token = cfg.accessToken.trim();
    const seen = new Set<string>();
    let first = true;
    let lastViewerCheck = 0;
    this.setStatus('facebook', 'connecting');
    while (this.alive(gen)) {
      try {
        const url = `${FB_GRAPH}/${encodeURIComponent(videoId)}/comments?filter=stream&order=reverse_chronological&limit=50&fields=id,message,created_time,from{name,id}&access_token=${encodeURIComponent(token)}`;
        const res = await getJson<{ data?: FacebookComment[] }>(url);
        if (!this.alive(gen)) return;
        const fresh = (res.data ?? []).filter((c) => !seen.has(c.id)).reverse();
        for (const c of fresh) {
          seen.add(c.id);
          const m = facebookToMessage(c);
          if (m) this.emit('message', m);
        }
        if (seen.size > 5000) seen.clear();
        if (first || this.statuses.get('facebook')?.state !== 'connected') this.setStatus('facebook', 'connected');
        first = false;
        if (Date.now() - lastViewerCheck > 30000) {
          lastViewerCheck = Date.now();
          try {
            const v = await getJson<{ live_views?: number }>(`${FB_GRAPH}/${encodeURIComponent(videoId)}?fields=live_views&access_token=${encodeURIComponent(token)}`);
            if (typeof v.live_views === 'number') this.setStatus('facebook', 'connected', undefined, v.live_views);
          } catch {
            /* non-fatal */
          }
        }
      } catch (e) {
        if (!this.alive(gen)) return;
        const msg = (e as Error).message;
        log('warn', `facebook chat: ${msg}`);
        this.setStatus('facebook', 'error', msg);
        if (/access token|permission|OAuthException/i.test(msg)) return;
      }
      await sleep(3000);
    }
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(platform: Platform, text: string): Promise<void> {
    const body = text.trim().slice(0, 500);
    if (!body) return;
    if (platform === 'twitch') {
      const t = this.twitch;
      if (!t?.ws || t.ws.readyState !== WebSocket.OPEN) throw new Error('Twitch chat is not connected.');
      if (!t.authed) throw new Error('Add your Twitch username and OAuth token in Settings → Chat to send messages.');
      t.ws.send(`PRIVMSG #${t.channel} :${body.replace(/[\r\n]+/g, ' ')}`);
      this.emit('message', { id: `own_${Date.now()}`, platform: 'twitch', author: t.username, badges: ['broadcaster'], text: body, emotes: [], time: Date.now() } satisfies ChatMessage);
      return;
    }
    if (platform === 'youtube') {
      const y = this.youtube;
      if (!y) throw new Error('YouTube chat is not connected.');
      if (!y.auth.token) throw new Error('Sending to YouTube needs an OAuth access token (Settings → Chat).');
      await getJson(`${YT_API}/liveChat/messages?part=snippet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${y.auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ snippet: { liveChatId: y.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: body } } }),
      });
      return;
    }
    if (platform === 'facebook') {
      const s = this.getSettings().facebook;
      await getJson(`${FB_GRAPH}/${encodeURIComponent(s.liveVideoId.trim())}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: body, access_token: s.accessToken.trim() }).toString(),
      });
      return;
    }
    throw new Error('Unknown platform');
  }

  emitAlert(a: AlertEvent): void {
    this.emit('alert', a);
  }
}
