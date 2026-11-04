import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, FolderOpen } from 'lucide-react';
import { api } from '../api';

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'normal' | 'wide' | 'xwide';
  bodyStyle?: React.CSSProperties;
  headerExtra?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.size === 'wide' ? 'wide' : props.size === 'xwide' ? 'xwide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">{props.title}</div>
          {props.headerExtra}
          <button className="icon-btn" onClick={props.onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body" style={props.bodyStyle}>
          {props.children}
        </div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field(props: { label?: ReactNode; help?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="field" style={props.style}>
      {props.label !== undefined && <label>{props.label}</label>}
      {props.children}
      {props.help && <div className="help">{props.help}</div>}
    </div>
  );
}

export function TextInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; autoFocus?: boolean; onEnter?: () => void; className?: string; spellCheck?: boolean }) {
  return (
    <input
      className={`input ${props.className ?? ''}`}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      spellCheck={props.spellCheck ?? false}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onEnter?.();
      }}
    />
  );
}

/** Secret input with show/hide toggle (stream keys, tokens). */
export function SecretInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="inline">
      <input className="input mono" type={show ? 'text' : 'password'} value={props.value} placeholder={props.placeholder} spellCheck={false} autoComplete="off" onChange={(e) => props.onChange(e.target.value.trim())} />
      <button className="btn small" type="button" onClick={() => setShow(!show)}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** Number input that only commits valid numbers (on blur / Enter / arrows). */
export function NumberInput(props: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; style?: React.CSSProperties }) {
  const [text, setText] = useState(String(props.value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(Number.isFinite(props.value) ? Math.round(props.value * 1000) / 1000 : 0));
  }, [props.value]);
  const commit = (raw: string) => {
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) {
      setText(String(props.value));
      return;
    }
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    setText(String(v));
    if (v !== props.value) props.onChange(v);
  };
  return (
    <input
      className={`input ${props.className ?? ''}`}
      style={props.style}
      type="number"
      value={text}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onFocus={() => (focused.current = true)}
      onBlur={(e) => {
        focused.current = false;
        commit(e.target.value);
      }}
      onChange={(e) => {
        setText(e.target.value);
        // Commit valid in-range values immediately; anything else is fixed up on blur.
        const v = parseFloat(e.target.value);
        const inRange = Number.isFinite(v) && (props.min === undefined || v >= props.min) && (props.max === undefined || v <= props.max);
        if (inRange && v !== props.value) props.onChange(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
      }}
    />
  );
}

export function Slider(props: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string; onCommit?: () => void }) {
  return (
    <div className="slider-row">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        onPointerUp={() => props.onCommit?.()}
      />
      <span className="val">{props.format ? props.format(props.value) : props.value}</span>
    </div>
  );
}

export function Select<T extends string | number>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; className?: string; style?: React.CSSProperties }) {
  return (
    <select
      className={`input ${props.className ?? ''}`}
      style={props.style}
      value={String(props.value)}
      onChange={(e) => {
        const opt = props.options.find((o) => String(o.value) === e.target.value);
        if (opt) props.onChange(opt.value);
      }}
    >
      {props.options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="check" style={props.disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="switch" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function ColorInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline">
      <input className="input" type="color" value={/^#[0-9a-f]{6}$/i.test(props.value) ? props.value : '#000000'} onChange={(e) => props.onChange(e.target.value)} />
      <input className="input mono" style={{ width: 110 }} value={props.value} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

export const IMAGE_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'apng'] }];
export const VIDEO_FILTER = [{ name: 'Media files', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'] }];
export const AUDIO_FILTER = [{ name: 'Audio files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }];
export const ALERT_MEDIA_FILTER = [{ name: 'Images & videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'webm', 'mp4', 'mov'] }];

export function FileInput(props: { value: string; onChange: (v: string) => void; filters?: { name: string; extensions: string[] }[]; directory?: boolean; placeholder?: string; title?: string }) {
  const pick = async () => {
    const p = props.directory ? await api.files.openDirectory(props.title) : await api.files.openFile({ title: props.title, filters: props.filters });
    if (p) props.onChange(p);
  };
  return (
    <div className="inline">
      <input className="input mono" value={props.value} placeholder={props.placeholder ?? 'No file selected'} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
      <button className="btn" type="button" onClick={() => void pick()}>
        <FolderOpen size={14} /> Browse
      </button>
      {props.value && (
        <button className="icon-btn" type="button" title="Clear" onClick={() => props.onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

export type MenuEntry =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; kbd?: string; checked?: boolean }
  | { separator: true }
  | { heading: string };

let menuState: { x: number; y: number; items: MenuEntry[] } | null = null;
const menuListeners = new Set<() => void>();

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) {
  e.preventDefault?.();
  menuState = { x: e.clientX, y: e.clientY, items };
  menuListeners.forEach((l) => l());
}

function closeMenu() {
  menuState = null;
  menuListeners.forEach((l) => l());
}

export function ContextMenuHost() {
  const state = useSyncExternalStore(
    (cb) => {
      menuListeners.add(cb);
      return () => menuListeners.delete(cb);
    },
    () => menuState,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!state) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 300;
    setPos({ x: Math.min(state.x, window.innerWidth - w - 6), y: Math.min(state.y, window.innerHeight - h - 6) });
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [state]);
  if (!state) return null;
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {state.items.map((it, i) => {
        if ('separator' in it) return <div key={i} className="menu-sep" />;
        if ('heading' in it) return <div key={i} className="menu-label">{it.heading}</div>;
        return (
          <div
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
            onClick={() => {
              closeMenu();
              it.onClick();
            }}
          >
            <span style={{ width: 14, display: 'inline-block' }}>{it.checked ? '✓' : ''}</span>
            {it.label}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Subscribe to one of the engine's emitter objects (AlertManager, ChatFeed...). */
export function useEmitter<T>(emitter: { subscribe(cb: () => void): () => void }, read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    return emitter.subscribe(() => setValue(read()));
  }, [emitter]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

/** Re-render on an interval (timers, meters). */
export function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}
