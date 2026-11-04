import { ArrowRightLeft, Settings2 } from 'lucide-react';
import type { TransitionType } from '@shared/types';
import { useStore } from '../state/store';
import { NumberInput, Select } from './ui';

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  cut: 'Cut',
  fade: 'Fade',
  fade_color: 'Fade to color',
  slide: 'Slide',
  swipe: 'Swipe',
  zoom: 'Zoom',
  luma_wipe: 'Luma wipe',
  stinger: 'Stinger (video)',
};

export function TransitionBar(props: { vertical?: boolean }) {
  const t = useStore((s) => s.collection.transition);
  const studio = useStore((s) => s.studioMode);
  const same = useStore((s) => s.previewSceneId === s.collection.activeSceneId);
  const st = useStore.getState();
  const set = (patch: Partial<typeof t>) =>
    st.mutate((d) => {
      Object.assign(d.transition, patch);
    });
  return (
    <div style={{ display: 'flex', flexDirection: props.vertical ? 'column' : 'row', gap: 6, alignItems: props.vertical ? 'stretch' : 'center' }}>
      {studio && (
        <button className="btn primary big" disabled={same} onClick={() => st.transitionToPreview()} title="Send the preview scene to program (Studio mode)">
          <ArrowRightLeft size={16} /> Transition
        </button>
      )}
      <Select<TransitionType> value={t.type} onChange={(v) => set({ type: v })} options={Object.entries(TRANSITION_LABELS).map(([value, label]) => ({ value: value as TransitionType, label }))} />
      <div className="inline" style={{ gap: 4 }}>
        <NumberInput value={t.durationMs} min={0} max={10000} step={50} onChange={(v) => set({ durationMs: v })} style={{ width: props.vertical ? '100%' : 80 }} />
        <span className="muted">ms</span>
        <button className="icon-btn" title="Transition settings" onClick={() => st.openDialog({ kind: 'transitions' })}>
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}
