import { appendFile, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

let logDir = '';
let logFile = '';
let queue: string[] = [];
let writing = false;

function stamp(d = new Date()): string {
  return d.toISOString();
}

export function initLogger(dir: string): void {
  logDir = dir;
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  logFile = path.join(dir, `streamzar-${day}.log`);
  // keep the 14 most recent log files
  try {
    const files = readdirSync(dir)
      .filter((f) => /^streamzar-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) rmSync(path.join(dir, f), { force: true });
  } catch {
    /* ignore */
  }
}

export function getLogDir(): string {
  return logDir;
}

function flush() {
  if (writing || !queue.length || !logFile) return;
  writing = true;
  const chunk = queue.join('');
  queue = [];
  appendFile(logFile, chunk, () => {
    writing = false;
    flush();
  });
}

export function log(level: LogLevel, message: string): void {
  const line = `${stamp()} [${level.toUpperCase()}] ${message}\n`;
  if (process.env.STREAMZAR_DEBUG || process.defaultApp) {
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line.trimEnd());
  }
  queue.push(line);
  flush();
}
