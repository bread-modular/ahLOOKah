import { IconControl } from '../components/control/IconControl.jsx';
import { ParameterControl } from '../components/control/ParameterControl.jsx';
import { useCanvasNavigation } from './useCanvasNavigation.js';
import { useNodeSelection } from './useNodeSelection.js';
import { nodeEditorUrl } from './routes.js';
import { Select } from '../components/control/Select.jsx';
import { useEffect, useRef, useState } from 'react';
import { SKETCHES } from '../sketch-registry.js';
import { MEDIA_STORAGE_KEY, registerMediaSketches } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY, registerProjectionSketches } from '../projection/projection-registry.js';
import { CustomScripts } from '../custom-scripts/service.js';
import { MODES, newGraph, validateGraph, connect, deleteNode, inputs, DRAG_TYPE, readPatternDrag } from './model.js';
import { GraphRuntime } from './runtime.js';
import { nodePatterns, watchGraphs } from './repository.js';
import { manifestFor, sourceDiagnostics, serializeGraph } from './portability.js';
import './nodes.css';

function initialParams(sketch) {
  let bank = {};
  try { bank = JSON.parse(localStorage.getItem('viz2_params') || '{}')?.[sketch.id] || {}; } catch {}
  return Object.fromEntries((sketch.params || []).map(p => [p.key, Number.isFinite(bank[p.key]) && bank[p.key] >= p.min && bank[p.key] <= p.max ? bank[p.key] : p.default]));
}
function Preview({ graph, dependencies, selected, revision }) {
  const canvas = useRef(null), current = useRef(null), target = useRef(selected);
  const [messages, setMessages] = useState([]);
  target.current = selected;
  // Moving nodes/renaming does not destroy GPU sources or restart videos.
  const content = JSON.stringify({ ...graph, name: 'preview', nodes: graph.nodes.map(({ x, y, ...n }) => ({ ...n, x: 0, y: 0 })) });
  const manifest = JSON.stringify(dependencies);
  useEffect(() => {
    let runtime, frame, oldMessage = '';
    try {
      runtime = new GraphRuntime({ graph: JSON.parse(content), dependencies: JSON.parse(manifest), sketches: SKETCHES });
      current.current = runtime;
      const render = () => {
        const image = runtime.render(target.current || undefined);
        const ctx = canvas.current.getContext('2d'); ctx.clearRect(0, 0, 480, 270);
        if (image) ctx.drawImage(image, 0, 0, 480, 270);
        const diagnostics = runtime.getDiagnostics(); const text = diagnostics.join('\n');
        if (text !== oldMessage) { oldMessage = text; setMessages(diagnostics); }
        frame = requestAnimationFrame(render);
      };
      setMessages([]); render();
    } catch (e) { setMessages([e.message]); }
    return () => { cancelAnimationFrame(frame); runtime?.dispose(); current.current = null; };
  }, [content, manifest, revision]);
  return <><canvas ref={canvas} width="480" height="270" aria-label="Selected node live preview" data-testid="node-preview" /><div role="status" className="nodes-diagnostics">{messages.map((m, i) => <p key={i}>{m}</p>)}</div></>;
}
export function NodesEditor() {
  const [draft, setDraft] = useState(() => ({ graph: newGraph(), dependencies: [] }));
  const { graph, dependencies } = draft;
  const [pending, setPending] = useState(null);
  const [query, setQuery] = useState(''), [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [routeId, setRouteId] = useState(() => new URLSearchParams(location.search).get('graph'));
  const [loadState, setLoadState] = useState('loading');
  const navigation = useCanvasNavigation(loadState === 'ready');
  const selection = useNodeSelection(graph, setDraft, navigation);
  const selected = selection.primary;
  const setSelected = selection.reset;
  const [current, setCurrent] = useState(null), [busy, setBusy] = useState(false);
  const baseline = useRef(serializeGraph(newGraph(), []));
  const dirty = () => serializeGraph(graph, dependencies) !== baseline.current;
  const discard = () => !dirty() || window.confirm('Discard unsaved changes to this draft?');
  const diskAction = async fn => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { setMessage(e.name === 'AbortError' ? 'Canceled. Draft retained.' : e.message); }
    finally { setBusy(false); }
  };
  const node = graph.nodes.find(n => n.id === selected);
  const sketch = SKETCHES.find(s => s.id === node?.patternId);
  const label = n => n.type === 'pattern' ? SKETCHES.find(s => s.id === n.patternId)?.name || n.patternId : n.type === 'blend' ? 'Blend' : 'Output';
  useEffect(() => {
    const refresh = () => { setRevision(v => v + 1); };
    const stop = watchGraphs(() => { if (nodePatterns.errors.length) setMessage(nodePatterns.errors.join('; ')); });
    const sync = event => {
      // Control/screen leases and LIVE parameter writes are NOT draft changes.
      if (event.key !== null && ![MEDIA_STORAGE_KEY, PROJECTION_STORAGE_KEY].includes(event.key)) return;
      registerMediaSketches(SKETCHES); registerProjectionSketches(SKETCHES); refresh();
    };
    window.addEventListener('storage', sync);
    const scripts = new CustomScripts({ role: 'nodes', onChange: refresh, onStatus: status => { if (status.errors.length) setMessage(status.errors.join('; ')); } });
    scripts.start();
    return () => { stop(); window.removeEventListener('storage', sync); scripts.close(); };
  }, []);
  const attempt = fn => { try { fn(); } catch (e) { setMessage(e.message); } };
  const edit = next => { setDraft(d => ({ ...d, graph: validateGraph(next) })); };
  const patch = values => attempt(() => edit({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...values } : n) }));
  function add(patternId = null, x = 70, y = 60 + graph.nodes.length * 35) {
    attempt(() => {
      const s = SKETCHES.find(s => s.id === patternId);
      if (patternId && (!s || s.nodesGraph)) throw new Error('Choose a non-graph source; recursive graphs are not supported');
      const n = { id: `n${crypto.randomUUID().slice(0, 8)}`, type: patternId ? 'pattern' : 'blend', x: Math.max(0, Math.min(3800, x)), y: Math.max(0, Math.min(3800, y)),
        ...(patternId ? { patternId, params: initialParams(s) } : { mode: 'Normal', opacity: 1 }) };
      const next = validateGraph({ ...graph, nodes: [...graph.nodes, n] });
      const fresh = manifestFor(next, SKETCHES);
      // Preserve opened dependency fingerprints until explicit refresh.
      setDraft({ graph: next, dependencies: fresh.map(d => dependencies.find(old => old.id === d.id) || d) });
      setSelected(n.id); setMessage('');
    });
  }
  function port(to, name) {
    if (!pending) { setMessage('Choose an output port first, then an input port.'); return; }
    attempt(() => { edit(connect(graph, pending, to, name)); setPending(null); setMessage(''); });
  }
  const remove = () => { if (!node || node.type === 'output') return; edit(deleteNode(graph, selected)); setSelected('output'); setPending(null); };
  function load(record) {
    const data = { graph: structuredClone(record.graph), dependencies: structuredClone(record.dependencies || []) };
    setDraft(data); setCurrent(record); baseline.current = serializeGraph(data.graph, data.dependencies);
    setSelected('output'); setPending(null); setMessage('');
  }
  // Resolve exactly this ID after restoring shared handles. Never fall back to
  // another record (or an editable empty graph) if disk access fails.
  async function resolveRoute(requestAccess = false) {
    setLoadState('loading');
    try {
      if (requestAccess) await nodePatterns.reconnect();
      else await nodePatterns.refresh();
      if (routeId !== null) {
        const record = nodePatterns.records.find(r => r.id === routeId);
        if (!record) throw new Error(`Node pattern not found or unavailable. ${nodePatterns.errors.join('; ')} Return to Node Patterns in the main UI to link or open its file.`);
        load(record);
      }
      setLoadState('ready');
    } catch (e) { setMessage(e.message); setLoadState('error'); }
  }
  useEffect(() => { resolveRoute(); }, []);
  function updateRoute(id) {
    history.replaceState(null, '', nodeEditorUrl(id));
    setRouteId(id ?? null);
  }
  useEffect(() => {
    const warn = e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  if (loadState !== 'ready') return <main className="nodes-app">
    <header className="nodes-toolbar"><h1>Pattern editor</h1><a href="/" target="_blank" rel="noopener">Main pattern library ↗</a></header>
    {loadState === 'loading' ? <p role="status">Loading selected node pattern from disk…</p> : <section role="alert"><p>{message}</p><button className="btn" onClick={() => resolveRoute(true)}>Retry loading</button></section>}
  </main>;
  return <main className="nodes-app">
    <header className="nodes-toolbar">
      <input className="control-input" aria-label="Graph name" title="Edit pattern name" disabled={busy} value={graph.name} maxLength={80} onChange={e => setDraft({ ...draft, graph: { ...graph, name: e.target.value } })} />
      <div className="nodes-toolbar-actions">
        {current && <IconControl className="btn--status-size" icon="reload" label="Reload from Disk" title="Discard edits and reload this pattern from disk" disabled={busy} onClick={() => { if (discard()) diskAction(async () => { await nodePatterns.reconnect(); load(await nodePatterns.load(current.id)); }); }} />}
        <button className="btn btn--solid btn--status-size nodes-save" title="Save pattern to the linked folder" disabled={busy} onClick={() => diskAction(async () => {
          const errors = sourceDiagnostics(graph, SKETCHES, dependencies); if (errors.length) throw new Error(errors.join('; '));
          const record = await nodePatterns.save(graph, dependencies, current);
          setCurrent(record); baseline.current = serializeGraph(graph, dependencies); updateRoute(record.id);
          setMessage('');
        })}>Save</button>
      </div>
    </header>
    {message && <div className="nodes-status" role="status">{message}</div>}
    <div className="nodes-layout" inert={busy}>
      <aside className="nodes-palette" aria-label="Pattern palette"><button className="btn" title="Add a Blend node" onClick={() => add()}>+ Blend</button><input className="control-input" aria-label="Search patterns" title="Filter available patterns" placeholder="Search patterns…" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="nodes-pattern-list">{SKETCHES.filter(s => !s.nodesGraph && `${s.name} ${s.group}`.toLowerCase().includes(query.toLowerCase())).map(s => <button className="btn" key={s.id} title={`Add ${s.name}; drag to position on the canvas`} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, patternId: s.id })); }} onClick={() => add(s.id)}><span>{s.name}</span><small>{s.group}{s.camera ? ' · Output camera' : ''}</small></button>)}</div>
      </aside>
      <section ref={navigation.workspace} {...selection.workspaceHandlers} className="nodes-workspace" aria-label="Graph workspace" tabIndex={0} onKeyDown={e => {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.key === 'Escape') { setPending(null); selection.cancel(); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
      }} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => {
        e.preventDefault(); const id = readPatternDrag(e.dataTransfer, SKETCHES);
        if (!id) { setMessage('Invalid pattern drag payload'); return; }
        const point = navigation.toGraph(e.clientX, e.clientY); add(id, point.x, point.y);
      }}>
        <div className="nodes-plane" style={{ transform: `translate(${navigation.view.x}px, ${navigation.view.y}px) scale(${navigation.view.zoom})`, width: Math.max(1000, ...graph.nodes.map(n => n.x + 220)), height: Math.max(850, ...graph.nodes.map(n => n.y + 180)) }}>
          <svg className="nodes-wires" aria-label="Connections">{graph.edges.map(e => {
            const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
            const x1 = a.x + 168, y1 = a.y + 49, x2 = b.x + 12, y2 = b.y + 49 + inputs(b).indexOf(e.port) * 32;
            return <path key={`${e.to}:${e.port}`} role="button" tabIndex={0} aria-label={`Disconnect ${label(a)} from ${label(b)} ${e.port}`} d={`M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Delete') { event.stopPropagation(); edit({ ...graph, edges: graph.edges.filter(w => w !== e) }); } }} />;
          })}</svg>
          {graph.nodes.map(n => <article key={n.id} className={`nodes-node ${selection.ids.includes(n.id) ? 'is-selected' : ''}`} data-node-id={n.id} data-primary={selected === n.id || undefined} style={{ left: n.x, top: n.y }} onClick={e => selection.nodeClick(n.id, e)}>
            <button className="nodes-node-title" title={`Select or drag ${label(n)}`} aria-label={`Select ${label(n)}`} aria-pressed={selection.ids.includes(n.id)} {...selection.titleHandlers(n)}>{label(n)}</button>
            <div className="nodes-ports">{inputs(n).map(name => <button key={name} className="nodes-input" title={`Connect to ${label(n)} ${name} input`} aria-label={`${n.id} input ${name}`} onClick={() => port(n.id, name)}>● {name}</button>)}
              {n.type !== 'output' && <button className={`nodes-output ${pending === n.id ? 'active' : ''}`} title={`Connect from ${label(n)} output`} aria-label={`${n.id} output`} onClick={() => { setPending(n.id); setMessage(''); }}>out ●</button>}
            </div><small className="nodes-node-detail">{n.type === 'blend' ? `${n.mode} · ${Math.round(n.opacity * 100)}%` : n.type === 'output' ? 'Final image' : n.patternId}</small>
          </article>)}
          {selection.box && <div className="nodes-selection-box" aria-hidden="true" style={{ left: selection.box.x, top: selection.box.y, width: selection.box.width, height: selection.box.height }} />}
        </div>
        <div className="nodes-zoom" role="toolbar" aria-label="Canvas zoom">
          <IconControl icon="zoomOut" label="Zoom out" disabled={navigation.view.zoom <= .25} onClick={() => navigation.zoomAt(1 / 1.2)} />
          <button className="btn" title="Reset canvas zoom and pan" aria-label="Reset canvas view" onClick={navigation.reset}>{Math.round(navigation.view.zoom * 100)}%</button>
          <IconControl icon="zoomIn" label="Zoom in" disabled={navigation.view.zoom >= 2.5} onClick={() => navigation.zoomAt(1.2)} />
        </div>
      </section>
      <aside className="nodes-inspector"><h2>{node ? label(node) : 'Preview'}</h2><Preview graph={graph} dependencies={dependencies} selected={selected} revision={revision} />
        {node?.type === 'blend' && <><label>Blend mode<Select aria-label="Blend mode" title="Choose pixel blend mode" value={node.mode} onChange={e => patch({ mode: e.target.value })}>{Object.keys(MODES).map(mode => <option key={mode}>{mode}</option>)}</Select></label><label>Opacity <output className="param-value">{Math.round(node.opacity * 100)}%</output><input className="control-range" aria-label="Opacity" title="Adjust Blend opacity" type="range" min="0" max="1" step="0.01" value={node.opacity} onChange={e => patch({ opacity: Number(e.target.value) })} /></label></>}
        {node?.type === 'pattern' && <>{!sketch && <p>Missing pattern. Delete and replace this node, or restore its dependency.</p>}{sketch?.params?.map(p => <ParameterControl key={`${node.id}:${p.key}`} scope="nodes" id={node.id} def={p} value={node.params[p.key] ?? p.default} onChange={value => patch({ params: { ...node.params, [p.key]: value } })} />)}</>}
        {node && graph.edges.filter(e => e.to === node.id).map(e => <button className="btn btn--sm" title={`Disconnect ${e.port} input`} key={e.port} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })}>Disconnect {e.port}</button>)}
        <button className="btn btn--danger" title="Delete selected node and its wires" disabled={!node || node.type === 'output'} onClick={remove}>Delete node</button>
        <details><summary>Dependencies & limits</summary><p>24 nodes, 8 leaf renderers, 1280×720 internal image. No recursive graphs. Camera capture stays on output. Local files and custom assets are not embedded.</p>{dependencies.map(d => <p key={d.id}>{d.name || d.id} · {d.kind}</p>)}<button className="btn" title="Refresh dependency fingerprints from available patterns" onClick={() => attempt(() => { setDraft({ ...draft, dependencies: manifestFor(graph, SKETCHES) }); setMessage('Dependency manifest refreshed explicitly. Save when ready.'); })}>Refresh dependencies</button></details>
      </aside>
    </div>
  </main>;
}
