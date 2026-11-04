import { protocol, net, type Session } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const APP_SCHEME = 'app';
export const APP_HOST = 'streamzar';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.cube': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Must run before app 'ready'. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', ...extra };
}

/** Parse a single "bytes=a-b" range. Returns null for unsatisfiable / unsupported ranges. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

async function serveFile(file: string, req: Request, extraHeaders: Record<string, string> = {}): Promise<Response> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return new Response('Not found', { status: 404, headers: corsHeaders() });
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404, headers: corsHeaders() });
  const type = mimeFor(file);
  const rangeHeader = req.headers.get('range');
  const range = parseRange(rangeHeader, stat.size);
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: corsHeaders({ 'Content-Range': `bytes */${stat.size}` }) });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  const body = stat.size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream);
  const headers = corsHeaders({
    'Content-Type': type,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  return new Response(req.method === 'HEAD' ? null : body, { status: range ? 206 : 200, headers });
}

export function mediaUrl(filePath: string): string {
  return `${APP_ORIGIN}/__media/${encodeURIComponent(filePath)}`;
}

/**
 * app://streamzar/...           → renderer bundle (dist/renderer)
 * app://streamzar/__media/<p>   → local media file chosen by the user (range requests supported)
 * app://streamzar/__remote?url= → remote image proxied so WebGL textures are not tainted
 */
export function handleAppProtocol(session: Session, rendererDir: string): void {
  session.protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const pathname = url.pathname;

    if (pathname.startsWith('/__media/')) {
      const file = decodeURIComponent(pathname.slice('/__media/'.length));
      if (!path.isAbsolute(file)) return new Response('Bad path', { status: 400 });
      return serveFile(path.normalize(file), req);
    }

    if (pathname === '/__remote') {
      const target = url.searchParams.get('url') ?? '';
      if (!/^https?:\/\//i.test(target)) return new Response('Bad url', { status: 400 });
      try {
        const res = await net.fetch(target, { headers: { Accept: 'image/*' } });
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok || !ct.startsWith('image/')) return new Response('Not an image', { status: 415, headers: corsHeaders() });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 10 * 1024 * 1024) return new Response('Too large', { status: 413, headers: corsHeaders() });
        return new Response(buf, { status: 200, headers: corsHeaders({ 'Content-Type': ct, 'Cache-Control': 'max-age=86400' }) });
      } catch {
        return new Response('Fetch failed', { status: 502, headers: corsHeaders() });
      }
    }

    // Static renderer files
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(rendererDir, rel));
    if (!file.startsWith(path.normalize(rendererDir + path.sep))) return new Response('Forbidden', { status: 403 });
    const extra: Record<string, string> = file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {};
    return serveFile(file, req, extra);
  });
}
