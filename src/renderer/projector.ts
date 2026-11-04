// The projector window is filled by the main window's engine (window.opener). This script only
// handles layout, full screen and closing.
import './styles/projector.css';

const hint = document.getElementById('hint');
let hideTimer = window.setTimeout(() => hint?.classList.add('hidden'), 2500);

document.addEventListener('mousemove', () => {
  hint?.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => hint?.classList.add('hidden'), 2500);
});
document.addEventListener('dblclick', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.fullscreenElement) window.close();
});
