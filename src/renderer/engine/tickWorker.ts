// Drift-free frame clock that keeps running while the window is hidden or minimised
// (timers in dedicated workers are not throttled like main-thread timers).
let interval = 1000 / 30;
let timer: ReturnType<typeof setTimeout> | null = null;
let next = 0;

function loop() {
  const now = performance.now(); // worker clock (only used for pacing)
  next += interval;
  // If we fell far behind (system sleep, debugger), resynchronise instead of bursting.
  if (next < now - interval * 4) next = now + interval;
  postMessage(0);
  timer = setTimeout(loop, Math.max(0, next - performance.now()));
}

onmessage = (e: MessageEvent<{ cmd: 'start' | 'stop'; fps?: number }>) => {
  if (timer) clearTimeout(timer);
  timer = null;
  if (e.data.cmd === 'start') {
    interval = 1000 / Math.max(1, Math.min(240, e.data.fps ?? 30));
    next = performance.now();
    loop();
  }
};
