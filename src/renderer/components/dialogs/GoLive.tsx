import { useState } from 'react';
import { Plus, Trash2, ExternalLink, AlertTriangle } from 'lucide-react';
import type { Destination, PlatformId } from '@shared/types';
import { PLATFORMS, PLATFORM_ORDER, bitrateWarnings, validateDestination } from '@shared/platforms';
import { deepClone, uid } from '@shared/util';
import { api } from '../../api';
import { useStore } from '../../state/store';
import { startStreaming } from '../../state/controller';
import { Field, Modal, SecretInput, Select, Switch, TextInput, openMenu } from '../ui';
import { PlatformLogo } from '../icons';

export function newDestination(platform: PlatformId, existing: Destination[]): Destination {
  const p = PLATFORMS[platform];
  const sameCount = existing.filter((d) => d.platform === platform).length;
  return {
    id: uid('dest'),
    platform,
    name: sameCount ? `${p.label} ${sameCount + 1}` : p.label,
    enabled: true,
    server: p.servers[0]?.url ?? '',
    streamKey: '',
  };
}

export function DestinationsEditor(props: { value: Destination[]; onChange: (d: Destination[]) => void }) {
  const [open, setOpen] = useState<string | null>(props.value.find((d) => !d.streamKey)?.id ?? null);
  const update = (id: string, patch: Partial<Destination>) => props.onChange(props.value.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const add = (platform: PlatformId) => {
    const d = newDestination(platform, props.value);
    props.onChange([...props.value, d]);
    setOpen(d.id);
  };
  return (
    <>
      {props.value.map((d) => {
        const p = PLATFORMS[d.platform];
        const problem = d.enabled ? validateDestination(d) : null;
        const isOpen = open === d.id;
        return (
          <div key={d.id} className="card" style={{ padding: 0 }}>
            <div className="dest" style={{ border: 0, margin: 0, background: 'transparent' }}>
              <PlatformLogo platform={d.platform} />
              <div className="info" style={{ cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : d.id)}>
                <div className="n">{d.name}</div>
                <div className="s">
                  {problem ? (
                    <span style={{ color: 'var(--warn)' }}>
                      <AlertTriangle size={11} /> {problem.replace(`${d.name}: `, '')}
                    </span>
                  ) : (
                    `${d.server} · key ${d.streamKey ? '••••' + d.streamKey.slice(-4) : 'not set'}`
                  )}
                </div>
              </div>
              <button className="btn small" onClick={() => setOpen(isOpen ? null : d.id)}>
                {isOpen ? 'Done' : 'Edit'}
              </button>
              <Switch checked={d.enabled} onChange={(b) => update(d.id, { enabled: b })} title="Stream to this destination" />
            </div>
            {isOpen && (
              <div style={{ padding: '0 14px 12px' }}>
                <div className="field-row">
                  <Field label="Name">
                    <TextInput value={d.name} onChange={(v) => update(d.id, { name: v })} />
                  </Field>
                  <Field label="Platform">
                    <Select<PlatformId>
                      value={d.platform}
                      onChange={(v) => update(d.id, { platform: v, server: PLATFORMS[v].servers[0]?.url ?? '' })}
                      options={PLATFORM_ORDER.map((id) => ({ value: id, label: PLATFORMS[id].label }))}
                    />
                  </Field>
                </div>
                <Field label="Server" help={p.serverEditable ? 'Paste the server / stream URL shown by the platform.' : undefined}>
                  {p.servers.length > 0 && (
                    <Select
                      value={p.servers.some((s) => s.url === d.server) ? d.server : '__custom'}
                      onChange={(v) => v !== '__custom' && update(d.id, { server: v })}
                      options={[...p.servers.map((s) => ({ value: s.url, label: `${s.label} — ${s.url}` })), ...(p.serverEditable || d.platform !== 'youtube' ? [{ value: '__custom', label: 'Custom server URL…' }] : [])]}
                    />
                  )}
                  {(p.serverEditable || !p.servers.some((s) => s.url === d.server)) && (
                    <TextInput value={d.server} onChange={(v) => update(d.id, { server: v.trim() })} placeholder="rtmp://… or rtmps://… or srt://…" />
                  )}
                </Field>
                <Field
                  label="Stream key"
                  help={
                    <>
                      {p.keyHelp}{' '}
                      {p.dashboardUrl && (
                        <a href="#" onClick={(e) => (e.preventDefault(), void api.files.openExternal(p.dashboardUrl))}>
                          Open dashboard <ExternalLink size={11} />
                        </a>
                      )}
                    </>
                  }
                >
                  <SecretInput value={d.streamKey} onChange={(v) => update(d.id, { streamKey: v })} placeholder="Paste your stream key" />
                </Field>
                <button className="btn small danger" onClick={() => props.onChange(props.value.filter((x) => x.id !== d.id))}>
                  <Trash2 size={13} /> Remove destination
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="inline wrap" style={{ marginTop: 6 }}>
        {(['youtube', 'facebook', 'twitch'] as PlatformId[]).map((pid) => (
          <button key={pid} className="btn" onClick={() => add(pid)}>
            <Plus size={14} /> {PLATFORMS[pid].label}
          </button>
        ))}
        <button
          className="btn"
          onClick={(e) =>
            openMenu(
              e,
              PLATFORM_ORDER.filter((x) => !['youtube', 'facebook', 'twitch'].includes(x)).map((pid) => ({ label: PLATFORMS[pid].label, onClick: () => add(pid) })),
            )
          }
        >
          <Plus size={14} /> More…
        </button>
      </div>
    </>
  );
}

export function GoLiveDialog() {
  const st = useStore.getState();
  const settings = useStore((s) => s.settings);
  const streaming = useStore((s) => s.output.streaming);
  const [dests, setDests] = useState<Destination[]>(() => deepClone(settings.stream.destinations));
  const [busy, setBusy] = useState(false);
  const enabled = dests.filter((d) => d.enabled);
  const problems = enabled.map(validateDestination).filter((x): x is string => !!x);
  const enc = settings.output.stream;
  const v = settings.video;
  const warnings = bitrateWarnings(dests, enc.videoBitrate, v.outputHeight, v.fpsNum / v.fpsDen);

  const save = async () => {
    await st.patchSettings((d) => {
      d.stream.destinations = dests;
    });
  };
  const goLive = async () => {
    setBusy(true);
    try {
      await save();
      st.openDialog(null);
      await startStreaming();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Go Live"
      size="wide"
      onClose={() => st.openDialog(null)}
      footer={
        <>
          <div className="left">
            <button className="btn" onClick={() => st.openDialog({ kind: 'settings', tab: 'output' })}>
              Quality settings…
            </button>
          </div>
          <button className="btn" onClick={() => void save().then(() => st.openDialog(null))}>
            Save
          </button>
          <button className="btn primary" disabled={busy || streaming || !enabled.length || problems.length > 0} onClick={() => void goLive()}>
            {streaming ? 'Already live' : `Go Live${enabled.length > 1 ? ` on ${enabled.length} platforms` : ''}`}
          </button>
        </>
      }
    >
      <p className="section-sub" style={{ marginBottom: 12 }}>
        Turn on every platform you want to stream to at the same time. Streamzar encodes once and sends the same high-quality stream to all of them.
      </p>
      <DestinationsEditor value={dests} onChange={setDests} />
      <h4>Quality</h4>
      <div className="card">
        {v.outputWidth}×{v.outputHeight} @ {Math.round((v.fpsNum / v.fpsDen) * 100) / 100} fps · {enc.videoBitrate.toLocaleString()} kbps video ({enc.rateControl.toUpperCase()}) · {enc.audioBitrate} kbps AAC audio ·{' '}
        {useStore.getState().encoders.find((e) => e.id === enc.encoder)?.label ?? enc.encoder}
      </div>
      {warnings.map((w) => (
        <div key={w} className="callout warn">
          <AlertTriangle size={15} /> {w}
        </div>
      ))}
      {problems.map((p) => (
        <div key={p} className="callout error">
          {p}
        </div>
      ))}
    </Modal>
  );
}
