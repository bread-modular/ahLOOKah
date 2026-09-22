import { useEffect, useRef, useState } from 'react';

export function useCanvasNavigation(ready) {
  const workspace = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const live = useRef(view);
  const pointers = useRef(new Map());
  const update = next => { live.current = next; setView(next); };
  const local = (x, y) => {
    const rect = workspace.current.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  };
  const toGraph = (x, y) => {
    const point = local(x, y), v = live.current;
    return { x: (point.x - v.x) / v.zoom, y: (point.y - v.y) / v.zoom };
  };
  const zoomAt = (factor, point = { x: workspace.current.clientWidth / 2, y: workspace.current.clientHeight / 2 }) => {
    const v = live.current, zoom = Math.max(.25, Math.min(2.5, v.zoom * factor));
    update({ zoom, x: point.x - (point.x - v.x) * zoom / v.zoom, y: point.y - (point.y - v.y) * zoom / v.zoom });
  };
  useEffect(() => {
    const el = workspace.current;
    if (!el) return;
    const wheel = e => {
      if (e.target.closest('.nodes-zoom')) return;
      e.preventDefault();
      // Wheel / trackpad pinch zoom about the cursor; Shift or horizontal swipe pans.
      if (!e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        const v = live.current;
        update({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) });
      } else zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? .035 : .002)), local(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [ready]);
  const center = points => ({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length });
  const distance = points => points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  return { workspace, view, toGraph, zoomAt, reset: () => update({ x: 0, y: 0, zoom: 1 }), handlers: {
    onPointerDown: e => {
      if (e.button !== 1 && !(e.pointerType === 'touch' && !e.target.closest('.nodes-node,.nodes-zoom'))) return;
      e.preventDefault();
      pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: e => {
      if (!pointers.current.has(e.pointerId)) return;
      const before = [...pointers.current.values()], oldCenter = center(before);
      pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
      const after = [...pointers.current.values()], nextCenter = center(after), v = live.current;
      const oldDistance = distance(before);
      const zoom = oldDistance > 0 ? Math.max(.25, Math.min(2.5, v.zoom * distance(after) / oldDistance)) : v.zoom;
      update({ zoom, x: nextCenter.x - (oldCenter.x - v.x) * zoom / v.zoom, y: nextCenter.y - (oldCenter.y - v.y) * zoom / v.zoom });
    },
    onPointerUp: e => pointers.current.delete(e.pointerId),
    onPointerCancel: e => pointers.current.delete(e.pointerId),
    onLostPointerCapture: e => pointers.current.delete(e.pointerId),
    onAuxClick: e => { if (e.button === 1) e.preventDefault(); },
  } };
}
