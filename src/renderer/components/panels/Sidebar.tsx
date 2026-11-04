import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Bell, Send, RotateCcw, SkipForward, Trash2, Settings, Users } from 'lucide-react';
import type { AlertType, ChatMessage } from '@shared/types';
import { ALERT_TYPE_LABELS, ALERT_TYPES } from '@shared/defaults';
import { formatMoney, uid } from '@shared/util';
import { api } from '../../api';
import { useStore } from '../../state/store';
import { engineOrNull } from '../../state/controller';
import { eventLine } from '../../engine/widgets/widgets';
import { useEmitter, Select, openMenu } from '../ui';

const PLAT_COLORS: Record<string, string> = { twitch: '#9146ff', youtube: '#ff0033', facebook: '#1877f2', system: '#8b95a7' };
const PLAT_LETTER: Record<string, string> = { twitch: 'T', youtube: '▶', facebook: 'f', system: '•' };

function MessageView({ m }: { m: ChatMessage }) {
  const chars = Array.from(m.text);
  const parts: React.ReactNode[] = [];
  let i = 0;
  m.emotes.forEach((e, k) => {
    if (e.start < i) return;
    if (e.start > i) parts.push(chars.slice(i, e.start).join(''));
    parts.push(<img key={k} className="emote" src={api.files.remoteUrl(e.url)} alt={e.name} title={e.name} />);
    i = e.end + 1;
  });
  if (i < chars.length) parts.push(chars.slice(i).join(''));
  return (
    <div className={`chat-msg ${m.highlight ? 'highlight' : ''}`}>
      <span className="plat" style={{ background: PLAT_COLORS[m.platform] }}>
        {PLAT_LETTER[m.platform]}
      </span>
      {m.badges.slice(0, 2).map((b) => (
        <span key={b} className="badge">
          {b}
        </span>
      ))}
      <span className="author" style={{ color: m.authorColor || undefined }}>
        {m.author}
        {m.isAction ? '' : ':'}
      </span>
      {m.highlight && m.highlight !== 'event' && <span className="pill ok" style={{ marginRight: 4 }}>{m.highlight}</span>}
      <span style={m.isAction ? { fontStyle: 'italic' } : undefined}>{parts}</span>
    </div>
  );
}

function ChatTab() {
  const eng = engineOrNull();
  const statuses = useStore((s) => s.chatStatuses);
  const integrations = useStore((s) => s.settings.integrations);
  const st = useStore.getState();
  const messages = useEmitter(eng!.chat, () => eng!.chat.messages.slice(-200));
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const connected = statuses.filter((s) => s.state === 'connected');
  const [target, setTarget] = useState<'twitch' | 'youtube' | 'facebook'>('twitch');
  const stick = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (connected.length && !connected.some((c) => c.platform === target)) setTarget(connected[0].platform);
  }, [connected, target]);
  const anyEnabled = integrations.twitch.enabled || integrations.youtube.enabled || integrations.facebook.enabled;
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      await api.chat.send(target, t);
      setText('');
    } catch (e) {
      st.notify('error', (e as Error).message);
    }
  };
  return (
    <>
      <div className="chat-status">
        {statuses.map((s) => (
          <span key={s.platform} className={`pill ${s.state === 'connected' ? 'ok' : s.state === 'error' ? 'err' : 'warn'}`} title={s.detail}>
            {s.platform} · {s.state}
            {s.viewers !== undefined && (
              <>
                {' '}
                · <Users size={11} /> {s.viewers}
              </>
            )}
          </span>
        ))}
        {!statuses.length && <span className="muted">{anyEnabled ? 'Chat is not connected.' : 'Connect Twitch, YouTube or Facebook chat in Settings → Chat.'}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void api.chat.connect().catch((e: Error) => st.notify('error', e.message))} disabled={!anyEnabled} title="Reconnect chat">
          {statuses.length ? 'Reconnect' : 'Connect'}
        </button>
        <button className="icon-btn" title="Chat settings" onClick={() => st.openDialog({ kind: 'settings', tab: 'chat' })}>
          <Settings size={14} />
        </button>
      </div>
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.map((m) => (
          <MessageView key={m.id} m={m} />
        ))}
        {!messages.length && <div className="muted">Messages from all your platforms appear here.</div>}
      </div>
      <div className="chat-input">
        {connected.length > 1 && (
          <Select<'twitch' | 'youtube' | 'facebook'> value={target} onChange={setTarget} options={connected.map((c) => ({ value: c.platform, label: c.platform }))} style={{ width: 100 }} />
        )}
        <input className="input" placeholder={connected.length ? `Message ${target} chat` : 'Chat not connected'} value={text} disabled={!connected.length} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
        <button className="btn primary" disabled={!connected.length || !text.trim()} onClick={() => void send()} title="Send">
          <Send size={14} />
        </button>
      </div>
    </>
  );
}

function testEvent(type: AlertType) {
  const names = ['StreamFan42', 'PixelPirate', 'NightOwl', 'CoffeeCat', 'GG_Gamer'];
  const name = names[Math.floor(Math.random() * names.length)];
  const amount = [1, 5, 10, 20, 50][Math.floor(Math.random() * 5)];
  const base = { id: uid('test'), type, platform: 'test' as const, name, time: Date.now() };
  switch (type) {
    case 'donation':
    case 'superchat':
    case 'stars':
      return { ...base, amount, currency: 'USD', formattedAmount: type === 'stars' ? `${amount * 100} Stars` : formatMoney(amount), message: 'Love the stream! Keep it up 🎉' };
    case 'bits':
      return { ...base, amount: amount * 100, formattedAmount: `${amount * 100} bits`, message: 'Cheer100 nice play!' };
    case 'raid':
      return { ...base, count: amount * 7 };
    case 'gift_sub':
      return { ...base, count: Math.min(amount, 10) };
    case 'subscription':
      return { ...base, months: amount, message: 'Happy to be here!' };
    default:
      return base;
  }
}

function EventsTab() {
  const eng = engineOrNull()!;
  const history = useEmitter(eng.alerts, () => eng.alerts.history);
  const current = useEmitter(eng.alerts, () => eng.alerts.current);
  const st = useStore.getState();
  return (
    <>
      <div className="chat-status">
        <button
          className="btn small primary"
          onClick={(e) =>
            openMenu(
              e,
              ALERT_TYPES.map((t) => ({ label: `Test ${ALERT_TYPE_LABELS[t]}`, onClick: () => eng.alerts.push(testEvent(t)) })),
            )
          }
        >
          Test alert ▾
        </button>
        <button className="btn small" disabled={!current} onClick={() => eng.alerts.skip()} title="Skip the alert that is playing">
          <SkipForward size={13} /> Skip
        </button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Alert settings" onClick={() => st.openDialog({ kind: 'settings', tab: 'alerts' })}>
          <Settings size={14} />
        </button>
        <button className="icon-btn danger" title="Clear history" onClick={() => eng.alerts.clearHistory()}>
          <Trash2 size={14} />
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {history.map((e) => (
          <div key={e.id} className="event-row">
            <div className="event-icon">
              <Bell size={15} />
            </div>
            <div className="ev-main">
              <div className="ev-name">
                {e.name} <span className="muted" style={{ fontWeight: 400 }}>{eventLine(e)}</span>
              </div>
              <div className="ev-sub" title={e.message}>
                {e.platform} · {new Date(e.time).toLocaleTimeString()} {e.message ? `· ${e.message}` : ''}
              </div>
            </div>
            <button className="icon-btn" title="Replay alert" onClick={() => eng.alerts.push(e, { replay: true })}>
              <RotateCcw size={14} />
            </button>
          </div>
        ))}
        {!history.length && (
          <div className="muted" style={{ padding: 14 }}>
            Follows, subs, donations, bits, raids and Super Chats appear here. Use “Test alert” to preview your Alert Box.
          </div>
        )}
      </div>
    </>
  );
}

export function Sidebar() {
  const show = useStore((s) => s.showChat);
  const [tab, setTab] = useState<'chat' | 'events'>('chat');
  if (!engineOrNull()) return null;
  return (
    <aside className={`sidebar ${show ? '' : 'collapsed'}`}>
      <div className="tabs">
        <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          <MessageSquare size={14} /> Chat
        </div>
        <div className={`tab ${tab === 'events' ? 'active' : ''}`} onClick={() => setTab('events')}>
          <Bell size={14} /> Recent Events
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{tab === 'chat' ? <ChatTab /> : <EventsTab />}</div>
    </aside>
  );
}
