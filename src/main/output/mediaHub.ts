import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RAW_HEADER_SIZE, RAW_MAGIC, RAW_MAX_PAYLOAD, RAW_TYPE_AUDIO, RAW_TYPE_VIDEO } from '../../shared/rawProtocol';

export interface HubFormat {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
}

export interface RawListener {
  onVideo(tsUs: number, frame: Buffer): void;
  onAudio(tsUs: number, samples: Buffer): void;
}

/**
 * Local TCP endpoint that receives the program output (raw I420 frames + float PCM audio) from the
 * renderer and hands every packet to the registered listeners (encoder pipelines).
 */
export class MediaHub extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private sinks = new Set<RawListener>();
  readonly token = crypto.randomBytes(16).toString('hex');
  port = 0;
  framesReceived = 0;
  lastVideoAt = 0;

  constructor(readonly format: HubFormat) {
    super();
  }

  get expectedFrameSize(): number {
    const { width: w, height: h } = this.format;
    return w * h + 2 * ((w >> 1) * (h >> 1));
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = net.createServer((sock) => this.onConnection(sock));
    server.maxConnections = 2;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this.port;
  }

  attach(l: RawListener): void {
    this.sinks.add(l);
  }

  detach(l: RawListener): void {
    this.sinks.delete(l);
  }

  get connected(): boolean {
    return !!this.socket;
  }

  stop(): void {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.sinks.clear();
  }

  private onConnection(sock: net.Socket) {
    sock.setNoDelay(true);
    let authed = false;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let header: { type: number; length: number; ts: number } | null = null;

    const take = (n: number): Buffer => {
      // Pull exactly n bytes out of the pending queue.
      if (pending[0].length === n) {
        pendingLen -= n;
        return pending.shift()!;
      }
      if (pending[0].length > n) {
        const head = pending[0].subarray(0, n);
        pending[0] = pending[0].subarray(n);
        pendingLen -= n;
        return head;
      }
      const out = Buffer.allocUnsafe(n);
      let o = 0;
      while (o < n) {
        const c = pending[0];
        const k = Math.min(c.length, n - o);
        c.copy(out, o, 0, k);
        o += k;
        if (k === c.length) pending.shift();
        else pending[0] = c.subarray(k);
      }
      pendingLen -= n;
      return out;
    };

    const fail = (reason: string) => {
      this.emit('log', 'warn', `capture link rejected: ${reason}`);
      sock.destroy();
    };

    sock.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      pendingLen += chunk.length;
      if (!authed) {
        const all = Buffer.concat(pending);
        const nl = all.indexOf(0x0a);
        if (nl < 0) {
          if (all.length > 256) fail('no handshake');
          pending = [all];
          return;
        }
        const tok = all.subarray(0, nl).toString('utf8');
        const a = Buffer.from(tok);
        const b = Buffer.from(this.token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('bad token');
        if (this.socket) this.socket.destroy();
        this.socket = sock;
        authed = true;
        pending = [all.subarray(nl + 1)];
        pendingLen = pending[0].length;
        this.emit('connected');
      }
      for (;;) {
        if (!header) {
          if (pendingLen < RAW_HEADER_SIZE) break;
          const h = take(RAW_HEADER_SIZE);
          if (h.readUInt32LE(0) !== RAW_MAGIC) return fail('bad magic');
          const type = h.readUInt8(4);
          const length = h.readUInt32LE(8);
          const ts = h.readDoubleLE(12);
          if (length > RAW_MAX_PAYLOAD || (type !== RAW_TYPE_VIDEO && type !== RAW_TYPE_AUDIO) || !Number.isFinite(ts)) return fail('bad header');
          header = { type, length, ts };
        }
        if (pendingLen < header.length) break;
        const payload = take(header.length);
        const { type, ts } = header;
        header = null;
        if (type === RAW_TYPE_VIDEO) {
          if (payload.length !== this.expectedFrameSize) continue; // stale frame from a previous format
          this.framesReceived++;
          this.lastVideoAt = Date.now();
          for (const l of this.sinks) l.onVideo(ts, payload);
        } else {
          for (const l of this.sinks) l.onAudio(ts, payload);
        }
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = null;
        this.emit('disconnected');
      }
    });
  }
}
