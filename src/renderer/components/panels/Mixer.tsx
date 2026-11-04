import { useEffect, useRef } from 'react';
import { Volume2, VolumeX, Settings, Headphones, SlidersVertical } from 'lucide-react';
import { dbToFader, faderToDb, MIN_DB } from '@shared/util';
import { useStore } from '../../state/store';
import { engineOrNull, mixerSourceIds } from '../../state/controller';
import { openMenu } from '../ui';

const METER_MIN = -60;

function dbToX(db: number, w: number) {
  return Math.max(0, Math.min(1, (db - METER_MIN) / -METER_MIN)) * w;
}

/** Stereo peak/RMS meter drawn on a canvas at display refresh rate. */
function Meter(props: { sourceId: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const hold = [-100, -100];
    const holdAt = [0, 0];
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      const eng = engineOrNull();
      if (!c || !eng || document.hidden) return;
      const w = c.clientWidth * devicePixelRatio;
      const h = c.clientHeight * devicePixelRatio;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const lv = props.sourceId ? eng.audio.levels(props.sourceId) : eng.audio.masterLevels();
      ctx.clearRect(0, 0, w, h);
      const bar = h / 2 - 1;
      const now = performance.now();
      for (let ch = 0; ch < 2; ch++) {
        const y = ch * (bar + 2);
        const peak = lv.peak[ch];
        const rms = lv.rms[ch];
        if (peak > hold[ch] || now - holdAt[ch] > 1500) {
          hold[ch] = peak;
          holdAt[ch] = now;
        }
        // background zones
        ctx.fillStyle = 'rgba(49,195,162,0.18)';
        ctx.fillRect(0, y, dbToX(-20, w), bar);
        ctx.fillStyle = 'rgba(245,165,36,0.18)';
        ctx.fillRect(dbToX(-20, w), y, dbToX(-9, w) - dbToX(-20, w), bar);
        ctx.fillStyle = 'rgba(239,68,68,0.2)';
        ctx.fillRect(dbToX(-9, w), y, w - dbToX(-9, w), bar);
        // peak bar (bright), split into colour zones
        const px = dbToX(peak, w);
        const g = Math.min(px, dbToX(-20, w));
        ctx.fillStyle = '#31c3a2';
        ctx.fillRect(0, y, g, bar);
        if (px > g) {
          const yl = Math.min(px, dbToX(-9, w));
          ctx.fillStyle = '#f5a524';
          ctx.fillRect(g, y, yl - g, bar);
          if (px > yl) {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(yl, y, px - yl, bar);
          }
        }
        // rms overlay (darker)
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, y, dbToX(rms, w), bar);
        // peak hold tick
        if (hold[ch] > METER_MIN) {
          ctx.fillStyle = hold[ch] > -1 ? '#ef4444' : '#e8eaf0';
          ctx.fillRect(Math.max(0, dbToX(hold[ch], w) - 2), y, 2, bar);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [props.sourceId]);
  return <canvas ref={ref} className="meter" />;
}

export function MixerPanel() {
  const collection = useStore((s) => s.collection);
  useStore((s) => s.studioMode);
  useStore((s) => s.previewSceneId);
  const st = useStore.getState();
  const ids = mixerSourceIds();
  const eng = engineOrNull();

  const menu = (e: React.MouseEvent, id: string) => {
    const src = collection.sources.find((s) => s.id === id);
    if (!src) return;
    const isGlobal = collection.globalAudioSourceIds.includes(id);
    openMenu(e, [
      { heading: src.name },
      { label: 'Properties…', onClick: () => st.openDialog({ kind: 'properties', sourceId: id }) },
      { label: 'Audio filters & advanced audio…', onClick: () => st.openDialog({ kind: 'advancedAudio' }) },
      { label: 'Rename…', onClick: () => st.openDialog({ kind: 'prompt', title: 'Rename source', label: 'Name', value: src.name, onSubmit: (v) => st.renameSource(id, v) }) },
      { separator: true },
      { heading: 'Monitoring' },
      { label: 'Monitor off', checked: src.audio.monitoring === 'off', onClick: () => st.updateAudio(id, { monitoring: 'off' }) },
      { label: 'Monitor only (mute output)', checked: src.audio.monitoring === 'monitor-only', onClick: () => st.updateAudio(id, { monitoring: 'monitor-only' }) },
      { label: 'Monitor and output', checked: src.audio.monitoring === 'monitor-output', onClick: () => st.updateAudio(id, { monitoring: 'monitor-output' }) },
      { separator: true },
      ...(isGlobal ? [{ label: 'Remove global audio source', danger: true, onClick: () => st.removeSource(id) }] : []),
    ]);
  };

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="grow">Audio Mixer</span>
        <button className="icon-btn" title="Advanced audio properties" onClick={() => st.openDialog({ kind: 'advancedAudio' })}>
          <SlidersVertical size={15} />
        </button>
      </div>
      <div className="dock-body">
        <div className="mixer">
          <div className="strip">
            <div className="strip-top">
              <span className="name">Master (stream &amp; recording)</span>
            </div>
            <Meter sourceId={null} />
          </div>
          {ids.map((id) => {
            const src = collection.sources.find((s) => s.id === id)!;
            const a = src.audio;
            const active = collection.globalAudioSourceIds.includes(id) || eng?.isActive(id);
            return (
              <div key={id} className={`strip ${a.muted ? 'muted' : ''} ${active ? '' : 'inactive'}`} onContextMenu={(e) => menu(e, id)}>
                <div className="strip-top">
                  <span className="name" title={src.name}>
                    {src.name}
                  </span>
                  {a.monitoring !== 'off' && (
                    <span title={a.monitoring === 'monitor-only' ? 'Monitor only (not in stream)' : 'Monitored'} style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                      <Headphones size={13} />
                    </span>
                  )}
                  <span className="db">{a.volumeDb <= MIN_DB ? '-inf dB' : `${a.volumeDb.toFixed(1)} dB`}</span>
                  <button className={`icon-btn ${a.muted ? 'danger' : ''}`} style={a.muted ? { color: 'var(--live)' } : undefined} title={a.muted ? 'Unmute' : 'Mute'} onClick={() => st.updateAudio(id, { muted: !a.muted })}>
                    {a.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  </button>
                  <button className="icon-btn" title="Options" onClick={(e) => menu(e, id)}>
                    <Settings size={14} />
                  </button>
                </div>
                <Meter sourceId={id} />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={dbToFader(a.volumeDb)}
                  onChange={(e) => st.updateAudio(id, { volumeDb: Math.round(faderToDb(parseFloat(e.target.value)) * 10) / 10 }, { key: `vol-${id}` })}
                  onDoubleClick={() => st.updateAudio(id, { volumeDb: 0 })}
                  title="Volume (double-click for 0 dB)"
                  aria-label={`${src.name} volume`}
                />
              </div>
            );
          })}
          {!ids.length && <div className="muted" style={{ padding: 12 }}>No audio sources. Add a microphone or desktop audio in Sources or in Settings → Audio.</div>}
        </div>
      </div>
    </div>
  );
}
