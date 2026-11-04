export function uid(prefix = ''): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return prefix ? `${prefix}_${s}` : s;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export const MIN_DB = -100;

export function dbToGain(db: number): number {
  if (db <= MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(gain));
}

/**
 * Fader position (0..1) <-> dB, using the same kind of curve as broadcast mixers:
 * the top 3/4 of the fader covers -30..0 dB roughly linearly in dB, the rest falls off to -inf.
 */
export function faderToDb(pos: number): number {
  const p = clamp(pos, 0, 1);
  if (p <= 0) return MIN_DB;
  if (p >= 0.25) return -30 + ((p - 0.25) / 0.75) * 30;
  // 0 .. 0.25 -> -96 .. -30 (log-ish)
  return -96 + (p / 0.25) * 66;
}

export function dbToFader(db: number): number {
  if (db <= MIN_DB) return 0;
  if (db >= 0) return 1;
  if (db >= -30) return 0.25 + ((db + 30) / 30) * 0.75;
  if (db <= -96) return 0;
  return ((db + 96) / 66) * 0.25;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${mm}:${ss}`;
}

/** Replace {placeholders} in a template with values (unknown placeholders are left as-is). */
export function renderTemplate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = values[key];
    return v === undefined || v === null ? match : String(v);
  });
}

/**
 * Build a recording file name from a strftime-like format:
 * %Y year, %m month, %d day, %H hour, %M minute, %S second.
 */
export function formatFilename(format: string, date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const out = format
    .replace(/%Y/g, String(date.getFullYear()))
    .replace(/%m/g, p2(date.getMonth() + 1))
    .replace(/%d/g, p2(date.getDate()))
    .replace(/%H/g, p2(date.getHours()))
    .replace(/%M/g, p2(date.getMinutes()))
    .replace(/%S/g, p2(date.getSeconds()));
  // Strip characters that are invalid in file names on Windows/macOS/Linux.
  // eslint-disable-next-line no-control-regex
  const cleaned = out.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
  return cleaned || 'recording';
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Recursively fill missing keys of `value` from `defaults` (arrays and primitives in `value` win). */
export function mergeDefaults<T>(defaults: T, value: unknown): T {
  if (value === undefined || value === null) return deepClone(defaults);
  if (Array.isArray(defaults)) return (Array.isArray(value) ? value : deepClone(defaults)) as T;
  if (typeof defaults === 'object' && defaults !== null) {
    if (typeof value !== 'object' || Array.isArray(value)) return deepClone(defaults);
    const out: Record<string, unknown> = {};
    const d = defaults as Record<string, unknown>;
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(d)) out[k] = mergeDefaults(d[k], v[k]);
    // keep extra keys (e.g. user-defined hotkeys / dynamic maps)
    for (const k of Object.keys(v)) if (!(k in out)) out[k] = v[k];
    return out as T;
  }
  return (typeof value === typeof defaults ? value : defaults) as T;
}

export function fpsValue(num: number, den: number): number {
  return den > 0 ? num / den : num;
}

export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) {
    const a = parseInt(h.slice(6, 8), 16) / 255;
    h = h.slice(0, 6);
    alpha *= a;
  }
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n) || h.length !== 6) return [0, 0, 0, alpha];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export function cssColor(hex: string, opacity: number): string {
  const [r, g, b, a] = hexToRgba(hex, opacity);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

export function formatMoney(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Output frames are packed as I420 inside an RGBA texture, which needs dimensions divisible by 4. */
export function normalizeOutputSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(64, Math.min(7680, Math.round(width / 4) * 4));
  const h = Math.max(64, Math.min(4320, Math.round(height / 4) * 4));
  return { width: w, height: h };
}
