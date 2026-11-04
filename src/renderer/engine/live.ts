import type { AlertEvent, AlertSettings, AlertTypeConfig, ChatMessage, ChatStatus, StreamLabelKind } from '@shared/types';
import { formatMoney } from '@shared/util';

type Listener = () => void;

class Emitter {
  private listeners = new Set<Listener>();
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  protected emit(): void {
    for (const l of this.listeners) l();
  }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export interface ActiveAlert {
  event: AlertEvent;
  config: AlertTypeConfig;
  start: number;
  durationMs: number;
}

/** Queues alerts so they play one after another, and keeps the recent-events history. */
export class AlertManager extends Emitter {
  private queue: ActiveAlert['event'][] = [];
  current: ActiveAlert | null = null;
  history: AlertEvent[] = loadJson<AlertEvent[]>('streamzar.alertHistory', []);
  private gapUntil = 0;
  private soundClaims = new Map<string, string>();
  private settings: AlertSettings | null = null;
  /** Listeners for newly received events (goals, labels). */
  private eventListeners = new Set<(e: AlertEvent) => void>();

  setSettings(s: AlertSettings): void {
    this.settings = s;
  }

  get globalVolume(): number {
    return this.settings?.globalVolume ?? 1;
  }

  onEvent(cb: (e: AlertEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  push(ev: AlertEvent, opts: { replay?: boolean } = {}): void {
    if (!opts.replay) {
      if (this.history.some((h) => h.id === ev.id)) return;
      this.history = [ev, ...this.history].slice(0, 100);
      saveJson('streamzar.alertHistory', this.history);
      for (const l of this.eventListeners) l(ev);
    }
    const cfg = this.settings?.types[ev.type];
    if (cfg?.enabled && (cfg.minAmount <= 0 || (ev.amount ?? 0) >= cfg.minAmount)) {
      this.queue.push(ev);
    }
    this.emit();
  }

  skip(): void {
    if (this.current) {
      this.current = null;
      this.emit();
    }
  }

  clearHistory(): void {
    this.history = [];
    saveJson('streamzar.alertHistory', []);
    this.emit();
  }

  get queued(): number {
    return this.queue.length;
  }

  tick(now: number): void {
    if (this.current && now - this.current.start >= this.current.durationMs) {
      this.current = null;
      this.gapUntil = now + (this.settings?.delayBetweenMs ?? 1000);
      this.emit();
    }
    if (!this.current && this.queue.length && now >= this.gapUntil && this.settings) {
      const ev = this.queue.shift()!;
      const config = this.settings.types[ev.type];
      this.current = { event: ev, config, start: now, durationMs: Math.max(1000, config.durationMs) };
      this.emit();
    }
  }

  /** Only one alert box plays the sound of a given alert. */
  claimSound(alertId: string, runtimeId: string): boolean {
    const owner = this.soundClaims.get(alertId);
    if (owner) return owner === runtimeId;
    this.soundClaims.set(alertId, runtimeId);
    if (this.soundClaims.size > 50) this.soundClaims.delete(this.soundClaims.keys().next().value as string);
    return true;
  }
}

/** Unified chat history from every platform (also used by the Chat Box widget). */
export class ChatFeed extends Emitter {
  messages: ChatMessage[] = [];
  statuses: ChatStatus[] = [];
  version = 0;

  add(m: ChatMessage): void {
    if (this.messages.length && this.messages[this.messages.length - 1].id === m.id) return;
    this.messages.push(m);
    if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300);
    this.version++;
    this.emit();
  }

  setStatuses(s: ChatStatus[]): void {
    this.statuses = s;
    this.emit();
  }

  clear(): void {
    this.messages = [];
    this.version++;
    this.emit();
  }

  get viewers(): number {
    return this.statuses.reduce((sum, s) => sum + (s.viewers ?? 0), 0);
  }
}

interface Latest {
  name: string;
  amount?: string;
  value?: number;
}

/** Values for Stream Labels ("latest follower", "session donations"...). */
export class SessionStats extends Emitter {
  latest: Partial<Record<string, Latest>> = loadJson('streamzar.latest', {});
  session = { followers: 0, subscribers: 0, donationTotal: 0, currency: 'USD' };
  version = 0;

  record(ev: AlertEvent): void {
    const set = (k: string, v: Latest) => {
      this.latest[k] = v;
    };
    switch (ev.type) {
      case 'follow':
        set('latest_follower', { name: ev.name });
        this.session.followers++;
        break;
      case 'subscription':
      case 'gift_sub':
        set('latest_subscriber', { name: ev.name });
        this.session.subscribers += ev.type === 'gift_sub' ? ev.count ?? 1 : 1;
        break;
      case 'membership':
        set('latest_member', { name: ev.name });
        this.session.subscribers++;
        break;
      case 'donation':
      case 'stars': {
        const v = { name: ev.name, amount: ev.formattedAmount, value: ev.amount ?? 0 };
        set('latest_donation', v);
        const top = this.latest.top_donation;
        if (!top || (top.value ?? 0) < (ev.amount ?? 0)) set('top_donation', v);
        this.session.donationTotal += ev.amount ?? 0;
        if (ev.currency) this.session.currency = ev.currency;
        break;
      }
      case 'superchat': {
        set('latest_superchat', { name: ev.name, amount: ev.formattedAmount, value: ev.amount });
        this.session.donationTotal += ev.amount ?? 0;
        break;
      }
      case 'bits':
        set('latest_cheer', { name: ev.name, amount: ev.formattedAmount, value: ev.amount });
        break;
      case 'raid':
        set('latest_raid', { name: ev.name, amount: ev.count !== undefined ? String(ev.count) : undefined });
        break;
    }
    saveJson('streamzar.latest', this.latest);
    this.version++;
    this.emit();
  }

  label(kind: StreamLabelKind, template: string, emptyText: string, viewers: number): string {
    const fill = (name: string, amount = '', count: string | number = '') =>
      template.replace(/\{name\}/g, name).replace(/\{amount\}/g, amount).replace(/\{count\}/g, String(count));
    switch (kind) {
      case 'session_follower_count':
        return fill('', '', this.session.followers);
      case 'session_subscriber_count':
        return fill('', '', this.session.subscribers);
      case 'session_donation_total':
        return fill('', formatMoney(this.session.donationTotal, this.session.currency), '');
      case 'viewer_count':
        return fill('', '', viewers);
      default: {
        const l = this.latest[kind];
        if (!l) return emptyText;
        return fill(l.name, l.amount ?? '', l.amount ?? '');
      }
    }
  }
}
