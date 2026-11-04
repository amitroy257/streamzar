import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Transform } from '@shared/types';
import { hitTest, itemBounds, itemCenter, itemCorners, resizeByHandle, snapBounds, localToCanvas, itemBox, type Handle, type Pt } from '@shared/transform';
import { sourceHasVideo } from '@shared/defaults';
import { useStore } from '../state/store';
import { engineOrNull, takeScreenshot } from '../state/controller';
import { itemMenu } from './menus';
import { openMenu, useTicker } from './ui';
import { TransitionBar } from './TransitionBar';

interface Mapping {
  scale: number;
  ox: number;
  oy: number;
}

type Drag =
  | { kind: 'move'; start: Pt; items: { id: string; t: Transform }[]; key: string }
  | { kind: 'resize'; itemId: string; handle: Handle; t: Transform; natW: number; natH: number; key: string }
  | { kind: 'rotate'; itemId: string; t: Transform; center: Pt; startAngle: number; key: string };

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_POS: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function Stage(props: { kind: 'program' | 'preview'; editable: boolean; sceneId: string; label: string; live?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [hover, setHover] = useState<string | null>(null);
  useTicker(drag ? 1000 : 400); // refresh natural sizes of loading sources
  const settings = useStore((s) => s.settings);
  const collection = useStore((s) => s.collection);
  const selected = useStore((s) => s.selectedItemIds);
  const baseW = settings.video.baseWidth;
  const baseH = settings.video.baseHeight;
  const scene = collection.scenes.find((x) => x.id === props.sceneId);

  useEffect(() => {
    const eng = engineOrNull();
    eng?.attachDisplay(props.kind, canvasRef.current);
    return () => eng?.attachDisplay(props.kind, null);
  }, [props.kind]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = size.w && size.h ? Math.min(size.w / baseW, size.h / baseH) : 1;
  const map: Mapping = { scale, ox: (size.w - baseW * scale) / 2, oy: (size.h - baseH * scale) / 2 };
  const toScreen = (p: Pt): Pt => ({ x: p.x * map.scale + map.ox, y: p.y * map.scale + map.oy });
  const toCanvas = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - map.ox) / map.scale, y: (e.clientY - r.top - map.oy) / map.scale };
  }, [map.ox, map.oy, map.scale]);

  const eng = engineOrNull();
  const sizeOf = (sourceId: string) => eng?.sourceSize(sourceId) ?? { width: 0, height: 0 };
  const items = (scene?.items ?? []).filter((it) => {
    const src = collection.sources.find((s) => s.id === it.sourceId);
    return src && sourceHasVideo(src.type);
  });

  const itemAt = (p: Pt, includeLocked = false): string | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.visible || (!includeLocked && it.locked)) continue;
      const { width, height } = sizeOf(it.sourceId);
      if (width > 0 && hitTest(it.transform, width, height, p, 2 / map.scale)) return it.id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!props.editable || e.button !== 0) return;
    const p = toCanvas(e);
    const st = useStore.getState();
    const target = e.target as SVGElement;
    const handle = target.getAttribute?.('data-handle') as Handle | 'rotate' | null;
    const handleItem = target.getAttribute?.('data-item');
    const key = `drag-${Date.now()}`;
    if (handle && handleItem) {
      const it = items.find((x) => x.id === handleItem);
      if (!it || it.locked) return;
      const { width, height } = sizeOf(it.sourceId);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      if (handle === 'rotate') {
        const c = itemCenter(it.transform, width, height);
        setDrag({ kind: 'rotate', itemId: it.id, t: it.transform, center: c, startAngle: Math.atan2(p.y - c.y, p.x - c.x), key });
      } else {
        setDrag({ kind: 'resize', itemId: it.id, handle, t: it.transform, natW: width, natH: height, key });
      }
      return;
    }
    const hit = itemAt(p);
    if (!hit) {
      st.selectItems([]);
      return;
    }
    let sel = st.selectedItemIds;
    if (e.ctrlKey || e.metaKey) sel = sel.includes(hit) ? sel.filter((x) => x !== hit) : [...sel, hit];
    else if (!sel.includes(hit)) sel = [hit];
    st.selectItems(sel);
    const moving = items.filter((x) => sel.includes(x.id) && !x.locked).map((x) => ({ id: x.id, t: x.transform }));
    if (moving.length) {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDrag({ kind: 'move', start: p, items: moving, key });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    if (!drag) {
      if (props.editable) setHover(itemAt(p));
      return;
    }
    const st = useStore.getState();
    const snapOn = st.settings.general.snapping && !e.ctrlKey;
    const snapDist = st.settings.general.snapDistance / map.scale;
    if (drag.kind === 'move') {
      let dx = p.x - drag.start.x;
      let dy = p.y - drag.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (snapOn && drag.items.length === 1) {
        const it = drag.items[0];
        const src = scene!.items.find((x) => x.id === it.id)!;
        const { width, height } = sizeOf(src.sourceId);
        const moved = { ...it.t, x: it.t.x + dx, y: it.t.y + dy };
        const others = items.filter((x) => x.id !== it.id && x.visible).map((x) => {
          const z = sizeOf(x.sourceId);
          return itemBounds(x.transform, z.width, z.height);
        });
        const snap = snapBounds(itemBounds(moved, width, height), baseW, baseH, others, snapDist);
        dx += snap.dx;
        dy += snap.dy;
        setGuides({ x: snap.guidesX, y: snap.guidesY });
      } else setGuides({ x: [], y: [] });
      for (const it of drag.items) st.setItemTransform(it.id, { ...it.t, x: Math.round(it.t.x + dx), y: Math.round(it.t.y + dy) }, { key: drag.key });
    } else if (drag.kind === 'resize') {
      const keepAspect = drag.handle.length === 2 ? !e.shiftKey : e.shiftKey;
      let next = resizeByHandle(drag.t, drag.natW, drag.natH, drag.handle, p, { keepAspect, crop: e.altKey });
      if (snapOn && drag.t.rotation % 360 === 0 && !e.altKey) {
        // snap the dragged edge(s) to the canvas edges / centre
        const b = itemBounds(next, drag.natW, drag.natH);
        const snap = snapBounds(b, baseW, baseH, [], snapDist);
        if ((snap.dx || snap.dy) && !keepAspect) {
          const corr = { x: p.x + snap.dx, y: p.y + snap.dy };
          next = resizeByHandle(drag.t, drag.natW, drag.natH, drag.handle, corr, { keepAspect, crop: false });
        }
        setGuides({ x: snap.guidesX, y: snap.guidesY });
      }
      st.setItemTransform(drag.itemId, next, { key: drag.key });
    } else {
      const a = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
      let deg = drag.t.rotation + ((a - drag.startAngle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = ((deg % 360) + 360) % 360;
      // rotate around the centre: keep the centre fixed
      const { width, height } = sizeOf(scene!.items.find((x) => x.id === drag.itemId)!.sourceId);
      const b = itemBox(drag.t, width, height);
      const c = itemCenter(drag.t, width, height);
      st.setItemTransform(drag.itemId, { ...drag.t, rotation: Math.round(deg * 10) / 10, x: c.x - b.w / 2, y: c.y - b.h / 2 }, { key: drag.key });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (drag) {
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    setDrag(null);
    setGuides({ x: [], y: [] });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!props.editable) return;
    const hit = itemAt(toCanvas(e), true);
    if (hit) {
      const it = items.find((x) => x.id === hit)!;
      useStore.getState().openDialog({ kind: 'properties', sourceId: it.sourceId });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!props.editable) return;
    const hit = itemAt(toCanvas(e), true);
    if (hit) {
      useStore.getState().selectItems([hit]);
      openMenu(e, itemMenu(hit));
    } else {
      const st = useStore.getState();
      openMenu(e, [
        { label: 'Add source…', onClick: () => st.openDialog({ kind: 'addSource' }) },
        { label: 'Paste', disabled: !st.clipboard, onClick: () => st.pasteItem() },
        { separator: true },
        { label: 'Open projector (program)', onClick: () => openProjector() },
        { label: 'Take screenshot of program', onClick: () => void takeScreenshot() },
      ]);
    }
  };

  const selectedHere = items.filter((it) => selected.includes(it.id));
  const isEmpty = !scene?.items.length;

  return (
    <div className="view">
      <div className="view-label">
        {props.live && <span className="live-dot" />}
        {props.label}
      </div>
      <div ref={stageRef} className={`stage ${props.kind === 'program' && !props.editable ? 'program-active' : ''}`}>
        <canvas ref={canvasRef} className="display" />
        {props.editable && (
          <svg
            className="overlay"
            style={{ cursor: drag?.kind === 'move' ? 'move' : hover ? 'move' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <rect x={map.ox} y={map.oy} width={baseW * map.scale} height={baseH * map.scale} fill="none" stroke="rgba(255,255,255,0.12)" />
            {hover && !selected.includes(hover) && !drag && (() => {
              const it = items.find((x) => x.id === hover);
              if (!it) return null;
              const z = sizeOf(it.sourceId);
              const pts = itemCorners(it.transform, z.width, z.height).map(toScreen);
              return <polygon points={pts.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="rgba(49,195,162,0.6)" strokeDasharray="4 3" pointerEvents="none" />;
            })()}
            {selectedHere.map((it) => {
              const z = sizeOf(it.sourceId);
              if (!z.width || !z.height) return null;
              const corners = itemCorners(it.transform, z.width, z.height).map(toScreen);
              const b = itemBox(it.transform, z.width, z.height);
              const top = toScreen(localToCanvas(it.transform, z.width, z.height, { x: b.w / 2, y: 0 }));
              const rotH = toScreen(localToCanvas(it.transform, z.width, z.height, { x: b.w / 2, y: -26 / map.scale }));
              const color = it.locked ? '#f5a524' : '#31c3a2';
              return (
                <g key={it.id}>
                  <polygon points={corners.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={color} strokeWidth={1.5} pointerEvents="none" />
                  {!it.locked && (
                    <>
                      <line x1={top.x} y1={top.y} x2={rotH.x} y2={rotH.y} stroke={color} pointerEvents="none" />
                      <circle cx={rotH.x} cy={rotH.y} r={6} fill="#fff" stroke={color} strokeWidth={2} data-handle="rotate" data-item={it.id} style={{ cursor: 'grab' }} />
                      {HANDLES.map((h) => {
                        const [fx, fy] = HANDLE_POS[h];
                        const q = toScreen(localToCanvas(it.transform, z.width, z.height, { x: b.w * fx, y: b.h * fy }));
                        return <rect key={h} x={q.x - 5} y={q.y - 5} width={10} height={10} rx={2} fill="#fff" stroke={color} strokeWidth={1.5} data-handle={h} data-item={it.id} style={{ cursor: CURSORS[h] }} />;
                      })}
                    </>
                  )}
                </g>
              );
            })}
            {guides.x.map((gx, i) => (
              <line key={`gx${i}`} x1={toScreen({ x: gx, y: 0 }).x} y1={map.oy} x2={toScreen({ x: gx, y: 0 }).x} y2={map.oy + baseH * map.scale} stroke="#ff4fd8" strokeDasharray="5 4" pointerEvents="none" />
            ))}
            {guides.y.map((gy, i) => (
              <line key={`gy${i}`} x1={map.ox} y1={toScreen({ x: 0, y: gy }).y} x2={map.ox + baseW * map.scale} y2={toScreen({ x: 0, y: gy }).y} stroke="#ff4fd8" strokeDasharray="5 4" pointerEvents="none" />
            ))}
          </svg>
        )}
        {props.editable && isEmpty && (
          <div className="empty-hint">
            <div>
              This scene is empty.
              <br />
              Click <b>+</b> in <b>Sources</b> to add a camera, game/window, display, image, alerts and more.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function openProjector(displayId?: string) {
  const eng = engineOrNull();
  if (!eng) return;
  const url = `app://streamzar/projector.html${displayId ? `?display=${encodeURIComponent(displayId)}` : ''}`;
  const win = window.open(url, '_blank');
  if (!win) return;
  const attach = () => {
    const canvas = win.document.getElementById('projector') as HTMLCanvasElement | null;
    if (!canvas) {
      setTimeout(attach, 100);
      return;
    }
    const detach = eng.attachProjector(canvas);
    win.addEventListener('beforeunload', detach);
  };
  win.addEventListener('load', attach);
}

export function Editor() {
  const studio = useStore((s) => s.studioMode);
  const activeSceneId = useStore((s) => s.collection.activeSceneId);
  const previewSceneId = useStore((s) => s.previewSceneId);
  const streaming = useStore((s) => s.output.streaming);
  if (!studio) {
    return (
      <div className="editor">
        <Stage kind="program" editable sceneId={activeSceneId} label={streaming ? 'Live' : 'Editor (program)'} live={streaming} />
      </div>
    );
  }
  return (
    <div className="editor">
      <Stage kind="preview" editable sceneId={previewSceneId ?? activeSceneId} label="Preview (edit)" />
      <div className="studio-mid">
        <TransitionBar vertical />
      </div>
      <Stage kind="program" editable={false} sceneId={activeSceneId} label="Program" live={streaming} />
    </div>
  );
}
