import { Select } from '../components/control/Select.jsx';
import { useEffect, useRef, useState } from 'react';
import { SKETCHES } from '../sketch-registry.js';
import { MEDIA_STORAGE_KEY, registerMediaSketches } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY, registerProjectionSketches } from '../projection/projection-registry.js';
import { CustomScripts } from '../custom-scripts/service.js';
import { MODES, newGraph, validateGraph, connect, deleteNode, inputs, DRAG_TYPE, readPatternDrag } from './model.js';
import { GraphRuntime } from './runtime.js';
import { listGraphs, saveGraph, watchGraphs } from './repository.js';
import { manifestFor, sourceDiagnostics, exportGraph, importGraph } from './portability.js';
import './nodes.css';

const DRAFT = 'viz2_nodes_draft_v1';
function initialParams(sketch) {
  let bank = {};
  try { bank = JSON.parse(localStorage.getItem('viz2_params') || '{}')?.[sketch.id] || {}; } catch {}
  return Object.fromEntries((sketch.params || []).map(p => [p.key, Number.isFinite(bank[p.key]) && bank[p.key] >= p.min && bank[p.key] <= p.max ? bank[p.key] : p.default]));
}
function initialDraft() {
  try { return importGraph(sessionStorage.getItem(DRAFT) || ''); } catch { return { graph: newGraph(), dependencies: [] }; }
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
  const [draft, setDraft] = useState(initialDraft);
  const { graph, dependencies } = draft;
  const [selected, setSelected] = useState('output'), [pending, setPending] = useState(null);
  const [query, setQuery] = useState(''), [message, setMessage] = useState('Draft only — live output is unchanged.');
  const [library, setLibrary] = useState(listGraphs), [loadId, setLoadId] = useState(''), [revision, setRevision] = useState(0);
  const file = useRef(null), drag = useRef(null);
  const node = graph.nodes.find(n => n.id === selected);
  const sketch = SKETCHES.find(s => s.id === node?.patternId);
  const label = n => n.type === 'pattern' ? SKETCHES.find(s => s.id === n.patternId)?.name || n.patternId : n.type === 'blend' ? 'Blend' : 'Output';
  useEffect(() => {
    const refresh = () => { setRevision(v => v + 1); };
    const stop = watchGraphs(() => setLibrary(listGraphs()));
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
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT, exportGraph(graph, dependencies)); }
    catch (e) { setMessage(`Draft could not be stored: ${e.message}`); }
  }, [draft]);
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
      // Preserve imported dependency fingerprints until explicit refresh.
      setDraft({ graph: next, dependencies: fresh.map(d => dependencies.find(old => old.id === d.id) || d) });
      setSelected(n.id); setMessage(`Added ${label(n)}. Connect an output port to an input port.`);
    });
  }
  function port(to, name) {
    if (!pending) { setMessage('Choose an output port first, then an input port.'); return; }
    attempt(() => { edit(connect(graph, pending, to, name)); setPending(null); setMessage('Connected. Click a wire or Disconnect to remove it.'); });
  }
  const remove = () => { if (!node || node.type === 'output') return; edit(deleteNode(graph, selected)); setSelected('output'); setPending(null); };
  function load(record) { setDraft({ graph: structuredClone(record.graph), dependencies: structuredClone(record.dependencies || []) }); setSelected('output'); setPending(null); setMessage('Loaded as an isolated draft. Save creates a new revision.'); }
  return <main className="nodes-app">
    <header className="nodes-toolbar"><h1>Nodes <small>Pattern compositor</small></h1>
      <input className="control-input" aria-label="Graph name" value={graph.name} maxLength={80} onChange={e => setDraft({ ...draft, graph: { ...graph, name: e.target.value } })} />
      <button className="btn" onClick={() => { setDraft({ graph: newGraph(), dependencies: [] }); setSelected('output'); setPending(null); }}>New draft</button>
      <button className="btn btn--solid" onClick={() => attempt(() => {
        const errors = sourceDiagnostics(graph, SKETCHES, dependencies); if (errors.length) throw new Error(errors.join('; '));
        const record = saveGraph(graph, dependencies); setLoadId(record.id); setMessage(`Saved ${graph.name} · ${record.id.slice(-6)}. Select it in the main pattern library; live was not changed.`);
      })}>Save revision</button>
      <button className="btn" onClick={() => attempt(() => {
        const blob = new Blob([exportGraph(graph, dependencies)], { type: 'application/json' }), url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = 'node-graph.v1.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage('Exported graph + dependency manifest. Local media and custom assets are not embedded.');
      })}>Export JSON</button>
      <button className="btn" onClick={() => file.current.click()}>Import JSON</button>
      <input hidden ref={file} type="file" accept=".json,application/json" aria-label="Import graph file" onChange={async e => {
        const upload = e.target.files[0]; e.target.value = ''; if (!upload) return;
        try { if (upload.size > 200000) throw new Error('Import exceeds 200 KB'); const data = importGraph(await upload.text()); load(data); } catch (error) { setMessage(error.message); }
      }} />
      <a href="/docs/nodes.html" target="_blank" rel="noopener">Help ↗</a>
    </header>
    <div className="nodes-status" role="status">{message}</div>
    <div className="nodes-layout">
      <aside className="nodes-palette"><h2>Pattern palette</h2><input className="control-input" aria-label="Search patterns" placeholder="Search patterns…" value={query} onChange={e => setQuery(e.target.value)} />
        <p>Drag into the workspace or click to add.</p><button className="btn" onClick={() => add()}>+ Blend</button>
        <div className="nodes-pattern-list">{SKETCHES.filter(s => !s.nodesGraph && `${s.name} ${s.group}`.toLowerCase().includes(query.toLowerCase())).map(s => <button className="btn" key={s.id} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, patternId: s.id })); }} onClick={() => add(s.id)}><span>{s.name}</span><small>{s.group}{s.camera ? ' · Output camera' : ''}</small></button>)}</div>
        <h2>Shared library</h2><Select aria-label="Saved graph" value={loadId} onChange={e => setLoadId(e.target.value)}><option value="">Choose revision…</option>{library.map(r => <option key={r.id} value={r.id}>{r.graph.name} · {r.id.slice(-6)}</option>)}</Select>
        <button className="btn" disabled={!loadId} onClick={() => { const record = library.find(r => r.id === loadId); if (record) load(record); }}>Load draft</button>
      </aside>
      <section className="nodes-workspace" aria-label="Graph workspace" tabIndex={0} onKeyDown={e => {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.key === 'Escape') setPending(null);
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
      }} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => {
        e.preventDefault(); const id = readPatternDrag(e.dataTransfer, SKETCHES);
        if (!id) { setMessage('Invalid pattern drag payload'); return; }
        const rect = e.currentTarget.getBoundingClientRect(); add(id, e.clientX - rect.left + e.currentTarget.scrollLeft, e.clientY - rect.top + e.currentTarget.scrollTop);
      }}>
        <div className="nodes-plane" style={{ width: Math.max(1000, ...graph.nodes.map(n => n.x + 220)), height: Math.max(850, ...graph.nodes.map(n => n.y + 180)) }}>
          <svg className="nodes-wires" aria-label="Connections">{graph.edges.map(e => {
            const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
            const x1 = a.x + 188, y1 = a.y + 65, x2 = b.x + 12, y2 = b.y + 65 + inputs(b).indexOf(e.port) * 32;
            return <path key={`${e.to}:${e.port}`} role="button" tabIndex={0} aria-label={`Disconnect ${label(a)} from ${label(b)} ${e.port}`} d={`M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Delete') { event.stopPropagation(); edit({ ...graph, edges: graph.edges.filter(w => w !== e) }); } }} />;
          })}</svg>
          {graph.nodes.map(n => <article key={n.id} className={`nodes-node ${selected === n.id ? 'is-selected' : ''}`} data-node-id={n.id} style={{ left: n.x, top: n.y }} onClick={() => setSelected(n.id)}>
            <button className="nodes-node-title" aria-label={`Select ${label(n)}`} onPointerDown={e => { if (e.button !== 0) return; setSelected(n.id); drag.current = { id: n.id, x: e.clientX, y: e.clientY, ox: n.x, oy: n.y }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => {
              const d = drag.current; if (!d || d.id !== n.id) return;
              setDraft(prev => ({ ...prev, graph: { ...prev.graph, nodes: prev.graph.nodes.map(item => item.id === d.id ? { ...item, x: Math.max(0, Math.min(3800, d.ox + e.clientX - d.x)), y: Math.max(0, Math.min(3800, d.oy + e.clientY - d.y)) } : item) } }));
            }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={e => {
              const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
              if (delta) { e.preventDefault(); attempt(() => edit({ ...graph, nodes: graph.nodes.map(item => item.id === n.id ? { ...item, x: Math.max(0, Math.min(3800, item.x + delta[0])), y: Math.max(0, Math.min(3800, item.y + delta[1])) } : item) })); }
            }}><small>{n.type.toUpperCase()}</small>{label(n)}</button>
            <div className="nodes-ports">{inputs(n).map(name => <button key={name} className="nodes-input" aria-label={`${n.id} input ${name}`} onClick={() => port(n.id, name)}>● {name}</button>)}
              {n.type !== 'output' && <button className={`nodes-output ${pending === n.id ? 'active' : ''}`} aria-label={`${n.id} output`} onClick={() => { setPending(n.id); setMessage('Now click an input port. Escape cancels.'); }}>out ●</button>}
            </div><small className="nodes-node-detail">{n.type === 'blend' ? `${n.mode} · ${Math.round(n.opacity * 100)}%` : n.type === 'output' ? 'Final image' : n.patternId}</small>
          </article>)}
        </div>
      </section>
      <aside className="nodes-inspector"><h2>{node ? label(node) : 'Preview'}</h2><Preview graph={graph} dependencies={dependencies} selected={selected} revision={revision} />
        <p>Selected node · live preview · draft only</p>
        {node?.type === 'blend' && <><label>Blend mode<Select aria-label="Blend mode" value={node.mode} onChange={e => patch({ mode: e.target.value })}>{Object.keys(MODES).map(mode => <option key={mode}>{mode}</option>)}</Select></label><label>Opacity <output className="param-value">{Math.round(node.opacity * 100)}%</output><input className="control-range" aria-label="Opacity" type="range" min="0" max="1" step="0.01" value={node.opacity} onChange={e => patch({ opacity: Number(e.target.value) })} /></label></>}
        {node?.type === 'pattern' && <>{!sketch && <p>Missing pattern. Delete and replace this node, or restore its dependency.</p>}{sketch?.params?.map(p => <label key={p.key}>{p.label}<input className="control-input" aria-label={p.label} type="number" min={p.min} max={p.max} step={p.step || 'any'} value={node.params[p.key] ?? p.default} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= p.min && value <= p.max) patch({ params: { ...node.params, [p.key]: value } }); }} /></label>)}</>}
        {node && graph.edges.filter(e => e.to === node.id).map(e => <button className="btn btn--sm" key={e.port} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })}>Disconnect {e.port}</button>)}
        <button className="btn btn--danger" disabled={!node || node.type === 'output'} onClick={remove}>Delete node</button>
        <details><summary>Dependencies & limits</summary><p>24 nodes, 8 leaf renderers, 1280×720 internal image. No recursive graphs. Camera capture stays on output. Local files and custom assets are not embedded.</p>{dependencies.map(d => <p key={d.id}>{d.name || d.id} · {d.kind}</p>)}<button className="btn" onClick={() => attempt(() => { setDraft({ ...draft, dependencies: manifestFor(graph, SKETCHES) }); setMessage('Dependency manifest refreshed explicitly. Save a new revision when ready.'); })}>Refresh dependencies</button></details>
      </aside>
    </div>
  </main>;
}
