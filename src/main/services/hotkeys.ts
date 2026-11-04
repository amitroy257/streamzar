import { globalShortcut } from 'electron';
import { log } from '../logger';

/** System-wide hotkeys (work while a game or another app has focus). */
export class Hotkeys {
  private registered = new Map<string, string>();

  constructor(private readonly onTrigger: (action: string) => void) {}

  /** Replace all hotkeys. Returns, per action, whether registration succeeded. */
  register(map: Record<string, string>): Record<string, boolean> {
    this.clear();
    const result: Record<string, boolean> = {};
    const used = new Set<string>();
    for (const [action, accel] of Object.entries(map)) {
      const a = (accel ?? '').trim();
      if (!a) continue;
      if (used.has(a.toLowerCase())) {
        result[action] = false;
        continue;
      }
      let ok = false;
      try {
        ok = globalShortcut.register(a, () => this.onTrigger(action));
      } catch (e) {
        log('warn', `invalid hotkey "${a}" for ${action}: ${(e as Error).message}`);
      }
      if (ok) {
        this.registered.set(action, a);
        used.add(a.toLowerCase());
      } else {
        log('warn', `could not register hotkey "${a}" for ${action} (in use by another app?)`);
      }
      result[action] = ok;
    }
    return result;
  }

  clear(): void {
    for (const accel of this.registered.values()) {
      try {
        globalShortcut.unregister(accel);
      } catch {
        /* ignore */
      }
    }
    this.registered.clear();
  }
}
