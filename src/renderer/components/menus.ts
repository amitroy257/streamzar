import type { SceneItem, Source, Transform } from '@shared/types';
import { fitTransform, type FitMode } from '@shared/transform';
import { sourceHasVideo } from '@shared/defaults';
import { useStore, itemById, sourceById } from '../state/store';
import { engineOrNull } from '../state/controller';
import type { MenuEntry } from './ui';

export function applyFit(itemId: string, mode: FitMode) {
  const s = useStore.getState();
  const item = itemById(itemId);
  const eng = engineOrNull();
  if (!item || !eng) return;
  const size = eng.sourceSize(item.sourceId);
  if (!size.width || !size.height) {
    s.notify('warning', 'This source has no size yet (it may still be loading).');
    return;
  }
  s.setItemTransform(itemId, fitTransform(item.transform, size.width, size.height, s.settings.video.baseWidth, s.settings.video.baseHeight, mode));
}

function patchTransform(item: SceneItem, patch: Partial<Transform>) {
  useStore.getState().setItemTransform(item.id, { ...item.transform, ...patch });
}

export function itemMenu(itemId: string): MenuEntry[] {
  const s = useStore.getState();
  const item = itemById(itemId);
  if (!item) return [];
  const src = sourceById(item.sourceId);
  if (!src) return [];
  const eng = engineOrNull();
  const rt = eng?.runtime(src.id);
  const entries: MenuEntry[] = [{ heading: src.name }];
  entries.push({ label: 'Properties…', onClick: () => s.openDialog({ kind: 'properties', sourceId: src.id }) });
  if (sourceHasVideo(src.type)) entries.push({ label: 'Filters…', onClick: () => s.openDialog({ kind: 'filters', sourceId: src.id }) });
  entries.push({
    label: 'Rename…',
    onClick: () => s.openDialog({ kind: 'prompt', title: 'Rename source', label: 'Name', value: src.name, onSubmit: (v) => s.renameSource(src.id, v) }),
  });
  if (src.type === 'media' && rt?.control) {
    entries.push({ separator: true });
    entries.push({ label: 'Play', onClick: () => rt.control?.('play') });
    entries.push({ label: 'Pause', onClick: () => rt.control?.('pause') });
    entries.push({ label: 'Restart', onClick: () => rt.control?.('restart') });
    entries.push({ label: 'Stop', onClick: () => rt.control?.('stop') });
  }
  if (src.type === 'browser') entries.push({ label: 'Refresh page', onClick: () => void (rt as unknown as { refresh?: () => void })?.refresh?.() });
  if (src.type === 'countdown') entries.push({ label: 'Restart timer', onClick: () => rt?.control?.('restart') });
  if (src.type === 'goal') entries.push({ label: 'Reset goal progress', onClick: () => s.updateSourceSettings(src.id, { current: 0 }) });
  if (sourceHasVideo(src.type)) {
    entries.push({ separator: true }, { heading: 'Transform' });
    entries.push({ label: 'Edit transform…', kbd: 'Ctrl+E', onClick: () => s.openDialog({ kind: 'transform', itemId }) });
    entries.push({ label: 'Fit to screen', kbd: 'Ctrl+F', onClick: () => applyFit(itemId, 'fit') });
    entries.push({ label: 'Stretch to screen', kbd: 'Ctrl+S', onClick: () => applyFit(itemId, 'stretch') });
    entries.push({ label: 'Fill screen (crop overflow)', onClick: () => applyFit(itemId, 'fill') });
    entries.push({ label: 'Center on screen', kbd: 'Ctrl+D', onClick: () => applyFit(itemId, 'center') });
    entries.push({ label: 'Reset transform', kbd: 'Ctrl+R', onClick: () => applyFit(itemId, 'reset') });
    entries.push({ label: 'Rotate 90° clockwise', onClick: () => patchTransform(item, { rotation: (item.transform.rotation + 90) % 360 }) });
    entries.push({ label: 'Rotate 90° counter-clockwise', onClick: () => patchTransform(item, { rotation: (item.transform.rotation + 270) % 360 }) });
    entries.push({ label: 'Rotate 180°', onClick: () => patchTransform(item, { rotation: (item.transform.rotation + 180) % 360 }) });
    entries.push({ label: 'Flip horizontal', onClick: () => patchTransform(item, { flipH: !item.transform.flipH }) });
    entries.push({ label: 'Flip vertical', onClick: () => patchTransform(item, { flipV: !item.transform.flipV }) });
  }
  entries.push({ separator: true }, { heading: 'Order' });
  entries.push({ label: 'Move to top', onClick: () => s.moveItem(itemId, 'top') });
  entries.push({ label: 'Move up', onClick: () => s.moveItem(itemId, 'up') });
  entries.push({ label: 'Move down', onClick: () => s.moveItem(itemId, 'down') });
  entries.push({ label: 'Move to bottom', onClick: () => s.moveItem(itemId, 'bottom') });
  entries.push({ separator: true });
  entries.push({ label: item.visible ? 'Hide' : 'Show', onClick: () => s.setItemVisible(itemId, !item.visible) });
  entries.push({ label: item.locked ? 'Unlock' : 'Lock', onClick: () => s.setItemLocked(itemId, !item.locked) });
  entries.push({ label: 'Copy', kbd: 'Ctrl+C', onClick: () => s.copyItem(itemId) });
  entries.push({ label: 'Paste (reference)', kbd: 'Ctrl+V', disabled: !s.clipboard, onClick: () => s.pasteItem() });
  entries.push({ label: 'Duplicate (new source)', onClick: () => s.duplicateItem(itemId) });
  entries.push({ separator: true });
  entries.push({ label: 'Remove', kbd: 'Del', danger: true, onClick: () => s.removeItem(itemId) });
  return entries;
}

export function sourceIsAudioOnly(src: Source): boolean {
  return !sourceHasVideo(src.type);
}
