// Pure parsers for chat platforms. No network code here so everything is unit-testable.

import type { AlertEvent, ChatEmote, ChatMessage } from './types';
import { formatMoney } from './util';

// ---------------------------------------------------------------------------
// Twitch IRC
// ---------------------------------------------------------------------------

export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 's':
        return ' ';
      case ':':
        return ';';
      case '\\':
        return '\\';
      case 'r':
        return '\r';
      case 'n':
        return '\n';
      default:
        return c;
    }
  });
}

export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line.replace(/\r?\n$/, '');
  if (!rest) return null;
  const msg: IrcMessage = { tags: {}, prefix: '', command: '', params: [] };
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    for (const part of rest.slice(1, sp).split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) msg.tags[part] = '';
      else msg.tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    msg.prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  const trailingIdx = rest.indexOf(' :');
  let trailing: string | null = null;
  if (trailingIdx >= 0) {
    trailing = rest.slice(trailingIdx + 2);
    rest = rest.slice(0, trailingIdx);
  } else if (rest.startsWith(':')) {
    trailing = rest.slice(1);
    rest = '';
  }
  const parts = rest.split(' ').filter(Boolean);
  msg.command = (parts.shift() ?? '').toUpperCase();
  msg.params = parts;
  if (trailing !== null) msg.params.push(trailing);
  return msg.command ? msg : null;
}

/** Twitch emote positions are code point indices. */
export function parseTwitchEmotes(tag: string | undefined, text: string): ChatEmote[] {
  if (!tag) return [];
  const chars = Array.from(text);
  const out: ChatEmote[] = [];
  for (const group of tag.split('/')) {
    const [id, ranges] = group.split(':');
    if (!id || !ranges) continue;
    for (const r of ranges.split(',')) {
      const [a, b] = r.split('-').map((n) => parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || b >= chars.length) continue;
      out.push({
        start: a,
        end: b,
        name: chars.slice(a, b + 1).join(''),
        url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`,
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function twitchName(m: IrcMessage): string {
  return m.tags['display-name'] || m.tags['login'] || m.prefix.split('!')[0] || 'unknown';
}

export interface TwitchParseResult {
  message?: ChatMessage;
  alert?: AlertEvent;
}

let counter = 0;
const nextId = (p: string) => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function twitchToEvents(m: IrcMessage, now = Date.now()): TwitchParseResult {
  if (m.command === 'PRIVMSG') {
    let text = m.params[1] ?? '';
    let isAction = false;
    // /me messages are wrapped in CTCP ACTION
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) {
      text = text.slice(8, -1);
      isAction = true;
    }
    const name = twitchName(m);
    const badges = (m.tags['badges'] || '')
      .split(',')
      .filter(Boolean)
      .map((b) => b.split('/')[0]);
    const bits = parseInt(m.tags['bits'] || '0', 10);
    const message: ChatMessage = {
      id: m.tags['id'] || nextId('tw'),
      platform: 'twitch',
      author: name,
      authorColor: m.tags['color'] || undefined,
      badges,
      text,
      emotes: parseTwitchEmotes(m.tags['emotes'], text),
      time: now,
      isAction,
      highlight: bits > 0 ? `${bits} bits` : undefined,
    };
    const res: TwitchParseResult = { message };
    if (bits > 0) {
      res.alert = { id: nextId('al'), type: 'bits', platform: 'twitch', name, amount: bits, formattedAmount: `${bits} bits`, message: text, time: now };
    }
    return res;
  }
  if (m.command === 'USERNOTICE') {
    const id = m.tags['msg-id'];
    const name = twitchName(m);
    const userText = m.params[1];
    const systemMsg = m.tags['system-msg'] || '';
    const sysMessage: ChatMessage = {
      id: m.tags['id'] || nextId('tw'),
      platform: 'twitch',
      author: name,
      badges: [],
      text: systemMsg + (userText ? ` — ${userText}` : ''),
      emotes: [],
      time: now,
      highlight: 'event',
    };
    const months = parseInt(m.tags['msg-param-cumulative-months'] || m.tags['msg-param-months'] || '0', 10) || undefined;
    switch (id) {
      case 'sub':
      case 'resub':
        return {
          message: sysMessage,
          alert: { id: nextId('al'), type: 'subscription', platform: 'twitch', name, months, message: userText, time: now },
        };
      case 'submysterygift': {
        const count = parseInt(m.tags['msg-param-mass-gift-count'] || '1', 10) || 1;
        return { message: sysMessage, alert: { id: nextId('al'), type: 'gift_sub', platform: 'twitch', name, count, time: now } };
      }
      case 'subgift':
      case 'anonsubgift':
        // Individual gifts that are part of a mystery gift carry a community gift id; the mystery gift
        // notice already produced an alert for those.
        if (m.tags['msg-param-community-gift-id']) return { message: sysMessage };
        return { message: sysMessage, alert: { id: nextId('al'), type: 'gift_sub', platform: 'twitch', name, count: 1, time: now } };
      case 'raid': {
        const count = parseInt(m.tags['msg-param-viewerCount'] || '0', 10) || 0;
        const raider = m.tags['msg-param-displayName'] || name;
        return { message: sysMessage, alert: { id: nextId('al'), type: 'raid', platform: 'twitch', name: raider, count, time: now } };
      }
      default:
        return { message: sysMessage };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// YouTube Data API v3 liveChatMessages
// ---------------------------------------------------------------------------

export interface YouTubeChatItem {
  id: string;
  snippet: {
    type: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText: string };
    superChatDetails?: { amountMicros: string; currency: string; amountDisplayString: string; userComment?: string };
    superStickerDetails?: { amountMicros: string; currency: string; amountDisplayString: string };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    memberMilestoneChatDetails?: { memberMonth?: number; userComment?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number };
  };
  authorDetails?: {
    displayName: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
    isVerified?: boolean;
  };
}

export function youtubeToEvents(item: YouTubeChatItem, now = Date.now()): { message?: ChatMessage; alert?: AlertEvent } {
  const sn = item.snippet;
  const author = item.authorDetails?.displayName || 'YouTube user';
  const badges: string[] = [];
  if (item.authorDetails?.isChatOwner) badges.push('broadcaster');
  if (item.authorDetails?.isChatModerator) badges.push('moderator');
  if (item.authorDetails?.isChatSponsor) badges.push('member');
  if (item.authorDetails?.isVerified) badges.push('verified');
  const time = sn.publishedAt ? Date.parse(sn.publishedAt) || now : now;
  const base: ChatMessage = { id: item.id, platform: 'youtube', author, badges, text: sn.displayMessage || sn.textMessageDetails?.messageText || '', emotes: [], time };
  switch (sn.type) {
    case 'textMessageEvent':
      return { message: base };
    case 'superChatEvent': {
      const d = sn.superChatDetails;
      const amount = d ? Number(d.amountMicros) / 1_000_000 : 0;
      return {
        message: { ...base, text: d?.userComment ?? '', highlight: d?.amountDisplayString },
        alert: { id: `al_${item.id}`, type: 'superchat', platform: 'youtube', name: author, amount, currency: d?.currency, formattedAmount: d?.amountDisplayString || formatMoney(amount, d?.currency), message: d?.userComment, time },
      };
    }
    case 'superStickerEvent': {
      const d = sn.superStickerDetails;
      const amount = d ? Number(d.amountMicros) / 1_000_000 : 0;
      return {
        message: { ...base, text: 'sent a Super Sticker', highlight: d?.amountDisplayString },
        alert: { id: `al_${item.id}`, type: 'superchat', platform: 'youtube', name: author, amount, currency: d?.currency, formattedAmount: d?.amountDisplayString || formatMoney(amount, d?.currency), time },
      };
    }
    case 'newSponsorEvent':
      return { message: { ...base, highlight: 'member' }, alert: { id: `al_${item.id}`, type: 'membership', platform: 'youtube', name: author, message: sn.newSponsorDetails?.memberLevelName, time } };
    case 'memberMilestoneChatEvent':
      return {
        message: { ...base, text: sn.memberMilestoneChatDetails?.userComment || base.text, highlight: 'member' },
        alert: { id: `al_${item.id}`, type: 'membership', platform: 'youtube', name: author, months: sn.memberMilestoneChatDetails?.memberMonth, message: sn.memberMilestoneChatDetails?.userComment, time },
      };
    case 'membershipGiftingEvent':
      return {
        message: { ...base, highlight: 'gift' },
        alert: { id: `al_${item.id}`, type: 'gift_sub', platform: 'youtube', name: author, count: sn.membershipGiftingDetails?.giftMembershipsCount ?? 1, time },
      };
    default:
      return base.text ? { message: base } : {};
  }
}

// ---------------------------------------------------------------------------
// Facebook Graph API comments
// ---------------------------------------------------------------------------

export interface FacebookComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { name?: string; id?: string };
}

export function facebookToMessage(c: FacebookComment, now = Date.now()): ChatMessage | null {
  if (!c.message) return null;
  return {
    id: `fb_${c.id}`,
    platform: 'facebook',
    author: c.from?.name || 'Facebook user',
    badges: [],
    text: c.message,
    emotes: [],
    time: c.created_time ? Date.parse(c.created_time.replace(/\+0000$/, 'Z')) || now : now,
  };
}

// ---------------------------------------------------------------------------
// Webhook payloads (generic JSON and Ko-fi)
// ---------------------------------------------------------------------------

const ALERT_TYPE_SET = new Set(['follow', 'subscription', 'gift_sub', 'donation', 'bits', 'raid', 'superchat', 'membership', 'stars']);

/** Validate & normalise a generic webhook alert: {type, name, amount?, currency?, message?, months?, count?}. */
export function parseWebhookAlert(body: unknown, now = Date.now()): AlertEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const type = String(b.type ?? 'donation');
  if (!ALERT_TYPE_SET.has(type)) return null;
  const name = String(b.name ?? b.from ?? b.username ?? 'Someone').slice(0, 100);
  const amount = b.amount !== undefined ? Number(b.amount) : undefined;
  const currency = b.currency ? String(b.currency).toUpperCase().slice(0, 3) : undefined;
  const ev: AlertEvent = {
    id: `wh_${now.toString(36)}_${(counter++).toString(36)}`,
    type: type as AlertEvent['type'],
    platform: 'webhook',
    name,
    time: now,
  };
  if (amount !== undefined && Number.isFinite(amount)) {
    ev.amount = amount;
    ev.currency = currency;
    ev.formattedAmount = type === 'bits' ? `${amount} bits` : currency ? formatMoney(amount, currency) : String(amount);
  }
  if (b.message) ev.message = String(b.message).slice(0, 500);
  if (b.months !== undefined && Number.isFinite(Number(b.months))) ev.months = Number(b.months);
  if (b.count !== undefined && Number.isFinite(Number(b.count))) ev.count = Number(b.count);
  return ev;
}

/** Ko-fi sends application/x-www-form-urlencoded with a `data` field holding JSON. */
export function parseKofi(data: string, verificationToken: string, now = Date.now()): AlertEvent | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (verificationToken && d.verification_token !== verificationToken) return null;
  const type = String(d.type ?? 'Donation');
  const amount = Number(d.amount ?? 0);
  const currency = String(d.currency ?? 'USD').toUpperCase();
  const name = String(d.from_name ?? 'Someone');
  const isSub = type === 'Subscription';
  return {
    id: `kofi_${String(d.message_id ?? now)}`,
    type: isSub ? 'subscription' : 'donation',
    platform: 'webhook',
    name,
    amount,
    currency,
    formattedAmount: formatMoney(amount, currency),
    message: d.message ? String(d.message) : undefined,
    time: now,
  };
}

export function alertTemplateValues(ev: AlertEvent): Record<string, string | number | undefined> {
  return {
    name: ev.name,
    amount: ev.formattedAmount ?? (ev.amount !== undefined ? String(ev.amount) : ''),
    months: ev.months ? `(${ev.months} months)` : '',
    count: ev.count ?? '',
    message: ev.message ?? '',
    currency: ev.currency ?? '',
    platform: ev.platform,
  };
}
