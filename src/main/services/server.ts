import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import type { AlertEvent, RemoteCommand, RemoteState, ServerInfo, ServerSettings } from '../../shared/types';
import { parseKofi, parseWebhookAlert } from '../../shared/chatParsers';
import { log } from '../logger';

const MAX_BODY = 64 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const VALID_COMMANDS = new Set(['switchScene', 'previewScene', 'transition', 'toggleMute', 'setVolume', 'toggleStudioMode', 'hotkey']);
const REMOTE_HOTKEYS = new Set(['toggleStream', 'toggleRecording', 'toggleReplayBuffer', 'saveReplay', 'screenshot']);

export function validateRemoteCommand(input: unknown): RemoteCommand | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  if (typeof c.type !== 'string' || !VALID_COMMANDS.has(c.type)) return null;
  switch (c.type) {
    case 'switchScene':
    case 'previewScene':
      return typeof c.sceneId === 'string' ? { type: c.type, sceneId: c.sceneId } : null;
    case 'toggleMute':
      return typeof c.sourceId === 'string' ? { type: 'toggleMute', sourceId: c.sourceId } : null;
    case 'setVolume':
      return typeof c.sourceId === 'string' && typeof c.volumeDb === 'number' && Number.isFinite(c.volumeDb)
        ? { type: 'setVolume', sourceId: c.sourceId, volumeDb: Math.max(-100, Math.min(26, c.volumeDb)) }
        : null;
    case 'hotkey':
      return typeof c.action === 'string' && REMOTE_HOTKEYS.has(c.action) ? { type: 'hotkey', action: c.action } : null;
    case 'transition':
      return { type: 'transition' };
    case 'toggleStudioMode':
      return { type: 'toggleStudioMode' };
  }
  return null;
}

/**
 * Local HTTP API:
 *   GET  /?token=…            mobile remote control page
 *   WS   /ws?token=…          remote control channel
 *   POST /api/alert?token=…   trigger an alert ({type,name,amount,currency,message,months,count})
 *   POST /api/kofi?token=…    Ko-fi webhook (optional &verify=<Ko-fi verification token>)
 *   GET  /api/state?token=…   current scenes / audio / output state
 */
export class LocalServer extends EventEmitter {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private state: RemoteState | null = null;
  private info: ServerInfo = { running: false, port: 0, token: '', urls: [] };
  private cfg: ServerSettings | null = null;

  getInfo(): ServerInfo {
    return this.info;
  }

  async apply(cfg: ServerSettings): Promise<ServerInfo> {
    const same = this.cfg && this.server && cfg.enabled && this.cfg.port === cfg.port && this.cfg.allowLan === cfg.allowLan && this.cfg.token === cfg.token;
    this.cfg = { ...cfg };
    if (same) return this.info;
    await this.stop();
    if (!cfg.enabled) {
      this.info = { running: false, port: cfg.port, token: cfg.token, urls: [] };
      return this.info;
    }
    const host = cfg.allowLan ? '0.0.0.0' : '127.0.0.1';
    const server = http.createServer((req, res) => void this.handle(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws' || !this.authorized(url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Choose another port.` : (e as Error).message;
      log('error', `local server failed: ${msg}`);
      wss.close();
      this.info = { running: false, port: cfg.port, token: cfg.token, urls: [], error: msg };
      return this.info;
    }
    this.server = server;
    this.wss = wss;
    const urls = [`http://127.0.0.1:${cfg.port}/?token=${cfg.token}`];
    if (cfg.allowLan) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) {
          if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${cfg.port}/?token=${cfg.token}`);
        }
      }
    }
    this.info = { running: true, port: cfg.port, token: cfg.token, urls };
    log('info', `local server listening on ${host}:${cfg.port}`);
    return this.info;
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    this.wss = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  publishState(state: RemoteState): void {
    this.state = state;
    const msg = JSON.stringify({ type: 'state', state });
    for (const c of this.wss?.clients ?? []) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  private authorized(url: URL): boolean {
    const t = url.searchParams.get('token') ?? '';
    return !!this.cfg?.token && safeEqual(t, this.cfg.token);
  }

  private onSocket(ws: WebSocket) {
    if (this.state) ws.send(JSON.stringify({ type: 'state', state: this.state }));
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const cmd = validateRemoteCommand(parsed);
      if (cmd) this.emit('command', cmd);
    });
    ws.on('error', () => undefined);
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!this.authorized(url)) {
        this.json(res, 401, { error: 'Missing or invalid token' });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/remote')) {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:`,
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(remotePage(nonce));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        this.json(res, 200, this.state ?? {});
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/alert') {
        const body = await readBody(req);
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          this.json(res, 400, { error: 'Body must be JSON' });
          return;
        }
        const ev = parseWebhookAlert(data);
        if (!ev) {
          this.json(res, 400, { error: 'Invalid alert. "type" must be one of follow, subscription, gift_sub, donation, bits, raid, superchat, membership, stars.' });
          return;
        }
        this.emit('alert', ev satisfies AlertEvent);
        this.json(res, 200, { ok: true, id: ev.id });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/kofi') {
        const body = await readBody(req);
        const data = new URLSearchParams(body).get('data') ?? '';
        const ev = parseKofi(data, url.searchParams.get('verify') ?? '');
        if (!ev) {
          this.json(res, 400, { error: 'Invalid Ko-fi payload' });
          return;
        }
        this.emit('alert', ev);
        this.json(res, 200, { ok: true });
        return;
      }
      this.json(res, 404, { error: 'Not found' });
    } catch (e) {
      log('warn', `local server request failed: ${(e as Error).message}`);
      if (!res.headersSent) this.json(res, 500, { error: 'Internal error' });
    }
  }
}

function remotePage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Streamzar Remote</title>
<style>
:root{--bg:#0f1115;--panel:#181b22;--line:#2a2f3a;--text:#e8eaf0;--muted:#8b93a6;--accent:#31c3a2;--live:#ef4444;--rec:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;padding-bottom:32px}
h1{font-size:18px;margin:0 0 12px;display:flex;align-items:center;gap:8px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:20px 0 8px}
.dot{width:10px;height:10px;border-radius:50%;background:#555}.dot.on{background:var(--accent)}
.row{display:flex;gap:8px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
button{appearance:none;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:14px 12px;font:inherit;font-weight:600;cursor:pointer;min-height:52px}
button.active{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);color:var(--accent)}
button.preview{border-color:#3b82f6;color:#60a5fa}
button.live{background:var(--live);border-color:var(--live);color:#fff}button.rec{background:var(--rec);border-color:var(--rec);color:#111}
.big{flex:1 1 140px}.audio{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.audio .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.audio input{flex:2;min-width:0}.audio button{min-height:40px;padding:8px 12px}
.muted{color:var(--live)}.status{color:var(--muted);font-size:13px;margin-left:auto}
</style></head><body>
<h1><span class="dot" id="conn"></span>Streamzar Remote <span class="status" id="timer"></span></h1>
<div class="row">
<button class="big" id="stream">Go Live</button><button class="big" id="record">Record</button>
</div>
<div class="row" style="margin-top:8px"><button class="big" id="replay">Replay Buffer</button><button class="big" id="saveReplay">Save Replay</button><button class="big" id="shot">Screenshot</button></div>
<h2>Scenes</h2><div class="grid" id="scenes"></div>
<div class="row" id="studio" style="margin-top:8px"></div>
<h2>Audio</h2><div id="audio"></div>
<script nonce="${nonce}">
const token=new URLSearchParams(location.search).get('token')||'';let ws,state=null;
const $=id=>document.getElementById(id);
function send(c){if(ws&&ws.readyState===1)ws.send(JSON.stringify(c))}
function fmt(ms){const s=Math.max(0,Math.floor(ms/1000));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')}
function el(tag,props,text){const e=document.createElement(tag);Object.assign(e,props||{});if(text!==undefined)e.textContent=text;return e}
function render(){if(!state)return;const o=state.output;
$('stream').textContent=o.streaming?'End Stream':'Go Live';$('stream').className='big'+(o.streaming?' live':'');
$('record').textContent=o.recording?'Stop Recording':'Record';$('record').className='big'+(o.recording?' rec':'');
$('replay').textContent=o.replayBuffer?'Stop Replay Buffer':'Start Replay Buffer';$('saveReplay').disabled=!o.replayBuffer;
const sc=$('scenes');sc.replaceChildren();for(const s of state.scenes){const b=el('button',{},s.name);if(s.id===state.activeSceneId)b.classList.add('active');if(state.studioMode&&s.id===state.previewSceneId)b.classList.add('preview');b.onclick=()=>send({type:state.studioMode?'previewScene':'switchScene',sceneId:s.id});sc.appendChild(b)}
const st=$('studio');st.replaceChildren();const t=el('button',{className:'big'},state.studioMode?'Exit Studio Mode':'Studio Mode');t.onclick=()=>send({type:'toggleStudioMode'});st.appendChild(t);if(state.studioMode){const tr=el('button',{className:'big active'},'Transition');tr.onclick=()=>send({type:'transition'});st.appendChild(tr)}
const au=$('audio');au.replaceChildren();for(const a of state.audio){const row=el('div',{className:'audio'});const n=el('span',{className:'name'+(a.muted?' muted':'')},a.name);const r=el('input',{type:'range',min:-60,max:0,step:1,value:Math.max(-60,a.volumeDb)});r.onchange=()=>send({type:'setVolume',sourceId:a.id,volumeDb:Number(r.value)<=-60?-100:Number(r.value)});const m=el('button',{},a.muted?'Unmute':'Mute');m.onclick=()=>send({type:'toggleMute',sourceId:a.id});row.append(n,r,m);au.appendChild(row)}}
setInterval(()=>{if(!state)return;const o=state.output;const parts=[];if(o.streaming&&o.streamStartedAt)parts.push('LIVE '+fmt(Date.now()-o.streamStartedAt));if(o.recording&&o.recordingStartedAt)parts.push('REC '+fmt(Date.now()-o.recordingStartedAt));$('timer').textContent=parts.join(' · ')},500);
$('stream').onclick=()=>{if(state&&state.output.streaming&&!confirm('End the stream?'))return;send({type:'hotkey',action:'toggleStream'})};
$('record').onclick=()=>send({type:'hotkey',action:'toggleRecording'});$('replay').onclick=()=>send({type:'hotkey',action:'toggleReplayBuffer'});
$('saveReplay').onclick=()=>send({type:'hotkey',action:'saveReplay'});$('shot').onclick=()=>send({type:'hotkey',action:'screenshot'});
function connect(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?token='+encodeURIComponent(token));
ws.onopen=()=>$('conn').classList.add('on');ws.onclose=()=>{$('conn').classList.remove('on');setTimeout(connect,2000)};
ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='state'){state=m.state;render()}}catch{}}}
connect();
</script></body></html>`;
}
