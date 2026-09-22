import { useRef, useState } from 'react';

const modified = e => e.ctrlKey || e.metaKey;
const rectangle = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

// Selection is transient UI state, never part of the disk draft. The inspector
// uses primary; deletion operates on the entire selected group. A selected
// *connection* is a third, mutually exclusive kind of selection: it is addressed
// as {kind, key} (see model.js connectionRef) and never implies its endpoint
// nodes, so Delete can remove one wire without deleting a node.
export function useNodeSelection(graph, setDraft, navigation) {
  const [selection, setSelection] = useState({ ids: ['output'], primary: 'output' });
  const [wire, setWire] = useState(null);
  const [box, setBox] = useState(null);
  const gesture = useRef(null), suppressClick = useRef(null);
  // Selecting nodes of any kind drops the connection selection, and selecting a
  // connection drops the node selection. Exactly one of the two is ever live.
  const applySelection = next => { setWire(null); setSelection(next); };
  const selectOnly = id => applySelection({ ids: id ? [id] : [], primary: id });
  const choose = (id, e) => {
    if (!modified(e)) { selectOnly(id); return; }
    setWire(null);
    setSelection(previous => {
      const ids = previous.ids.includes(id) ? previous.ids.filter(value => value !== id) : [...previous.ids, id];
      return { ids, primary: ids.includes(id) ? id : ids.includes(previous.primary) ? previous.primary : ids.at(-1) || null };
    });
  };
  const selectWire = ref => {
    gesture.current = null; setBox(null); suppressClick.current = null;
    setSelection({ ids: [], primary: null });
    setWire(ref);
  };
  const clearWire = () => setWire(null);
  const cancel = () => {
    if (gesture.current?.type === 'box') applySelection(gesture.current.before);
    gesture.current = null; setBox(null); setWire(null);
  };
  const reset = id => { cancel(); suppressClick.current = null; selectOnly(id); };
  const moveGroup = (origins, dx, dy) => {
    // The origin is a reference point, not a canvas boundary. Apply the same
    // graph-space delta to every node so dragging/nudging preserves spacing.
    const positions = new Map(origins.map(n => [n.id, { x: n.x + dx, y: n.y + dy }]));
    setDraft(previous => ({ ...previous, graph: { ...previous.graph, nodes: previous.graph.nodes.map(n => positions.has(n.id) ? { ...n, ...positions.get(n.id) } : n) } }));
  };
  const nodeClick = (id, e) => {
    if (suppressClick.current === id) { suppressClick.current = null; return; }
    choose(id, e);
  };
  const titleHandlers = n => ({
    onPointerDown: e => {
      if (e.button !== 0 || gesture.current) return;
      suppressClick.current = null;
      // Modifier clicks toggle only. Even motion while held must not move nodes.
      if (modified(e)) return;
      const ids = selection.ids.includes(n.id) ? selection.ids : [n.id];
      applySelection({ ids, primary: n.id });
      gesture.current = { type: 'nodes', pointerId: e.pointerId, id: n.id, start: navigation.toGraph(e.clientX, e.clientY), clientX: e.clientX, clientY: e.clientY, origins: graph.nodes.filter(item => ids.includes(item.id)), moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: e => {
      const g = gesture.current;
      if (g?.type !== 'nodes' || g.pointerId !== e.pointerId) return;
      if (!g.moved && Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY) < 4) return;
      g.moved = true; suppressClick.current = g.id;
      const point = navigation.toGraph(e.clientX, e.clientY);
      moveGroup(g.origins, point.x - g.start.x, point.y - g.start.y);
    },
    onPointerUp: e => {
      if (gesture.current?.type === 'nodes' && gesture.current.pointerId === e.pointerId) gesture.current = null;
    },
    onPointerCancel: cancel,
    onLostPointerCapture: e => {
      if (gesture.current?.pointerId === e.pointerId) cancel();
    },
    onKeyDown: e => {
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
      if (!delta) return;
      e.preventDefault();
      moveGroup(graph.nodes.filter(item => selection.ids.includes(n.id) ? selection.ids.includes(item.id) : item.id === n.id), ...delta);
    },
  });
  const workspaceHandlers = {
    ...navigation.handlers,
    onPointerDown: e => {
      if (gesture.current) return;
      if (e.button !== 0 || e.pointerType === 'touch') { navigation.handlers.onPointerDown(e); return; }
      // Only genuinely blank canvas starts a marquee, never controls or wires.
      if (e.target.closest('.nodes-node,.nodes-zoom,button,input,select,textarea,a,[role="button"],[contenteditable]')) return;
      e.preventDefault(); e.currentTarget.focus();
      const start = navigation.toGraph(e.clientX, e.clientY);
      const bounds = [...navigation.workspace.current.querySelectorAll('.nodes-node')].map(el => {
        const rect = el.getBoundingClientRect();
        const topLeft = navigation.toGraph(rect.left, rect.top), bottomRight = navigation.toGraph(rect.right, rect.bottom);
        return { id: el.dataset.nodeId, ...topLeft, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
      });
      gesture.current = { type: 'box', pointerId: e.pointerId, start, clientX: e.clientX, clientY: e.clientY, bounds, before: selection, additive: modified(e) };
      setWire(null);
      if (!modified(e)) selectOnly(null);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: e => {
      const g = gesture.current;
      if (g?.type !== 'box' || g.pointerId !== e.pointerId) { navigation.handlers.onPointerMove(e); return; }
      if (!box && Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY) < 4) return;
      const next = rectangle(g.start, navigation.toGraph(e.clientX, e.clientY));
      setBox(next);
      const hits = g.bounds.filter(n => n.x <= next.x + next.width && n.x + n.width >= next.x && n.y <= next.y + next.height && n.y + n.height >= next.y).map(n => n.id);
      const ids = [...new Set([...(g.additive ? g.before.ids : []), ...hits])];
      setSelection({ ids, primary: ids.includes(g.before.primary) ? g.before.primary : ids[0] || null });
    },
    onPointerUp: e => {
      navigation.handlers.onPointerUp(e);
      if (gesture.current?.type === 'box' && gesture.current.pointerId === e.pointerId) { gesture.current = null; setBox(null); }
    },
    onPointerCancel: e => { navigation.handlers.onPointerCancel(e); if (gesture.current?.pointerId === e.pointerId) cancel(); },
    onLostPointerCapture: e => { navigation.handlers.onLostPointerCapture(e); if (gesture.current?.pointerId === e.pointerId) cancel(); },
  };
  return { ...selection, wire, box, reset, cancel, selectWire, clearWire, nodeClick, titleHandlers, workspaceHandlers };
}
