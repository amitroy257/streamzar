import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { OutputManager } from '../../src/main/output/outputManager';
import { defaultSettings } from '../../src/shared/defaults';
import type { AppSettings, OutputStatus } from '../../src/shared/types';
import { FFMPEG, SyntheticSender, freePort, probe, sleep, startRtmpListener, waitFor } from './helpers';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streamzar-it-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeSettings(rtmpPort: number): AppSettings {
  const s = defaultSettings();
  s.video = { ...s.video, baseWidth: 320, baseHeight: 240, outputWidth: 320, outputHeight: 240, fpsNum: 30, fpsDen: 1 };
  s.output.stream = { ...s.output.stream, videoBitrate: 800, keyframeSec: 1, preset: 'speed' };
  s.output.recording = { ...s.output.recording, path: tmp, format: 'mp4', quality: 'stream' };
  s.output.replayBuffer = { durationSec: 5, format: 'mp4' };
  s.advanced.verboseLogging = !!process.env.SZ_VERBOSE;
  s.stream = {
    ...s.stream,
    reconnectDelaySec: 1,
    destinations: [
      { id: 'd1', platform: 'custom', name: 'Local RTMP', enabled: true, server: `rtmp://127.0.0.1:${rtmpPort}/live`, streamKey: 'secretkey' },
    ],
  };
  return s;
}

function harness(settings: AppSettings) {
  const statuses: OutputStatus[] = [];
  const notices: string[] = [];
  let sender: SyntheticSender | null = null;
  const manager = new OutputManager({
    getSettings: () => settings,
    resolveFfmpeg: async () => FFMPEG,
    defaultRecordingDir: () => tmp,
    log: (l, m) => {
      if (process.env.SZ_DEBUG) console.log(l, m);
    },
    onStatus: (s) => statuses.push(s),
    onNotice: (level, m) => notices.push(`${level}: ${m}`),
    onCaptureRequest: (req) => {
      if (req.active) {
        sender?.stop();
        sender = new SyntheticSender(req.width, req.height, req.fpsNum / req.fpsDen, req.sampleRate);
        void sender.connect(req.port, req.token);
      } else {
        sender?.stop();
        sender = null;
      }
    },
  });
  return { manager, statuses, notices, last: () => manager.status() };
}

describe('output engine (real FFmpeg)', () => {
  it('streams to an RTMP server, records, saves a replay and survives a reconnect', async () => {
    const port = await freePort();
    const settings = makeSettings(port);
    const { manager, notices, last } = harness(settings);
    const flv1 = path.join(tmp, 'received1.flv');
    const flv2 = path.join(tmp, 'received2.flv');
    let server: ChildProcess = startRtmpListener(port, 'live', 'secretkey', flv1);
    await sleep(500);

    await manager.startStream();
    await manager.startRecording();
    await manager.startReplayBuffer();
    expect(last().streaming).toBe(true);
    expect(last().recording).toBe(true);
    // stream + recording ("same as stream") + replay share a single encoder
    expect(last().encoders.length).toBe(1);

    await waitFor(() => last().destinations[0]?.state === 'live', 20000, 'destination live');
    await sleep(4000);

    // Kill the server: the pusher must notice and reconnect once a new server is up.
    server.kill('SIGINT');
    await waitFor(() => last().destinations[0]?.state === 'reconnecting', 20000, 'reconnecting');
    server = startRtmpListener(port, 'live', 'secretkey', flv2);
    await waitFor(() => last().destinations[0]?.state === 'live', 30000, 'reconnected');
    await sleep(3000);

    const replay = await manager.saveReplay();
    await manager.stopReplayBuffer();
    await manager.stopRecording();
    await manager.stopStream();
    expect(last().streaming).toBe(false);
    expect(last().encoders.length).toBe(0);
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', () => resolve());
      setTimeout(() => {
        server.kill('SIGINT');
      }, 5000);
    });

    // RTMP server received valid H.264 + AAC both before and after the reconnect
    for (const f of [flv1, flv2]) {
      expect(existsSync(f)).toBe(true);
      const p = probe(f);
      const v = p.streams.find((s) => s.codec_type === 'video');
      const a = p.streams.find((s) => s.codec_type === 'audio');
      expect(v?.codec_name).toBe('h264');
      expect(v?.width).toBe(320);
      expect(v?.height).toBe(240);
      expect(a?.codec_name).toBe('aac');
      expect(Number(p.format.duration)).toBeGreaterThan(2);
    }

    // Recording
    const files = readdirSync(tmp).filter((f) => f.startsWith('Streamzar') && f.endsWith('.mp4'));
    expect(files.length).toBe(1);
    const rec = probe(path.join(tmp, files[0]));
    expect(rec.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(Number(rec.format.duration)).toBeGreaterThan(8);

    // Replay clip: about the configured 5 seconds (whole GOPs, so a bit more is fine)
    expect(statSync(replay).size).toBeGreaterThan(10000);
    const rp = probe(replay);
    expect(rp.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(Number(rp.format.duration)).toBeGreaterThan(4);
    expect(Number(rp.format.duration)).toBeLessThan(9);

    expect(notices.filter((n) => n.startsWith('error'))).toEqual([]);
    await manager.shutdown();
  });

  it('applies a stream delay and drains it when stopping', async () => {
    const port = await freePort();
    const settings = makeSettings(port);
    settings.stream.delaySec = 3;
    const { manager, last } = harness(settings);
    const flv = path.join(tmp, 'delayed.flv');
    const server = startRtmpListener(port, 'live', 'secretkey', flv);
    await sleep(500);
    const t0 = Date.now();
    await manager.startStream();
    await waitFor(() => last().destinations[0]?.state === 'live', 20000, 'destination live');
    // Nothing can reach the server before the delay elapsed.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3000);
    await sleep(3000);
    const stopAt = Date.now();
    await manager.stopStream();
    // Draining sends the buffered 3 seconds before closing.
    expect(Date.now() - stopAt).toBeGreaterThanOrEqual(2000);
    await new Promise<void>((resolve) => (server.exitCode !== null ? resolve() : server.once('exit', () => resolve())));
    const p = probe(flv);
    expect(Number(p.format.duration)).toBeGreaterThan(4);
    await manager.shutdown();
  });

  it('reports a clear error for an unreachable server', async () => {
    const port = await freePort();
    const settings = makeSettings(port);
    settings.stream.autoReconnect = false;
    const { manager, notices, last } = harness(settings);
    await manager.startStream();
    await waitFor(() => !last().streaming, 30000, 'stream to stop after failure');
    expect(notices.some((n) => n.startsWith('error') && /Connection refused|lost|failed/i.test(n))).toBe(true);
    await manager.shutdown();
  });

  it('rejects starting without destinations', async () => {
    const settings = makeSettings(1);
    settings.stream.destinations = [];
    const { manager } = harness(settings);
    await expect(manager.startStream()).rejects.toThrow(/No streaming destination/);
  });
});
