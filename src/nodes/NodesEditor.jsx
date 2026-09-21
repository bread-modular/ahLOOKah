import { IconControl } from '../components/control/IconControl.jsx';
import { ModulatedParameter } from './ModulatedParameter.jsx';
import { BANDS, definitions, numeric, clampStep, SIGNAL_DRAG } from './modulation.js';
import { createEditorAudio } from './audio-provider.js';
import { useCanvasNavigation } from './useCanvasNavigation.js';
import { useNodeSelection } from './useNodeSelection.js';
import { nodeEditorUrl } from './routes.js';
import { Select } from '../components/control/Select.jsx';
import { useEffect, useRef, useState } from 'react';
import { SKETCHES } from '../sketch-registry.js';
import { MEDIA_STORAGE_KEY, registerMediaSketches } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY, registerProjectionSketches } from '../projection/projection-registry.js';
import { CustomScripts } from '../custom-scripts/service.js';
import { MODES, newGraph, validateGraph, connect, deleteNodes, inputs, DRAG_TYPE, readPatternDrag, connectSignal, mapSignal } from './model.js';
import { GraphRuntime } from './runtime.js';
import { nodePatterns, watchGraphs } from './repository.js';
import { manifestFor, sourceDiagnostics, serializeGraph } from './portability.js';
import './nodes.css';

function initialParams(sketch) {
  let bank = {};
  try { bank = JSON.parse(localStorage.getItem('viz2_params') || '{}')?.[sketch.id] || {}; } catch {}
  return Object.fromEntries((sketch.params || []).map(p => [p.key, Number.isFinite(bank[p.key]) && bank[p.key] >= p.min && bank[p.key] <= p.max ? bank[p.key] : p.default]));
}
function Preview({ graph, dependencies, selected, revision, current }) {
  const canvas = useRef(null), target = useRef(selected);
  const [messages, setMessages] = useState([]);
  target.current = selected;
  // Moving nodes/renaming does not destroy GPU sources or restart videos.
  const content = JSON.stringify({ ...graph, name: 'preview', nodes: graph.nodes.map(({ x, y, ...n }) => ({ ...n, x: 0, y: 0 })) });
  const manifest = JSON.stringify(dependencies);
  const provider = useRef(null);
  useEffect(() => { provider.current = createEditorAudio(); return () => { provider.current.dispose(); provider.current = null; }; }, []);
  useEffect(() => {
    const audioProvider = provider.current;
    let runtime, frame, oldMessage = '';
    try {
      const children = [];
      runtime = new GraphRuntime({ graph: JSON.parse(content), dependencies: JSON.parse(manifest), sketches: SKETCHES,
        audio: audioProvider.audio,
        context: { audioControlStore: audioProvider.store, onAudioSlotsChanged: audioProvider.refresh, registerChildRuntime: child => children.push(child) } });
      audioProvider.setChildren(children);
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
    return () => { cancelAnimationFrame(frame); runtime?.dispose(); audioProvider.setChildren([]); current.current = null; };
  }, [content, manifest, revision]);
  return <><canvas ref={canvas} width="480" height="270" aria-label="Selected node live preview" data-testid="node-preview" /><div role="status" className="nodes-diagnostics">{messages.map((m, i) => <p key={i}>{m}</p>)}</div></>;
}
export function NodesEditor() {
  const [draft, setDraft] = useState(() => ({ graph: newGraph(), dependencies: [] }));
  const { graph, dependencies } = draft;
  const previewRuntime = useRef(null);
  const [pending, setPending] = useState(null);
  const [signalEndpoint, setSignalEndpoint] = useState(null);
  const [targetParam, setTargetParam] = useState('');
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
  const label = n => n.type === 'pattern' ? SKETCHES.find(s => s.id === n.patternId)?.name || n.patternId : n.type === 'blend' ? 'Blend' : n.type === 'audio' ? `Audio · ${n.band}` : 'Output';
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
  const edit = next => { const clean = validateGraph(next); setDraft(d => ({ ...d, graph: clean })); };
  const patch = values => attempt(() => edit({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...values } : n) }));
  function add(patternId = null, x = 70, y = 60 + graph.nodes.length * 35) {
    attempt(() => {
      const s = SKETCHES.find(s => s.id === patternId);
      if (patternId && (!s || s.nodesGraph)) throw new Error('Choose a non-graph source; recursive graphs are not supported');
      const n = { id: `n${crypto.randomUUID().slice(0, 8)}`, type: patternId ? 'pattern' : 'blend', x, y,
        ...(patternId ? { patternId, params: initialParams(s) } : { mode: 'Normal', opacity: 1 }) };
      const next = validateGraph({ ...graph, nodes: [...graph.nodes, n] });
      const fresh = manifestFor(next, SKETCHES);
      // Preserve opened dependency fingerprints until explicit refresh.
      setDraft({ graph: next, dependencies: fresh.map(d => dependencies.find(old => old.id === d.id) || d) });
      setSelected(n.id); setMessage('');
    });
  }
  const selectSignal = (from, to) => { setSelected(to); setSignalEndpoint({ from, to }); setTargetParam(''); };
  function audioPort(to) {
    if (graph.nodes.find(n => n.id === pending)?.type !== 'audio') { setMessage('Choose an Audio output first, then a signal endpoint.'); return; }
    attempt(() => { edit(connectSignal(graph, pending, to)); selectSignal(pending, to); setPending(null); setMessage('Choose a numeric target below, or drag its signal onto a slider.'); });
  }
  function assignSignal(from, def) {
    if (!numeric(def)) { setMessage('Unsupported: only numeric sliders can map; enum, bool and text cannot.'); return; }
    if (!(graph.modulations || []).some(m => m.from === from && m.to === node.id)) { setMessage('Connect this Audio signal to the target node first.'); return; }
    const existing = (graph.modulations || []).find(m => m.to === node.id && m.param === def.key);
    if (existing && !window.confirm(`Replace the existing ${def.label} mapping?`)) return;
    const base = clampStep(node.type === 'blend' ? node.opacity : node.params[def.key] ?? def.default, def);
    attempt(() => edit(mapSignal(graph, from, node.id, def.key, base, base < def.max ? clampStep(base + (def.max - def.min) * .25, def) : def.min, true)));
  }
  function port(to, name) {
    if (!pending) { setMessage('Choose an output port first, then an input port.'); return; }
    attempt(() => { edit(connect(graph, pending, to, name)); setPending(null); setMessage(''); });
  }
  const removable = graph.nodes.filter(n => n.type !== 'output' && selection.ids.includes(n.id));
  const remove = () => {
    const protectsOutput = graph.nodes.some(n => n.type === 'output' && selection.ids.includes(n.id));
    if (removable.length) {
      setDraft(d => ({ ...d, graph: deleteNodes(d.graph, selection.ids) }));
      setSelected(graph.nodes.find(n => n.type === 'output').id);
      setPending(null); setSignalEndpoint(null); setTargetParam('');
    }
    setMessage(protectsOutput ? (removable.length ? 'Output is required and was kept. Other selected nodes and their connections were deleted.' : 'Output is required and cannot be deleted.') : '');
  };
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
  return <main className="nodes-app" onKeyDown={e => {
    if (busy || e.target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
    if (e.key === 'Escape') { setPending(null); selection.cancel(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
  }}>
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
      <aside className="nodes-palette" aria-label="Pattern palette"><button className="btn" title="Add a Blend node" onClick={() => add()}>+ Blend</button><button className="btn" onClick={() => attempt(() => {
        const n = { id: `n${crypto.randomUUID().slice(0, 8)}`, type: 'audio', band: 'bass', x: 300, y: 60 + graph.nodes.length * 35 };
        edit({ ...graph, nodes: [...graph.nodes, n] }); setSelected(n.id);
      })}>+ Audio</button><input className="control-input" aria-label="Search patterns" title="Filter available patterns" placeholder="Search patterns…" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="nodes-pattern-list">{SKETCHES.filter(s => !s.nodesGraph && `${s.name} ${s.group}`.toLowerCase().includes(query.toLowerCase())).map(s => <button className="btn" key={s.id} title={`Drag ${s.name} onto the canvas to create a node`} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, patternId: s.id })); }}><span>{s.name}</span><small>{s.group}{s.camera ? ' · Output camera' : ''}</small></button>)}</div>
      </aside>
      <section ref={navigation.workspace} {...selection.workspaceHandlers} className="nodes-workspace" aria-label="Graph workspace" tabIndex={0} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => {
        e.preventDefault(); const id = readPatternDrag(e.dataTransfer, SKETCHES);
        if (!id) { setMessage('Invalid pattern drag payload'); return; }
        const point = navigation.toGraph(e.clientX, e.clientY); add(id, point.x, point.y);
      }}>
        <div className="nodes-plane" style={{ transform: `translate(${navigation.view.x}px, ${navigation.view.y}px) scale(${navigation.view.zoom})`, width: Math.max(1000, ...graph.nodes.map(n => n.x + 220)), height: Math.max(850, ...graph.nodes.map(n => n.y + 180)) }}>
          <svg className="nodes-wires" aria-label="Connections">{graph.edges.map(e => {
            const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
            const x1 = a.x + 168, y1 = a.y + 49, x2 = b.x + 12, y2 = b.y + 49 + inputs(b).indexOf(e.port) * 32;
            return <path key={`${e.to}:${e.port}`} role="button" tabIndex={0} aria-label={`Disconnect ${label(a)} from ${label(b)} ${e.port}`} d={`M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); edit({ ...graph, edges: graph.edges.filter(w => w !== e) }); } }} />;
          })}{(graph.modulations || []).map((m, i) => {
            const a = graph.nodes.find(n => n.id === m.from), b = graph.nodes.find(n => n.id === m.to);
            const x = b.x + 12, y = b.y + (b.type === 'blend' ? 131 : 99);
            return <g key={`signal-${i}`}><path className="nodes-signal-wire" role="button" tabIndex={0} aria-label={`Select signal ${a.band} to ${label(b)} ${m.param || 'unassigned'}`} d={`M ${a.x + 168} ${a.y + 49} C ${a.x + 240} ${a.y + 49}, ${x - 70} ${y}, ${x} ${y}`} onClick={() => selectSignal(m.from, m.to)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSignal(m.from, m.to); } }} /></g>;
          })}</svg>
          {graph.nodes.map(n => <article key={n.id} className={`nodes-node ${selection.ids.includes(n.id) ? 'is-selected' : ''}`} data-node-id={n.id} data-primary={selected === n.id || undefined} style={{ left: n.x, top: n.y }} onClick={e => selection.nodeClick(n.id, e)}>
            <button className="nodes-node-title" title={`Select or drag ${label(n)}`} aria-label={`Select ${label(n)}`} aria-pressed={selection.ids.includes(n.id)} {...selection.titleHandlers(n)}>{label(n)}</button>
            <div className="nodes-ports">{inputs(n).map(name => <button key={name} className="nodes-input" title={`Connect to ${label(n)} ${name} input`} aria-label={`${n.id} input ${name}`} onClick={() => port(n.id, name)}>● {name}</button>)}
              {n.type !== 'output' && <button className={`nodes-output ${pending === n.id ? 'active' : ''}`} title={`Connect from ${label(n)} output`} aria-label={`${n.id} output`} onClick={() => { setPending(n.id); setMessage(''); }}>out ●</button>}
            </div><small className="nodes-node-detail">{n.type === 'blend' ? `${n.mode} · ${Math.round(n.opacity * 100)}%` : n.type === 'output' ? 'Final image' : n.type === 'audio' ? `${n.band} activity · 0…1` : n.patternId}</small>
            {['pattern', 'blend'].includes(n.type) && <button className="nodes-signal-endpoint" aria-label={`${n.id} signal endpoint`} onClick={e => {
              e.stopPropagation();
              if (pending) audioPort(n.id);
              else { const m = (graph.modulations || []).find(m => m.to === n.id); if (m) selectSignal(m.from, n.id); else { setSelected(n.id); setMessage('Choose an Audio output first.'); } }
            }}>◇ signal {(graph.modulations || []).filter(m => m.to === n.id).length || ''}</button>}
          </article>)}
          {selection.box && <div className="nodes-selection-box" aria-hidden="true" style={{ left: selection.box.x, top: selection.box.y, width: selection.box.width, height: selection.box.height }} />}
        </div>
        <div className="nodes-zoom" role="toolbar" aria-label="Canvas zoom">
          <IconControl icon="zoomOut" label="Zoom out" disabled={navigation.view.zoom <= .25} onClick={() => navigation.zoomAt(1 / 1.2)} />
          <button className="btn" title="Reset canvas zoom and pan" aria-label="Reset canvas view" onClick={navigation.reset}>{Math.round(navigation.view.zoom * 100)}%</button>
          <IconControl icon="zoomIn" label="Zoom in" disabled={navigation.view.zoom >= 2.5} onClick={() => navigation.zoomAt(1.2)} />
        </div>
      </section>
      <aside className="nodes-inspector"><h2>{node ? label(node) : 'Preview'}</h2><Preview graph={graph} dependencies={dependencies} selected={selected} revision={revision} current={previewRuntime} />
        {node?.type === 'audio' && <><label>Audio band<Select aria-label="Audio band" value={node.band} onChange={e => patch({ band: e.target.value })}>{BANDS.map(b => <option key={b}>{b}</option>)}</Select></label><p>Normalized custom-script activity (0…1). Uses the main window’s shared audio input; no input means zero. Connect out to one or many ◇ signal endpoints.</p></>}
        {node?.type === 'output' && <p>Output has no numeric controls. Audio mapping is not supported here.</p>}
        {node?.type === 'blend' && <label>Blend mode<Select aria-label="Blend mode" title="Choose pixel blend mode" value={node.mode} onChange={e => patch({ mode: e.target.value })}>{Object.keys(MODES).map(mode => <option key={mode}>{mode}</option>)}</Select></label>}
        {node?.type === 'pattern' && !sketch && <p>Missing pattern. Delete and replace this node, or restore its dependency.</p>}
        {node && (graph.modulations || []).some(m => m.to === node.id) && <section className="nodes-signals" aria-label="Connected signals"><h2>Connected signals</h2>
          {[...new Set(graph.modulations.filter(m => m.to === node.id).map(m => m.from))].map(from => <button key={from} className={`btn nodes-signal-chip ${signalEndpoint?.from === from && signalEndpoint?.to === node.id ? 'active' : ''}`} draggable onDragStart={e => e.dataTransfer.setData(SIGNAL_DRAG, from)} onClick={() => selectSignal(from, node.id)}>{label(graph.nodes.find(n => n.id === from))} · drag to slider</button>)}
          {signalEndpoint?.to === node.id && graph.modulations.some(m => m.from === signalEndpoint.from && m.to === node.id) && <>
            <label>Target parameter<Select aria-label="Target parameter" value={targetParam} onChange={e => setTargetParam(e.target.value)}><option value="">Choose numeric slider…</option>{definitions(node, SKETCHES).map(d => <option key={d.key} value={d.key} disabled={!numeric(d)}>{d.label}{numeric(d) ? '' : ' (unsupported)'}</option>)}</Select></label>
            <button className="btn" disabled={!targetParam} onClick={() => assignSignal(signalEndpoint.from, definitions(node, SKETCHES).find(d => d.key === targetParam))}>Map / replace parameter</button>
            <button className="btn btn--sm" onClick={() => edit({ ...graph, modulations: graph.modulations.filter(m => m.from !== signalEndpoint.from || m.to !== node.id) })}>Disconnect signal</button>
          </>}
          <p>Numeric sliders only; enums, bool and text are unsupported. Base stays unchanged. Mapping min = signal 0, max = signal 1; reversed ranges are allowed.</p>
        </section>}
        {node && definitions(node, SKETCHES).map(def => {
          const mapping = (graph.modulations || []).find(m => m.to === node.id && m.param === def.key);
          return <ModulatedParameter key={`${node.id}:${def.key}`} node={node} def={def} value={node.type === 'blend' ? node.opacity : node.params[def.key] ?? def.default}
            onChange={value => node.type === 'blend' ? patch({ opacity: value }) : patch({ params: { ...node.params, [def.key]: value } })}
            readEffective={() => previewRuntime.current?.params.get(node.id)?.[def.key]} mapping={mapping} onMap={assignSignal} onRange={(min, max) => edit(mapSignal(graph, mapping.from, node.id, def.key, min, max, true))}
            onRemove={() => edit({ ...graph, modulations: graph.modulations.filter(m => m !== mapping) })} />;
        })}
        {node && graph.edges.filter(e => e.to === node.id).map(e => <button className="btn btn--sm" title={`Disconnect ${e.port} input`} key={e.port} onClick={() => edit({ ...graph, edges: graph.edges.filter(w => w !== e) })}>Disconnect {e.port}</button>)}
        <button className="btn btn--danger" title="Delete all selected nodes and their connections; required Output is kept" disabled={!removable.length} onClick={remove}>Delete node</button>
        <details><summary>Dependencies & limits</summary><p>24 nodes, 8 leaf renderers, 1280×720 internal image. No recursive graphs. Camera capture stays on output. Local files and custom assets are not embedded.</p>{dependencies.map(d => <p key={d.id}>{d.name || d.id} · {d.kind}</p>)}<button className="btn" title="Refresh dependency fingerprints from available patterns" onClick={() => attempt(() => { setDraft({ ...draft, dependencies: manifestFor(graph, SKETCHES) }); setMessage('Dependency manifest refreshed explicitly. Save when ready.'); })}>Refresh dependencies</button></details>
      </aside>
    </div>
  </main>;
}
