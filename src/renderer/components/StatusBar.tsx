import { Radio, Circle, Square, Save, History, Cpu, Gauge, Wifi, AlertTriangle } from 'lucide-react';
import { formatDuration } from '@shared/util';
import { PLATFORMS } from '@shared/platforms';
import { useStore } from '../state/store';
import { engineOrNull, requestStopStreaming, saveReplay, startStreaming, toggleRecording, toggleReplayBuffer, stopStreaming } from '../state/controller';
import { TransitionBar } from './TransitionBar';
import { useTicker } from './ui';

export function ControlsBar() {
  const o = useStore((s) => s.output);
  const studio = useStore((s) => s.studioMode);
  const st = useStore.getState();
  useTicker(500);
  const liveFor = o.streamStartedAt ? formatDuration(Date.now() - o.streamStartedAt) : '';
  const recFor = o.recordingStartedAt ? formatDuration(Date.now() - o.recordingStartedAt) : '';
  return (
    <div className="controls-bar">
      {!studio && <TransitionBar />}
      <div className="spacer" />
      <button className={`btn ${o.replayBuffer ? 'active' : ''}`} onClick={() => void toggleReplayBuffer()} title="Keep the last seconds in memory so you can save highlights">
        <History size={15} /> {o.replayBuffer ? `Replay buffer (${o.replayBufferSeconds}s)` : 'Replay buffer'}
      </button>
      {o.replayBuffer && (
        <button className="btn" onClick={() => void saveReplay()} title="Save the replay buffer to a file">
          <Save size={15} /> Save replay
        </button>
      )}
      <button className={`btn ${o.recording ? 'rec' : ''}`} onClick={() => void toggleRecording()} title={o.recordingPath ?? 'Record to a file'}>
        {o.recording ? <Square size={14} /> : <Circle size={14} />}
        {o.recording ? <span className="timer">REC {recFor}</span> : 'Record'}
      </button>
      {o.streaming ? (
        o.streamStopping ? (
          <button className="btn big danger" onClick={() => void stopStreaming(true)} title="Stop immediately and discard the remaining delayed video">
            Ending{o.stopCountdownSec ? ` in ${o.stopCountdownSec}s` : '…'} (force)
          </button>
        ) : (
          <button className="btn big live" onClick={() => requestStopStreaming()}>
            <Radio size={16} /> End Stream <span className="timer">{liveFor}</span>
          </button>
        )
      ) : (
        <button className="btn big primary" disabled={o.streamStarting} onClick={() => (st.settings.stream.confirmStart ? st.openDialog({ kind: 'goLive' }) : void startStreaming())} onContextMenu={() => st.openDialog({ kind: 'goLive' })}>
          <Radio size={16} /> {o.streamStarting ? 'Starting…' : 'Go Live'}
        </button>
      )}
    </div>
  );
}

export function StatusBar() {
  const o = useStore((s) => s.output);
  const sys = useStore((s) => s.system);
  useTicker(1000);
  const eng = engineOrNull();
  const es = eng?.engineStats();
  const dropped = o.destinations.reduce((n, d) => n + d.droppedFrames, 0);
  const kbps = o.destinations.reduce((n, d) => n + d.kbps, 0);
  const enc = o.encoders[0];
  const lagging = o.encoders.some((e) => e.lagging);
  const skipped = (es?.framesSkipped ?? 0) + o.encoders.reduce((n, e) => n + e.skippedFrames, 0);
  return (
    <footer className="statusbar">
      <span className={`stat ${sys.cpuPercent > 85 ? 'bad' : sys.cpuPercent > 70 ? 'warn' : ''}`} title={`System CPU ${sys.cpuPercent}% · Streamzar ${sys.appCpuPercent}% · ${sys.memoryMB} MB`}>
        <Cpu size={13} /> CPU {sys.cpuPercent}%
      </span>
      <span className="stat" title={`Render time ${es?.renderMs ?? 0} ms per frame`}>
        <Gauge size={13} /> {es?.renderFps.toFixed(1) ?? '0.0'} FPS
      </span>
      {enc && (
        <span className={`stat ${lagging ? 'bad' : ''}`} title="Encoder speed (1.00x = real time)">
          Encoder {enc.speed ? `${enc.speed.toFixed(2)}x` : '…'}
          {lagging && ' — overloaded, lower the preset or resolution'}
        </span>
      )}
      {(skipped > 0 || es?.capturing) && (
        <span className={`stat ${skipped > 0 ? 'warn' : ''}`} title="Frames skipped because rendering or encoding could not keep up">
          Skipped {skipped}
        </span>
      )}
      {o.streaming && (
        <>
          <span className={`stat ${dropped > 0 ? 'warn' : ''}`} title="Frames dropped because the network could not keep up">
            <Wifi size={13} /> Dropped {dropped}
          </span>
          <span className="stat">{kbps.toLocaleString()} kb/s</span>
        </>
      )}
      <div className="spacer" />
      {o.destinations.map((d) => (
        <span
          key={d.id}
          className={`pill ${d.state === 'live' ? 'ok' : d.state === 'error' ? 'err' : 'warn'}`}
          title={d.error ? `${d.name}: ${d.error}` : `${d.name}: ${d.state}${d.retries ? ` (retry ${d.retries})` : ''}`}
        >
          {d.state !== 'live' && <AlertTriangle size={11} />}
          {d.platform === 'custom' ? d.name : PLATFORMS[d.platform].label} · {d.state === 'live' ? `${d.kbps.toLocaleString()} kb/s` : d.state}
        </span>
      ))}
      {o.lastError && !o.streaming && (
        <span className="stat bad" title={o.lastError}>
          <AlertTriangle size={13} /> {o.lastError.slice(0, 80)}
        </span>
      )}
    </footer>
  );
}
