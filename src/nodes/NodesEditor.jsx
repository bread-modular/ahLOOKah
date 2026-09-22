import { RuntimeContext } from '../app/RuntimeContext.jsx';
import { IconControl } from '../components/control/IconControl.jsx';
import { ModulatedParameter } from './ModulatedParameter.jsx';
import { BANDS, definitions, numeric, clampStep, SIGNAL_DRAG } from './modulation.js';
import { AUDIO_CHANNEL_LABELS } from '../audio-routing.js';
import { MATH_OPS, MATH_LABELS, MATH_INPUTS, MATH_PORT_LABELS, SCRIPT_INPUTS, SCRIPT_PORT_LABELS, SCRIPT_LITERAL_FIELDS, SIGNAL_TYPES, defaultNode, isSignalSource, isVisualSource, isScalarConsumer, isModulationTarget, activeInputs, mathPorts } from './definitions.js';
import { inputAnchor, outputAnchor, signalAnchor, wirePath, BUNDLE_BOW } from './geometry.js';
import { SCRIPT_VARIABLES, compileScript, helpForLanguage, limitForLanguage, scriptLanguageLabel } from './script.js';
import { approveScript, isScriptApproved } from './script-approval.js';
import { scriptLanguageOf as scriptNodeLanguage } from './scalar.js';
import { createEditorAudio } from './audio-provider.js';
import { useCanvasNavigation } from './useCanvasNavigation.js';
import { useNodeSelection } from './useNodeSelection.js';
import { nodeEditorUrl } from './routes.js';
import { Select } from '../components/control/Select.jsx';
import { useContext, useEffect, useRef, useState } from 'react';
import { SKETCHES } from '../sketch-registry.js';
import { MEDIA_STORAGE_KEY, registerMediaSketches } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY, registerProjectionSketches } from '../projection/projection-registry.js';
import { CustomScripts } from '../custom-scripts/service.js';
import { MODES, newGraph, validateGraph, connect, deleteNodes, connectionRef, findConnection, removeConnection, DRAG_TYPE, readPaletteDrag, connectSignal, connectSignalEdge, mapSignal, mapSignalInput } from './model.js';
import { GraphRuntime } from './runtime.js';
import { nodePatterns, watchGraphs } from './repository.js';
import { graphDiagnostics, manifestFor, pruneManifest, serializeGraph } from './portability.js';
import { confirmDiscard } from './leave-guard.js';
import './nodes.css';

// The editor is hosted in the control window (one session at a time) or at the
// legacy standalone `?role=nodes` route. Both return to the main app view in the
// same browser window; no new window, tab rail or draft list is involved.
function BackToMain({ onBack, busy }) {
  const label = <><span aria-hidden="true">← </span>Back to Main</>;
  if (onBack) return <button className="btn btn--status-size nodes-back" type="button" title="Return to the main app view" disabled={busy} onClick={onBack}>{label}</button>;
  return <a className="btn btn--status-size nodes-back" href="/" title="Return to the main app view">{label}</a>;
}

function initialParams(sketch) {
  let bank = {};
  try { bank = JSON.parse(localStorage.getItem('viz2_params') || '{}')?.[sketch.id] || {}; } catch {}
  return Object.fromEntries((sketch.params || []).map(p => [p.key, Number.isFinite(bank[p.key]) && bank[p.key] >= p.min && bank[p.key] <= p.max ? bank[p.key] : p.default]));
}
function labelFor(n) {
  return n.type === 'pattern' ? SKETCHES.find(s => s.id === n.patternId)?.name || n.patternId
    : n.type === 'blend' ? 'Blend' : n.type === 'audio' ? `Audio · ${n.band}` : n.type === 'color' ? 'Color'
      : n.type === 'math' ? `Math · ${n.op || 'add'}` : n.type === 'script' ? 'Script' : 'Output';
}
// Presentation-only level read straight from SIGNAL_TYPES (the single source of
// truth already shared by the model and runtime): violet for signal-level
// sources (Audio/Math/Script), cool blue-gray for image-level nodes
// (Pattern/Blend/Color/Output, i.e. everything else). The palette buttons, the
// canvas cards and the inspector header tint from this one classifier so the two
// classes always read the same; the graph itself never stores a level.
const levelOf = type => SIGNAL_TYPES.includes(type) ? 'signal' : 'image';
// One description for a connection, shared by the wire itself and the sidebar
// panel that explains what Delete/Backspace will remove.
export function describeConnection(graph, ref, link) {
  const name = id => labelFor(graph.nodes.find(node => node.id === id) || { id, type: 'missing' });
  if (ref.kind === 'image') return `${name(link.from)} → ${name(link.to)} ${link.port} (image)`;
  if (ref.kind === 'signal') return `${name(link.from)} → ${name(link.to)} ${link.port} (scalar)`;
  return `${name(link.from)} → ${name(link.to)} ${link.param || 'unmapped'} (modulation)`;
}
const sameConnection = (a, b) => !!a && !!b && a.kind === b.kind && a.key === b.key;
// Structural palette items are drag-only, exactly like Pattern sources: dropping
// one on the workspace creates the node at the drop point. There is no click-to-add.
const CREATE_NODES = [
  { type: 'blend', label: '+ Blend', title: 'Drag Blend onto the canvas to create a node' },
  { type: 'color', label: '+ Color', title: 'Drag Color onto the canvas to create a node (saturation, brightness, contrast, hue shift)' },
  { type: 'script', label: '+ Script', title: 'Drag Script onto the canvas to create a node (restricted scalar expression and compiled body)' },
  { type: 'audio', label: '+ Audio', title: 'Drag Audio onto the canvas to create a node (bass, mid or high activity)' },
];
// Every wire — image, scalar and modulation — is drawn from the same geometry and
// is activated the same way: activating selects only the connection, it never
// deletes a wire and never selects its endpoint nodes.
function Wire({ kind, link, from, to, bow = 0, description, selected, onSelect }) {
  const classes = [kind === 'image' ? null : 'nodes-signal-wire', selected ? 'is-selected' : null].filter(Boolean).join(' ');
  const activate = e => { e.preventDefault(); e.stopPropagation(); onSelect(kind, link); };
  return <path className={classes || undefined} role="button" tabIndex={0} aria-pressed={selected}
    data-connection={`${kind}:${connectionRef(kind, link).key}`} data-connection-from={link.from}
    aria-label={`Select connection ${description}`} title={description}
    d={wirePath(from, to, bow)} onClick={activate} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') activate(e); }} />;
}
function LiveReadout(runtime, nodeId, select) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    let frame;
    const update = () => { setValue(runtime.current?.[select]?.(nodeId)); frame = requestAnimationFrame(update); };
    update();
    return () => cancelAnimationFrame(frame);
  }, [runtime, nodeId, select]);
  return value;
}
// Live once-per-frame scalar value of the selected Math/Script node. Reads the
// same memoized frame values the renderers consume.
function SignalReadout({ runtime, nodeId }) {
  const value = LiveReadout(runtime, nodeId, 'signalValue');
  return <output className="nodes-signal-readout" data-testid="node-signal-readout" aria-label="Signal output value">{Number.isFinite(value) ? `Output ${value.toFixed(3)}` : 'Output —'}</output>;
}
// Requested-vs-actual input status for the selected Audio node: truthy text with
// a polite live region for transitions, never a color-only or per-tick signal.
function AudioRouteStatus({ runtime, nodeId, channelNote }) {
  const status = LiveReadout(runtime, nodeId, 'getNodeStatus');
  const source = status?.source || null;
  const running = source?.status === 'running';
  const text = !status ? 'Audio status unavailable.'
    : source?.status === 'unselected' ? 'No input selected in Settings — output is zero.'
    : source?.status === 'permission-denied' ? 'Microphone access denied. Initialize the mic in Settings in the control window.'
    : source?.status === 'permission-required' ? 'Enable microphone access in Settings in the control window.'
    : source?.status === 'missing' ? 'Pinned input not found — output stays zero. Reconnect it or pick another input.'
    : source?.status === 'resource-limit' ? 'Input limit reached (4 inputs) — output stays zero until another source is released.'
    : source?.status === 'unavailable' ? 'Input cannot be opened — output stays zero; other inputs keep running.'
    : source?.status === 'starting' ? 'Starting input…'
    : source?.status === 'suspended' ? 'Input suspended — click the control window to resume audio.'
    : source?.status === 'muted' ? 'Input muted — output stays zero.'
    : running && source?.fallback ? 'Global fallback: the selected input was replaced by another available input.'
    : running ? 'Input active.'
    : 'Waiting for a compatible audio owner.';
  const calibration = running && (source?.calibration === 'uncalibrated-channel' || source?.calibration === 'uncalibrated-device')
    ? ' This input runs without a matching noise calibration.'
    : '';
  return <output className="nodes-audio-status" data-testid="node-audio-status" aria-live="polite">{text}{calibration}{running && channelNote ? ` ${channelNote}` : ''}</output>;
}
function Preview({ graph, dependencies, selected, revision, current, sharedRuntime, audioProvider, providerReady, visible = true }) {
  const canvas = useRef(null), target = useRef(selected);
  const [messages, setMessages] = useState([]);
  target.current = selected;
  // Moving nodes/renaming does not destroy GPU sources or restart videos.
  const content = JSON.stringify({ ...graph, name: 'preview', nodes: graph.nodes.map(({ x, y, ...n }) => ({ ...n, x: 0, y: 0 })) });
  const manifest = JSON.stringify(dependencies);
  useEffect(() => {
    // The provider lives above the Preview/inspector split; wait for it.
    if (!providerReady || !audioProvider?.current) return undefined;
    const audioProviderInstance = audioProvider.current;
    let runtime, frame, oldMessage = '';
    try {
      const children = [];
      runtime = new GraphRuntime({ graph: JSON.parse(content), dependencies: JSON.parse(manifest), sketches: SKETCHES,
        audio: audioProviderInstance.audio,
        context: { audioControlStore: audioProviderInstance.store, onAudioSlotsChanged: audioProviderInstance.refresh, registerChildRuntime: child => children.push(child) } });
      audioProviderInstance.setChildren(children);
      current.current = runtime;
      const render = () => {
        const image = runtime.render(target.current || undefined);
        // The canvas is unmounted for scalar selections (audio/script), but the
        // runtime must keep ticking so signal readouts and mappings stay live.
        if (canvas.current) {
          const ctx = canvas.current.getContext('2d'); ctx.clearRect(0, 0, 480, 270);
          if (image) ctx.drawImage(image, 0, 0, 480, 270);
        }
        const diagnostics = runtime.getDiagnostics(); const text = diagnostics.join('\n');
        if (text !== oldMessage) { oldMessage = text; setMessages(diagnostics); }
        frame = requestAnimationFrame(render);
      };
      setMessages([]); render();
    } catch (e) { setMessages([e.message]); }
    return () => { cancelAnimationFrame(frame); runtime?.dispose(); audioProviderInstance.setChildren([]); current.current = null; };
  }, [content, manifest, revision, providerReady]);
  // Audio and Script are scalar sources with no image to show, so their
  // inspector omits the preview window entirely; the runtime stays mounted.
  if (!visible) return null;
  return <><canvas ref={canvas} width="480" height="270" aria-label="Selected node live preview" data-testid="node-preview" /><div role="status" className="nodes-diagnostics">{messages.map((m, i) => <p key={i}>{m}</p>)}</div></>;
}
export function NodesEditor({ graphId, sharedRuntime, onState, onSaved, onBack }) {
  const mainContext = useContext(RuntimeContext);
  const [draft, setDraft] = useState(() => ({ graph: newGraph(), dependencies: [] }));
  const { graph, dependencies } = draft;
  const previewRuntime = useRef(null);
  const [pending, setPending] = useState(null);
  const [signalEndpoint, setSignalEndpoint] = useState(null);
  const [query, setQuery] = useState(''), [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [scriptDraft, setScriptDraft] = useState({ id: null, language: null, text: '' });
  const [routeId, setRouteId] = useState(() => graphId !== undefined ? graphId : new URLSearchParams(location.search).get('graph'));
  const [loadState, setLoadState] = useState('loading');
  const navigation = useCanvasNavigation(loadState === 'ready');
  const selection = useNodeSelection(graph, setDraft, navigation);
  const selected = selection.primary;
  const setSelected = selection.reset;
  const [current, setCurrent] = useState(null), [busy, setBusy] = useState(false);
  const [diskError, setDiskError] = useState('');
  // One editor audio provider above the Preview/inspector split: the preview
  // runtime and the inspector share it, so status/catalog state is visible for
  // scalar selections too and no second channel/capture is ever created.
  const audioProvider = useRef(null);
  const [providerReady, setProviderReady] = useState(false);
  const [inputsSnapshot, setInputsSnapshot] = useState(null);
  useEffect(() => {
    const provider = sharedRuntime ? sharedRuntime.createEditorAudio() : createEditorAudio();
    audioProvider.current = provider;
    const unsubscribe = provider.subscribeInputs?.(snapshot => setInputsSnapshot(snapshot)) || null;
    setProviderReady(true);
    return () => { unsubscribe?.(); setProviderReady(false); provider.dispose(); audioProvider.current = null; };
  }, []);
  const inputOptions = Array.isArray(inputsSnapshot?.inputs) ? inputsSnapshot.inputs : [];
  const deviceLabel = deviceId => {
    if (!deviceId) return 'Global';
    const found = inputOptions.find(d => d.deviceId === deviceId);
    return found ? (found.label || 'Audio input') : 'Unavailable input';
  };
  const channelNoteFor = nodeId => {
    const status = previewRuntime.current?.getNodeStatus?.(nodeId);
    const channels = status?.source?.channels;
    return Number.isFinite(channels) && channels <= 1 ? '1-channel input; Left and Right use the same signal.' : '';
  };
  const globalActiveLabel = inputsSnapshot?.globalActiveId
    ? (inputOptions.find(d => d.deviceId === inputsSnapshot.globalActiveId)?.label || null) : null;
  const baseline = useRef(serializeGraph(newGraph(), []));
  const dirty = () => serializeGraph(graph, dependencies) !== baseline.current;
  // Both guards are consulted by every abandon path (Back to Main, Reload from
  // Disk): unapplied script text is invisible to `dirty`, so it needs its own
  // confirmation instead of being dropped silently.
  const discard = () => (!unappliedScript() || window.confirm('Discard unapplied script text?')) && (!dirty() || confirmDiscard());
  // Shared guard: Back to Main and Reload from Disk abandon the same draft.
  const leave = () => { if (discard()) onBack?.(); };
  const diskAction = async fn => {
    if (busy) return;
    setBusy(true); setDiskError('');
    try { await fn(); }
    catch (e) {
      // Cancel is an operator decision; anything else is a real failure and must
      // be visible, not only recorded in the workspace's data-status attribute.
      if (e.name === 'AbortError') setMessage('Canceled. Draft retained.');
      else { setMessage(e.message); setDiskError(e.message); }
    }
    finally { setBusy(false); }
  };
  const node = graph.nodes.find(n => n.id === selected);
  const sketch = SKETCHES.find(s => s.id === node?.patternId);
  const label = labelFor;
  // A mapping's source badge is resolved live from the graph on every render, so
  // a band change, a remap or any other node edit is reflected immediately and no
  // stale label is ever stored on the mapping itself.
  const signalSourceName = id => { const source = graph.nodes.find(n => n.id === id); return source ? labelFor(source) : `Missing ${id}`; };
  // The sidebar describes the selected connection's target even though the node
  // itself stays unselected, so its signal chips and mapping settings remain
  // reachable without making the node a Delete target.
  const signalNode = node || (selection.wire?.kind === 'modulation' && signalEndpoint ? graph.nodes.find(n => n.id === signalEndpoint.to) : null) || null;
  // Script sources are edited as a draft (text + language) and only enter the
  // graph through Apply, which also approves that exact source for this browser.
  const scriptNode = node?.type === 'script' ? node : null;
  const nodeLanguage = scriptNode ? scriptNodeLanguage(scriptNode) : 'expression';
  const drafting = !!scriptNode && scriptDraft.id === scriptNode.id;
  const scriptLanguage = drafting && scriptDraft.language ? scriptDraft.language : nodeLanguage;
  const scriptText = scriptNode ? (drafting ? scriptDraft.text : scriptNode.source) : '';
  const scriptCheck = scriptNode ? compileScript(scriptText, scriptLanguage) : null;
  const scriptApplied = !!scriptNode && scriptText === scriptNode.source && scriptLanguage === nodeLanguage;
  // The draft of ANY script node that is not in the graph yet (not only the
  // selected one), so Save and Back to Main can warn before it is discarded.
  // Switching nodes preserves the draft instead of dropping it.
  const unappliedScript = () => {
    if (!scriptDraft.id) return null;
    const target = graph.nodes.find(n => n.id === scriptDraft.id);
    if (!target || target.type !== 'script') return null;
    const language = scriptDraft.language || scriptNodeLanguage(target);
    return scriptDraft.text !== target.source || language !== scriptNodeLanguage(target) ? target : null;
  };
  useEffect(() => {
    const refresh = () => { setRevision(v => v + 1); };
    const stop = watchGraphs(() => { if (nodePatterns.errors.length) setMessage(nodePatterns.errors.join('; ')); });
    const sync = event => {
      // Control/screen leases and LIVE parameter writes are NOT draft changes.
      if (event.key !== null && ![MEDIA_STORAGE_KEY, PROJECTION_STORAGE_KEY].includes(event.key)) return;
      registerMediaSketches(SKETCHES); registerProjectionSketches(SKETCHES); refresh();
    };
    window.addEventListener('storage', sync);
    if (sharedRuntime) {
      const unsubscribe = mainContext.store.subscribe((state, previous) => {
        if (state.mediaRevision !== previous.mediaRevision || state.projectionRevision !== previous.projectionRevision || state.customScripts !== previous.customScripts) refresh();
      });
      return () => { stop(); unsubscribe(); window.removeEventListener('storage', sync); };
    }
    const scripts = new CustomScripts({ role: 'nodes', onChange: refresh, onStatus: status => { if (status.errors.length) setMessage(status.errors.join('; ')); } });
    scripts.start();
    return () => { stop(); window.removeEventListener('storage', sync); scripts.close(); };
  }, []);
  const attempt = fn => { try { fn(); } catch (e) { setMessage(e.message); } };
  // The dependency manifest follows the graph: deleting the last node that used a
  // source also drops its manifest entry, so a removed/changed source (a custom
  // script, say) cannot keep blocking Save after its node is gone. Stored
  // fingerprints of surviving entries stay untouched until an explicit refresh.
  const setGraph = next => setDraft(d => ({ ...d, graph: next, dependencies: pruneManifest(next, SKETCHES, d.dependencies) }));
  const edit = next => { const clean = validateGraph(next); setGraph(clean); };
  const patch = values => attempt(() => edit({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...values } : n) }));
  // Structural scalar/visual nodes share one creator so defaults and validation
  // always come from the shared definitions module. Audio keeps its established
  // column (x=300) so new nodes never cover an existing source row.
  const CREATE_X = { audio: 300 };
  function create(type, x = CREATE_X[type] ?? 70, y = 60 + graph.nodes.length * 35) {
    attempt(() => {
      const n = defaultNode(type, x, y);
      if (type === 'script') approveScript(n.language, n.source);
      edit({ ...graph, nodes: [...graph.nodes, n] });
      setSelected(n.id); setMessage('');
    });
  }
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
  // Focusing a signal endpoint keeps the target node selected, because its
  // numeric sliders are the mapping targets the connect flow asks for.
  const focusSignal = (from, to) => { setSelected(to); setSignalEndpoint({ from, to }); };
  // Selecting a connection is exclusive of node selection: the wire, not its
  // endpoint nodes, becomes the Delete target.
  const pickConnection = (kind, link) => {
    selection.selectWire(connectionRef(kind, link));
    if (kind === 'modulation') setSignalEndpoint({ from: link.from, to: link.to });
    else setSignalEndpoint(null);
  };
  // Scalar targets (Pattern numeric sliders, Blend opacity, Color parameters).
  function signalPort(to) {
    if (!isSignalSource(graph.nodes.find(n => n.id === pending))) return;
    attempt(() => { edit(connectSignal(graph, pending, to)); focusSignal(pending, to); setPending(null); setMessage(''); });
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
    if (!pending) return;
    const from = graph.nodes.find(n => n.id === pending), target = graph.nodes.find(n => n.id === to);
    if (isSignalSource(from) && !isScalarConsumer(target)) { setMessage('Scalar outputs connect to Math/Script inputs or a signal endpoint, not image inputs.'); return; }
    if (isVisualSource(from) && isScalarConsumer(target)) { setMessage('Image outputs connect to image inputs (Blend/Color/Output), not scalar ports.'); return; }
    attempt(() => { edit(isSignalSource(from) ? connectSignalEdge(graph, pending, to, name) : connect(graph, pending, to, name)); setPending(null); setMessage(''); });
  }
  const applyScript = () => {
    if (node?.type !== 'script') return;
    const drafting = scriptDraft.id === node.id;
    const text = drafting ? scriptDraft.text : node.source;
    const language = drafting && scriptDraft.language ? scriptDraft.language : scriptNodeLanguage(node);
    const check = compileScript(text, language);
    // Nothing reaches the graph (or the approval store) unless the source both
    // validates and is stored: a failed Apply leaves the last applied code
    // running untouched.
    if (!check.ok) { setMessage(`Script: ${check.error}`); return; }
    approveScript(language, text);
    patch({ source: text, language });
    setScriptDraft({ id: null, language: null, text: '' });
    setMessage(language === 'body'
      ? 'Script body applied and approved for this exact source.'
      : 'Restricted expression applied and approved for this exact source.');
  };
  // Math Value C only exists while the operation needs it (clamp). Switching to
  // any other operation removes that one scalar wire — model.js does the same for
  // graphs saved by builds that always showed C — and the port row disappears with
  // it. The a/b wires, the node position and the stored c literal are untouched.
  function changeMathOp(op) {
    attempt(() => {
      const droppedC = !mathPorts(op).includes('c') && (graph.signalEdges || []).some(edge => edge.to === node.id && edge.port === 'c');
      edit({ ...graph, nodes: graph.nodes.map(n => n.id === node.id ? { ...n, op } : n) });
      if (droppedC) selection.clearWire();
      setMessage(droppedC ? 'Value C is unused by this operation; its scalar wire was removed.' : '');
    });
  }
  const removable = graph.nodes.filter(n => n.type !== 'output' && selection.ids.includes(n.id));
  // Live diagnostics of the draft: the same messages Save refuses on, plus the
  // node each one belongs to. They outline the editor and the offending nodes
  // instead of only failing the write silently.
  const diagnostics = graphDiagnostics(graph, SKETCHES, dependencies);
  const blocked = diagnostics.messages.length > 0;
  const nodeError = id => (diagnostics.byNode.get(id) || []).join('; ');
  // The connection the sidebar describes. A selection whose link disappeared with
  // an edit (operation change, upstream delete) resolves to null and is simply
  // cleared, so it can never be mistaken for a node selection.
  const selectedLink = selection.wire ? findConnection(graph, selection.wire) : null;
  // Wires that share both endpoints land on the same ◇ socket, so they would be
  // drawn on top of each other and only the topmost could be picked. Split them
  // symmetrically in the middle; the endpoints stay exact.
  const bundles = new Map();
  for (const m of graph.modulations || []) {
    const key = `${m.from}:${m.to}`;
    bundles.set(key, [...(bundles.get(key) || []), m]);
  }
  const bundleBow = m => {
    const group = bundles.get(`${m.from}:${m.to}`) || [m];
    return group.length < 2 ? 0 : (group.indexOf(m) - (group.length - 1) / 2) * BUNDLE_BOW;
  };
  const remove = () => {
    // A selected connection owns Delete: only that wire goes, and the nodes it
    // joins survive even if they were selected before the wire was picked.
    if (selection.wire) {
      if (selectedLink) attempt(() => {
        setDraft(d => ({ ...d, graph: removeConnection(d.graph, selection.wire) }));
        selection.clearWire(); setPending(null); setSignalEndpoint(null); setMessage('');
      });
      else selection.clearWire();
      return;
    }
    const protectsOutput = graph.nodes.some(n => n.type === 'output' && selection.ids.includes(n.id));
    if (removable.length) {
      setGraph(deleteNodes(graph, selection.ids));
      if (scriptDraft.id && selection.ids.includes(scriptDraft.id)) setScriptDraft({ id: null, language: null, text: '' });
      setSelected(graph.nodes.find(n => n.type === 'output').id);
      setPending(null); setSignalEndpoint(null);
    }
    setMessage(protectsOutput ? (removable.length ? 'Output is required and was kept. Other selected nodes and their connections were deleted.' : 'Output is required and cannot be deleted.') : '');
  };
  function load(record) {
    const data = { graph: structuredClone(record.graph), dependencies: structuredClone(record.dependencies || []) };
    setDraft(data); setCurrent(record); baseline.current = serializeGraph(data.graph, data.dependencies);
    // A reload shows disk state only: stale script drafts are dropped.
    setScriptDraft({ id: null, language: null, text: '' });
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
    if (!sharedRuntime) history.replaceState(null, '', nodeEditorUrl(id));
    onSaved?.(id);
    setRouteId(id ?? null);
  }
  useEffect(() => {
    const warn = e => { if (dirty() || unappliedScript()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, scriptDraft]);
  useEffect(() => { onState?.({ name: graph.name, dirty: dirty(), busy }); }, [draft, busy, current]);
  if (loadState !== 'ready') return <main className={`nodes-app${loadState === 'error' ? ' has-errors' : ''}`}>
    <header className="nodes-toolbar"><h1>Pattern editor</h1><BackToMain onBack={onBack} /></header>
    {loadState === 'loading' ? <p role="status">Loading selected node pattern from disk…</p> : <section role="alert"><p>{message}</p><button className="btn" onClick={() => resolveRoute(true)}>Retry loading</button></section>}
  </main>;
  return <main className={`nodes-app${blocked ? ' has-errors' : ''}`} data-errors={diagnostics.messages.join(' | ') || undefined} onKeyDown={e => {
    if (busy || e.target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
    if (e.key === 'Escape') { setPending(null); selection.cancel(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
  }}>
    <header className="nodes-toolbar">
      <BackToMain onBack={onBack && leave} busy={busy} />
      <input className="control-input" aria-label="Graph name" title="Edit pattern name" disabled={busy} value={graph.name} maxLength={80} onChange={e => setDraft({ ...draft, graph: { ...graph, name: e.target.value } })} />
      <div className="nodes-toolbar-actions">
        {current && <IconControl className="btn--status-size" icon="reload" label="Reload from Disk" title="Discard edits and reload this pattern from disk" disabled={busy} onClick={() => { if (discard()) diskAction(async () => { await nodePatterns.reconnect(); load(await nodePatterns.load(current.id)); }); }} />}
        <button className="btn btn--solid btn--status-size nodes-save" title={blocked ? `Save is blocked: ${diagnostics.messages.join('; ')}` : 'Save pattern to the linked folder'} disabled={busy} onClick={() => diskAction(async () => {
          if (unappliedScript() && !window.confirm('Script text has not been applied. Save without it?')) throw new DOMException('Canceled', 'AbortError');
          if (blocked) throw new Error(diagnostics.messages.join('; '));
          const record = await nodePatterns.save(graph, dependencies, current);
          setCurrent(record); baseline.current = serializeGraph(graph, dependencies); updateRoute(record.id);
          setMessage('');
        })}>Save</button>
      </div>
      {diskError && <p className="nodes-disk-error" role="alert">{diskError}</p>}
    </header>
    {/* No status strip: guidance and error text never render as a bar. Guidance
        stays on the workspace's data-status attribute for diagnostics and tests;
        only a failed Save/Reload surfaces the alert above. */}
    <div className="nodes-layout" inert={busy}>
      <aside className="nodes-palette" aria-label="Pattern palette">
        <div className="nodes-palette-create">
          <span className="nodes-palette-label">Nodes</span>
          {CREATE_NODES.map(n => <button className={`btn level-${levelOf(n.type)}`} key={n.type} title={n.title} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, nodeType: n.type })); }}>{n.label}</button>)}
        </div>
        <div className="nodes-palette-patterns">
          <span className="nodes-palette-label">Patterns</span>
          <input className="control-input" aria-label="Search patterns" title="Filter available patterns" placeholder="Search patterns…" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="nodes-pattern-list">{SKETCHES.filter(s => !s.nodesGraph && `${s.name} ${s.group}`.toLowerCase().includes(query.toLowerCase())).map(s => <button className="btn" key={s.id} title={`Drag ${s.name} onto the canvas to create a node`} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, patternId: s.id })); }}><span>{s.name}</span><small>{s.group}{s.camera ? ' · Output camera' : ''}</small></button>)}</div>
        </div>
      </aside>
      <section ref={navigation.workspace} {...selection.workspaceHandlers} className="nodes-workspace" aria-label="Graph workspace" tabIndex={0} data-status={message || undefined} title={blocked ? diagnostics.messages.join('; ') : undefined} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => {
        e.preventDefault(); const drag = readPaletteDrag(e.dataTransfer, SKETCHES);
        if (!drag) { setMessage('Invalid palette drag payload'); return; }
        const point = navigation.toGraph(e.clientX, e.clientY);
        if (drag.nodeType) create(drag.nodeType, point.x, point.y); else add(drag.patternId, point.x, point.y);
      }}>
        <div className="nodes-plane" style={{ transform: `translate(${navigation.view.x}px, ${navigation.view.y}px) scale(${navigation.view.zoom})`, width: Math.max(1000, ...graph.nodes.map(n => n.x + 220)), height: Math.max(850, ...graph.nodes.map(n => n.y + 180)) }}>
          <svg className="nodes-wires" aria-label="Connections">{graph.edges.map(e => {
            const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
            const ref = connectionRef('image', e);
            return <Wire key={`edge-${ref.key}`} kind="image" link={e} from={outputAnchor(a)} to={inputAnchor(b, e.port)} selected={sameConnection(selection.wire, ref)} description={describeConnection(graph, ref, e)} onSelect={pickConnection} />;
          })}{(graph.signalEdges || []).map(e => {
            const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
            const ref = connectionRef('signal', e);
            return <Wire key={`wire-${ref.key}`} kind="signal" link={e} from={outputAnchor(a)} to={inputAnchor(b, e.port)} selected={sameConnection(selection.wire, ref)} description={describeConnection(graph, ref, e)} onSelect={pickConnection} />;
          })}{(graph.modulations || []).map(m => {
            const a = graph.nodes.find(n => n.id === m.from), b = graph.nodes.find(n => n.id === m.to);
            const ref = connectionRef('modulation', m);
            return <Wire key={`signal-${ref.key}`} kind="modulation" link={m} from={outputAnchor(a)} to={signalAnchor(b)} bow={bundleBow(m)} selected={sameConnection(selection.wire, ref)} description={describeConnection(graph, ref, m)} onSelect={pickConnection} />;
          })}</svg>
          {graph.nodes.map(n => <article key={n.id} className={`nodes-node level-${levelOf(n.type)} ${selection.ids.includes(n.id) ? 'is-selected' : ''}${nodeError(n.id) ? ' is-invalid' : ''}`} data-node-id={n.id} data-primary={selected === n.id || undefined} data-node-error={nodeError(n.id) || undefined} title={nodeError(n.id) || undefined} style={{ left: n.x, top: n.y }} onClick={e => selection.nodeClick(n.id, e)}>
            <button className="nodes-node-title" title={`Select or drag ${label(n)}`} aria-label={`Select ${label(n)}`} aria-pressed={selection.ids.includes(n.id)} {...selection.titleHandlers(n)}>{label(n)}</button>
            <div className="nodes-ports">{activeInputs(n).map(name => <button key={name} className="nodes-input" title={`Connect to ${label(n)} ${name} input`} aria-label={`${n.id} input ${name}`} onClick={() => port(n.id, name)}>● {name}</button>)}
              {n.type !== 'output' && <button className={`nodes-output ${pending === n.id ? 'active' : ''}`} title={`Connect from ${label(n)} output`} aria-label={`${n.id} output`} onClick={() => { setPending(n.id); setMessage(''); }}>out ●</button>}
            </div><small className="nodes-node-detail">{n.type === 'blend' ? `${n.mode} · ${Math.round(n.opacity * 100)}%` : n.type === 'output' ? 'Final image' : n.type === 'audio' ? `${deviceLabel(n.deviceId)} · ${AUDIO_CHANNEL_LABELS[n.channel] || 'Mono'} · ${n.band} activity · 0…1` : n.type === 'color' ? 'image → filtered image' : n.type === 'math' ? `${n.op} · scalar out` : n.type === 'script' ? (compileScript(n.source, scriptNodeLanguage(n)).ok ? (scriptNodeLanguage(n) === 'body' ? 'script body' : 'restricted expression') : 'script error') : n.patternId}</small>
            {isModulationTarget(n) && <button className="nodes-signal-endpoint" aria-label={`${n.id} signal endpoint`} onClick={e => {
              e.stopPropagation();
              if (pending) signalPort(n.id);
              else {
                const m = (graph.modulations || []).find(m => m.to === n.id);
                // An endpoint never selects its own node: it selects the
                // connection, so Delete cannot destroy the node by accident.
                if (m) pickConnection('modulation', m);
              }
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
      <aside className="nodes-inspector">
        {/* The level pill rides beside, never inside, the heading: it names the
            node's level at a glance while the h2 keeps the node's exact name. */}
        <div className="nodes-inspector-head"><h2>{node ? label(node) : selectedLink ? 'Connection' : 'Preview'}</h2>
          {node && <span className={`nodes-level-tag level-${levelOf(node.type)}`} title={levelOf(node.type) === 'signal'
            ? 'Signal-level node (Audio, Math, Script): emits numbers, never pictures.'
            : 'Image-level node (Pattern, Blend, Color, Output): carries pixels.'}>{levelOf(node.type)}</span>}</div>
        {/* The draft's blocking diagnostics, as text: the red editor outline and the
            outlined nodes show *that* and *where* something is wrong, and this list
            says what. No role="alert": the Script inspector already owns that live
            region for its own validation message. */}
        {blocked && <section className="nodes-blocked" aria-label="Editor errors" data-testid="nodes-blocked">
          <h2>Cannot save yet</h2>
          <ul>{diagnostics.messages.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </section>}<Preview graph={graph} dependencies={dependencies} selected={selected} revision={revision} current={previewRuntime} sharedRuntime={sharedRuntime} audioProvider={audioProvider} providerReady={providerReady} visible={!(node?.type === 'audio' || node?.type === 'script')} />
        {selectedLink && <section className="nodes-connections" aria-label="Selected connection">
          <output className="nodes-connection-name" data-testid="selected-connection">{describeConnection(graph, selection.wire, selectedLink)}</output>
          <button className="btn btn--danger" title="Remove only this wire; both endpoint nodes stay" onClick={remove}>Delete connection</button>
        </section>}
        {node?.type === 'audio' && <><label>Audio band<Select aria-label="Audio band" value={node.band} onChange={e => patch({ band: e.target.value })}>{BANDS.map(b => <option key={b}>{b}</option>)}</Select></label>
          <label>Audio input device<Select aria-label="Audio input device" title="Global follows the Settings input; a pinned entry captures that specific device in the control window" value={node.deviceId ?? ''} onChange={e => patch({ deviceId: e.target.value || null })}>
            <option value="">Global input (Settings){globalActiveLabel ? ` — ${globalActiveLabel}` : ''}</option>
            {inputOptions.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Audio input ${i + 1}`}</option>)}
            {node.deviceId && !inputOptions.some(d => d.deviceId === node.deviceId) && <option value={node.deviceId}>{`Unavailable input (…${node.deviceId.slice(-6)})`}</option>}
          </Select></label>
          <label>Channel<Select aria-label="Audio channel" title="Left and Right isolate one channel of a stereo input; Mono combines both channels' activity and does not phase-cancel stereo" value={node.channel} onChange={e => patch({ channel: e.target.value })}>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="mono">Mono</option>
          </Select></label>
          <AudioRouteStatus runtime={previewRuntime} nodeId={node.id} channelNote={channelNoteFor(node.id)} />
          <SignalReadout runtime={previewRuntime} nodeId={node.id} />
          <p>Normalized custom-script activity (0…1) from this node's own input route. Uses the control window's shared audio inputs; no input means zero. Mono combines both channels' activity; it does not phase-cancel stereo. Connect out to one or many ◇ signal endpoints.</p></>}
        {node?.type === 'output' && <p>Output has no numeric controls. Image mapping is not supported here.</p>}
        {node?.type === 'color' && <p>Color filters its image input in place: saturation → brightness → contrast → hue-rotate. Identity defaults (1 / 1 / 1 / 0) copy the input pixels unchanged; every numeric slider maps like Pattern and Blend. Without an image input it renders transparent, and it still saves.</p>}
        {node?.type === 'math' && <><label>Operation<Select aria-label="Math operation" title="Choose the scalar operation" value={node.op} onChange={e => changeMathOp(e.target.value)}>{MATH_OPS.map(op => <option key={op} value={op}>{MATH_LABELS[op]}</option>)}</Select></label>
          {MATH_INPUTS.map(port => {
            // Value C exists only for clamp. Outside clamp the row is hidden and
            // disabled; the stored literal stays untouched for when it returns.
            const active = mathPorts(node.op).includes(port);
            return <label key={port} hidden={!active}>{MATH_PORT_LABELS[port]} literal<input className="control-input" type="number" step="0.01" disabled={!active} aria-label={`Math ${port} literal`} title={active ? `Literal used when ${port} has no wire` : `${MATH_PORT_LABELS[port]} is only used by clamp`} value={node[port]} onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) patch({ [port]: next }); }} /></label>;
          })}
          <SignalReadout runtime={previewRuntime} nodeId={node.id} />
          <p>Scalar inputs stay signed floats — nothing is normalized here. Each port takes a wire from an Audio/Math/Script output, otherwise its literal applies. {node.op === 'clamp' ? 'Clamp keeps a between the sorted b/c bounds. ' : 'Value C and its wire exist only for clamp. '}Wires carry values, not pictures.</p></>}
        {node?.type === 'script' && <><label>Language<Select aria-label="Script language" title="Expression is the original single-value language; Body is a compiled statement list with return" value={scriptLanguage} onChange={e => setScriptDraft({ id: node.id, language: e.target.value, text: scriptText })}>
          {['body', 'expression'].map(value => <option key={value} value={value}>{scriptLanguageLabel(value)}</option>)}
        </Select></label>
          <label>Script source<textarea className="control-input nodes-script-source" aria-label="Script source" title={helpForLanguage(scriptLanguage)} maxLength={limitForLanguage(scriptLanguage)} rows={scriptLanguage === 'body' ? 6 : 2} spellCheck={false} value={scriptText} onChange={e => setScriptDraft({ id: node.id, language: scriptLanguage, text: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyScript(); } }} /></label>
          <button className="btn" aria-label="Apply script" title="Validate, store and approve this exact source" disabled={!scriptCheck?.ok} onClick={applyScript}>Apply</button>
          {!scriptCheck?.ok && <p className="nodes-script-error" role="alert">Script: {scriptCheck?.error}</p>}
          <p className="nodes-script-status" role="status" data-testid="script-status">{!scriptCheck?.ok ? 'Not applied' : `${scriptApplied ? (isScriptApproved(nodeLanguage, node.source) ? 'Applied and approved' : 'Applied · review required to run') : 'Not applied'} · ${scriptLanguage} · uses ${SCRIPT_VARIABLES.filter(name => scriptCheck.uses?.[name]).join(', ') || 'no inputs'}`}</p>
          {SCRIPT_INPUTS.map(port => <label key={port}>{SCRIPT_PORT_LABELS[port]} literal<input className="control-input" type="number" step="0.01" aria-label={`Script ${port} literal`} title={`Literal used when ${port} has no wire`} value={node[SCRIPT_LITERAL_FIELDS[port]]} onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) patch({ [SCRIPT_LITERAL_FIELDS[port]]: next }); }} /></label>)}
          <SignalReadout runtime={previewRuntime} nodeId={node.id} />
          <p>{helpForLanguage(scriptLanguage)} Ctrl+Enter or Apply stores and approves it; plain Enter adds a line. A disk-loaded source must be reviewed and applied in this browser before it runs. Unwired x/y use their literals and time is seconds.</p></>}
        {node?.type === 'blend' && <label>Blend mode<Select aria-label="Blend mode" title="Choose pixel blend mode" value={node.mode} onChange={e => patch({ mode: e.target.value })}>{Object.keys(MODES).map(mode => <option key={mode}>{mode}</option>)}</Select></label>}
        {node?.type === 'pattern' && !sketch && <p>Missing pattern. Delete and replace this node, or restore its dependency.</p>}
        {signalNode && (graph.modulations || []).some(m => m.to === signalNode.id) && <section className="nodes-signals" aria-label="Connected signals"><h2>Connected signals</h2>
          {[...new Set(graph.modulations.filter(m => m.to === signalNode.id).map(m => m.from))].map(from => <button key={from} className={`btn nodes-signal-chip ${signalEndpoint?.from === from && signalEndpoint?.to === signalNode.id ? 'active' : ''}`} draggable title="Drag onto a numeric slider to map it" onDragStart={e => e.dataTransfer.setData(SIGNAL_DRAG, from)} onClick={() => focusSignal(from, signalNode.id)}>{label(graph.nodes.find(n => n.id === from))}</button>)}
        </section>}
        {node && definitions(node, SKETCHES).map(def => {
          const mapping = (graph.modulations || []).find(m => m.to === node.id && m.param === def.key);
          return <ModulatedParameter key={`${node.id}:${def.key}`} node={node} def={def} value={node.type === 'blend' ? node.opacity : node.params[def.key] ?? def.default}
            onChange={value => node.type === 'blend' ? patch({ opacity: value }) : patch({ params: { ...node.params, [def.key]: value } })}
            readEffective={() => previewRuntime.current?.params.get(node.id)?.[def.key]} mapping={mapping} onMap={assignSignal} onRange={(min, max) => edit(mapSignal(graph, mapping.from, node.id, def.key, min, max, true))}
            sourceLabel={mapping ? signalSourceName(mapping.from) : null}
            onInputRange={(inputMin, inputMax) => { if (inputMax <= inputMin) { setMessage('Signal input range needs a max greater than its min.'); return; } edit(mapSignalInput(graph, mapping.from, node.id, def.key, inputMin, inputMax)); }}
            onRemove={() => edit({ ...graph, modulations: graph.modulations.filter(m => m !== mapping) })} />;
        })}
        {/* Wires and nodes are removed from the graph itself: clicking a wire (or a
            ◇ endpoint) and pressing Delete/Backspace, or the sidebar Delete
            connection button, owns connection removal, and Delete/Backspace on a
            node selection owns node removal. The inspector carries no destructive
            buttons of its own. */}
        <details><summary>Dependencies & limits</summary><p>No node, Pattern source or wire budget is imposed: practical graph size follows your hardware. 1280×720 internal image, no recursive graphs, camera capture stays on output, and local files or custom assets are not embedded. A pattern file stays under 200 KB so it remains loadable.</p>{dependencies.map(d => <p key={d.id}>{d.name || d.id} · {d.kind}</p>)}<button className="btn" title="Refresh dependency fingerprints from available patterns" onClick={() => attempt(() => { setDraft({ ...draft, dependencies: manifestFor(graph, SKETCHES) }); setMessage('Dependency manifest refreshed explicitly. Save when ready.'); })}>Refresh dependencies</button></details>
      </aside>
    </div>
  </main>;
}
