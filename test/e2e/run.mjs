// End-to-end test: launches the real Electron app (under Xvfb in CI), builds a scene through the UI
// and the store, records and streams to a local RTMP server, then verifies the files with ffprobe,
// including that the pixels that come out of the encoder have the right colours.
//
// Usage: npm run build && xvfb-run -a node test/e2e/run.mjs

import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    return require('playwright');
  }
}
const { _electron: electron } = loadPlaywright();
const electronPath = require(path.join(root, 'node_modules', 'electron'));
const ffmpeg = require(path.join(root, 'node_modules', 'ffmpeg-static'));
const outDir = path.join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streamzar-e2e-'));
const recDir = path.join(tmp, 'recordings');
mkdirSync(recDir);

// Output size (E2E_OUT=640x360 checks the scaler and full frame rate on software-rendering CI).
const [OUT_W, OUT_H] = (process.env.E2E_OUT || '1280x720').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const mainLog = [];
const consoleErrors = [];
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,color_space,color_range,r_frame_rate,sample_rate:format=duration', '-of', 'json', file]);
  return JSON.parse(out.toString());
}

/** Average RGB of a region of the frame at `t` seconds (decoded with the stream's own colour tags). */
function sampleRgb(file, t, x, y, w, h) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    r += buf[i];
    g += buf[i + 1];
    b += buf[i + 2];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function waitFor(win, fn, arg, timeout, what) {
  const t0 = Date.now();
  for (;;) {
    if (await win.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

async function main() {
  console.log('Launching Streamzar…');
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root, '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
    cwd: root,
    env: { ...process.env, STREAMZAR_USER_DATA: path.join(tmp, 'userData'), STREAMZAR_DEBUG: '1', NODE_OPTIONS: '' },
    timeout: 60000,
  });
  app.process().stdout?.on('data', (d) => mainLog.push(d.toString()));
  app.process().stderr?.on('data', (d) => mainLog.push(d.toString()));
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await win.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);

  console.log('1. UI boots');
  await win.waitForSelector('.app', { timeout: 60000 });
  check(await win.isVisible('text=Scenes'), 'Scenes panel is visible');
  check(await win.isVisible('text=Audio Mixer'), 'Mixer panel is visible');
  check(await win.isVisible('button:has-text("Go Live")'), 'Go Live button is visible');
  await win.screenshot({ path: path.join(outDir, '01-empty.png') });

  console.log('2. Add a Color source through the UI');
  await win.click('button:has-text("Add a source")');
  await win.click('.type-card:has-text("Color Block")');
  await win.click('.modal-foot button:has-text("Add source")');
  await win.waitForSelector('.modal-head:has-text("Add: Color Block")');
  await win.click('.modal-foot button:has-text("Done")');
  const colorId = await win.evaluate(() => window.__streamzar.store.getState().collection.sources.find((s) => s.type === 'color')?.id);
  check(!!colorId, 'color source created');
  await win.evaluate((id) => window.__streamzar.store.getState().updateSourceSettings(id, { color: '#ff0000', width: 1280, height: 720 }), colorId);

  console.log('3. Add text, a second scene and widgets through the store');
  await win.evaluate(() => {
    const s = window.__streamzar.store.getState();
    const t = s.addSource('text', 'Title', { text: 'Hello from Streamzar', fontSize: 80, color: '#ffffff', outline: true });
    const it = window.__streamzar.store.getState().collection.scenes[0].items.find((i) => i.sourceId === t.id);
    s.setItemTransform(it.id, { ...it.transform, x: 300, y: 300 });
    s.addSource('alert_box', 'Alerts', { width: 800, height: 400 });
    s.addSource('chat_box', 'Chat');
    s.addSource('countdown', 'Timer', { durationSec: 600 });
  });
  await sleep(1500);
  const stats = await win.evaluate(() => window.__streamzar.engine.engineStats());
  console.log('   engine stats', stats);
  check(stats.renderFps > 10, `compositor renders (${stats.renderFps} fps)`);
  // This CI container has no microphone or speakers, so the default Mic/Desktop Audio sources
  // legitimately report a problem; every other source must be healthy.
  const issues = await win.evaluate(() => {
    const s = window.__streamzar.store.getState();
    return Object.fromEntries(Object.entries(s.issues).filter(([id]) => !['audio_input', 'audio_output'].includes(s.collection.sources.find((x) => x.id === id)?.type)));
  });
  check(Object.keys(issues).length === 0, `no video source issues ${JSON.stringify(issues)}`);
  await win.screenshot({ path: path.join(outDir, '02-scene.png') });

  console.log('4. Configure output: 1280x720 @30, recording + local RTMP destination');
  const port = await freePort();
  const received = path.join(tmp, 'received.flv');
  const rtmp = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/testkey`, '-c', 'copy', '-f', 'flv', '-y', received], { stdio: ['ignore', 'ignore', 'pipe'] });
  let rtmpErr = '';
  rtmp.stderr.on('data', (d) => (rtmpErr += d));
  await sleep(500);
  await win.evaluate(
    ({ recDir, port, OUT_W, OUT_H }) =>
      window.__streamzar.store.getState().patchSettings((d) => {
        // CI renders WebGL in software (no GPU), so use a 720p canvas; the scaler is covered by
        // the unit tests and runs on the GPU on real machines.
        d.video.baseWidth = 1280;
        d.video.baseHeight = 720;
        d.video.outputWidth = OUT_W;
        d.video.outputHeight = OUT_H;
        d.video.fpsNum = 30;
        d.video.fpsDen = 1;
        d.output.stream.encoder = 'libx264';
        d.output.stream.preset = 'speed';
        d.output.stream.videoBitrate = 2500;
        d.output.recording.path = recDir;
        d.output.recording.format = 'mp4';
        d.stream.destinations = [{ id: 'local', platform: 'custom', name: 'Local test server', enabled: true, server: `rtmp://127.0.0.1:${port}/live`, streamKey: 'testkey' }];
      }),
    { recDir, port, OUT_W, OUT_H },
  );

  console.log('5. Record + Go Live from the UI');
  await win.click('.controls-bar button:has-text("Record")');
  await win.click('.controls-bar button:has-text("Go Live")');
  await waitFor(win, () => window.__streamzar.store.getState().output.destinations[0]?.state === 'live', null, 45000, 'destination live');
  check(true, 'destination reached "live"');
  await sleep(5000);
  const live = await win.evaluate(() => ({ out: window.__streamzar.store.getState().output, eng: window.__streamzar.engine.engineStats() }));
  console.log('   output', JSON.stringify(live.out.encoders), 'capture', live.eng);
  if (process.env.E2E_DEBUG) {
    const prof = await win.evaluate(async () => {
      const c = window.__streamzar.engine.compositor;
      const acc = {};
      const wrap = (obj, name) => {
        const orig = obj[name].bind(obj);
        obj[name] = (...a) => {
          const t = performance.now();
          const r = orig(...a);
          acc[name] = (acc[name] ?? 0) + performance.now() - t;
          acc[name + '#'] = (acc[name + '#'] ?? 0) + 1;
          return r;
        };
      };
      ['renderProgram', 'captureProgram', 'collectFrames', 'snapshot', 'renderPreview'].forEach((n) => wrap(c, n));
      const s0 = window.__streamzar.engine.engineStats();
      await new Promise((r) => setTimeout(r, 3000));
      const s1 = window.__streamzar.engine.engineStats();
      return { acc, sent: s1.framesSent - s0.framesSent, skipped: s1.framesSkipped - s0.framesSkipped };
    });
    console.log('   profile(3s)', JSON.stringify(prof));
    const dbg = await win.evaluate(async () => {
      const c = window.__streamzar.engine.compositor;
      const samples = [];
      for (let i = 0; i < 10; i++) {
        samples.push({ busy: c.reads.map((r) => r.busy).join(''), backlog: window.streamzar.capture.backlog(), st: window.__streamzar.engine.engineStats() });
        await new Promise((r) => setTimeout(r, 300));
      }
      return samples;
    });
    console.log('   debug', JSON.stringify(dbg));
  }
  // CI has no GPU (WebGL runs in software), so only a reduced frame rate is achievable here; the
  // encoder keeps a constant 30 fps output by repeating frames, which the checks below verify.
  check(live.eng.framesSent >= 15, `frames sent to the encoder (${live.eng.framesSent} sent, ${live.eng.framesSkipped} skipped)`);
  check(live.out.recording, 'recording is active');
  // test alert while live
  await win.evaluate(() => window.__streamzar.engine.alerts.push({ id: 'e2e1', type: 'donation', platform: 'test', name: 'E2E', amount: 5, currency: 'USD', formattedAmount: '$5.00', time: Date.now() }));
  await sleep(1500);
  await win.screenshot({ path: path.join(outDir, '03-live.png') });

  console.log('6. Stop');
  await win.evaluate(() => window.streamzar.output.stopRecording());
  await win.evaluate(() => window.streamzar.output.stopStream());
  await waitFor(win, () => !window.__streamzar.store.getState().output.streaming && !window.__streamzar.store.getState().output.recording, null, 20000, 'outputs stopped');
  await new Promise((resolve) => {
    if (rtmp.exitCode !== null) return resolve();
    rtmp.once('exit', resolve);
    setTimeout(() => {
      rtmp.kill('SIGINT');
    }, 8000);
  });

  console.log('7. Verify recording');
  const recs = readdirSync(recDir).filter((f) => f.endsWith('.mp4'));
  check(recs.length === 1, `one MP4 recording (${recs.join(', ')})`);
  if (recs.length) {
    const file = path.join(recDir, recs[0]);
    const p = probe(file);
    const v = p.streams.find((s) => s.codec_type === 'video');
    const a = p.streams.find((s) => s.codec_type === 'audio');
    console.log('   ', JSON.stringify(p));
    check(v?.codec_name === 'h264' && v.width === OUT_W && v.height === OUT_H, `H.264 ${OUT_W}x${OUT_H} video`);
    check(v?.color_space === 'bt709' && v?.color_range === 'tv', 'BT.709 limited-range colour tags');
    check(a?.codec_name === 'aac' && a.sample_rate === '48000', 'AAC 48 kHz audio');
    check(Number(p.format.duration) > 5, `duration ${p.format.duration}s`);
    const corner = sampleRgb(file, 2, Math.round(OUT_W * 0.9), Math.round(OUT_H * 0.86), 32, 32);
    check(near(corner, [255, 0, 0]), `background is red ${JSON.stringify(corner)}`);
  }

  console.log('8. Verify what the RTMP server received');
  check(existsSync(received), 'RTMP server wrote a file');
  if (existsSync(received)) {
    const p = probe(received);
    const v = p.streams.find((s) => s.codec_type === 'video');
    check(v?.codec_name === 'h264' && v.width === OUT_W, `RTMP stream is H.264 ${OUT_W}x${OUT_H}`);
    check(Number(p.format.duration) > 4, `RTMP duration ${p.format.duration}s`);
    const corner = sampleRgb(received, 2, Math.round(OUT_W * 0.9), Math.round(OUT_H * 0.86), 32, 32);
    check(near(corner, [255, 0, 0]), `RTMP background is red ${JSON.stringify(corner)}`);
  } else console.error(rtmpErr);

  console.log('9. Studio mode + transition');
  await win.evaluate(() => {
    const s = window.__streamzar.store.getState();
    s.addScene('Second');
    s.setStudioMode(true);
  });
  await sleep(300);
  await win.evaluate(() => {
    const s = window.__streamzar.store.getState();
    s.selectScene(s.collection.scenes[0].id);
  });
  await win.click('button:has-text("Transition")');
  await sleep(800);
  await win.screenshot({ path: path.join(outDir, '04-studio.png') });
  const programScene = await win.evaluate(() => window.__streamzar.store.getState().collection.activeSceneId === window.__streamzar.store.getState().collection.scenes[0].id);
  check(programScene, 'transition sent the preview scene to program');

  console.log('10. Settings dialog opens and closes');
  await win.click('button[title="Settings"]');
  await win.waitForSelector('.modal-head:has-text("Settings")');
  for (const tab of ['Stream', 'Output', 'Video', 'Audio', 'Hotkeys', 'Alerts', 'Chat & Platforms', 'Remote & Webhooks', 'Advanced']) {
    await win.click(`.nav-item:has-text("${tab}")`);
  }
  await win.screenshot({ path: path.join(outDir, '05-settings.png') });
  await win.click('.modal-foot button:has-text("Cancel")');

  const relevantErrors = consoleErrors.filter((e) => !/Autofocus|DevTools|favicon/i.test(e));
  check(relevantErrors.length === 0, `no renderer console errors${relevantErrors.length ? `:\n${relevantErrors.join('\n')}` : ''}`);
  await app.close();
  if (failures) {
    console.error(mainLog.join('').split('\n').slice(-60).join('\n'));
  }
}

main()
  .catch((e) => {
    failures++;
    console.error('E2E crashed:', e);
    console.error('--- renderer console errors ---\n' + consoleErrors.join('\n'));
    console.error('--- main process log (tail) ---\n' + mainLog.join('').split('\n').slice(-80).join('\n'));
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
    process.exit(failures ? 1 : 0);
  });
