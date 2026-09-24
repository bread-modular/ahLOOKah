import { RuntimeContext } from '../app/RuntimeContext.jsx';
import { IconControl } from '../components/control/IconControl.jsx';
import { ModulatedParameter } from './ModulatedParameter.jsx';
import { BANDS, definitions, numeric, clampStep, mappingEndpoint, SIGNAL_DRAG, defaultInputRange } from './modulation.js';
import { AUDIO_CHANNEL_LABELS } from '../audio-routing.js';
import { STORAGE } from '../platform/constants.js';
import { MATH_OPS, MATH_LABELS, MATH_INPUTS, MATH_PORT_LABELS, SCRIPT_INPUTS, SCRIPT_PORT_LABELS, SCRIPT_LITERAL_FIELDS, SIGNAL_TYPES, defaultNode, isSignalSource, isVisualSource, isScalarConsumer, isModulationTarget, activeInputs, mathPorts } from './definitions.js';
import { inputAnchor, outputAnchor, signalAnchor, portsHeight, wirePath, BUNDLE_BOW } from './geometry.js';
import { SCRIPT_VARIABLES, SCRIPT_STATE_HELP, compileScript, helpForLanguage, limitForLanguage, scriptLanguageLabel } from './script.js';
import { approveScript, isScriptApproved } from './script-approval.js';
import { scriptLanguageOf as scriptNodeLanguage } from './scalar.js';
import { LFO_PATTERNS, LFO_PATTERN_LABELS, LFO_PARAMS, LFO_RANGES, LFO_RANGE_LABELS, lfoPatternOf, lfoRangeOf, lfoCycleOf, lfoPointsOf, lfoSeedOf, defaultLfoPoints, LFO_MAX_SEED } from './lfo.js';
import { MIDI_MODES, MIDI_MODE_LABELS, MIDI_GATE_MODES, MIDI_GATE_MODE_LABELS, MIDI_CHANNELS, MIDI_MAX_CC, midiParameters, midiModeOf, midiGateModeOf, midiChannelOf, midiDeviceOf, midiCcOf } from './midi.js';
import { MIDI } from '../midi/midi-service.js';
import { formatParamValue } from '../components/control/panelHelpers.js';
import { createEditorAudio } from './audio-provider.js';
import { useCanvasNavigation } from './useCanvasNavigation.js';
import { useDraftHistory } from './history.js';
import { useNodeSelection } from './useNodeSelection.js';
import { nodeEditorUrl } from './routes.js';
import { Select } from '../components/control/Select.jsx';
import { useContext, useEffect, useRef, useState } from 'react';
import { SKETCHES } from '../sketch-registry.js';
import { MEDIA_STORAGE_KEY, registerMediaSketches } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY, registerProjectionSketches } from '../projection/projection-registry.js';
import { CustomScripts } from '../custom-scripts/service.js';
import { MODE_NAMES, isExtendedMode } from './blend-modes.js';
import { glCompositorAvailable } from './gl-compositor.js';
import { isIdentityTransform } from './transform.js';
import { newGraph, validateGraph, connect, deleteNodes, connectionRef, findConnection, removeConnection, DRAG_TYPE, readPaletteDrag, connectSignal, connectSignalEdge, mapSignal, mapSignalInput } from './model.js';
import { GraphRuntime, graphLifecycleKey } from './runtime.js';
import { nodePatterns, watchGraphs } from './repository.js';
import { graphDiagnostics, manifestFor, pruneManifest } from './portability.js';
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
    : n.type === 'blend' ? 'Blend' : n.type === 'audio' ? `Audio · ${n.band}` : n.type === 'camera' ? 'Camera' : n.type === 'color' ? 'Color'
      : n.type === 'transform' ? 'Transform' : n.type === 'lfo' ? `LFO · ${lfoPatternOf(n.pattern)}`
        : n.type === 'midi' ? `MIDI · ${MIDI_MODE_LABELS[midiModeOf(n.mode)].split(' ')[0]}`
        : n.type === 'math' ? `Math · ${n.op || 'add'}` : n.type === 'script' ? 'Script' : 'Output';
}
// The LFO's card line and inspector vocabulary: which shape one cycle traces, the
// output domain it sweeps, and how long one cycle takes. Shared so the node card
// and the inspector can never describe the same node differently.
const lfoRangeText = range => lfoRangeOf(range) === 'bipolar' ? '−1…1' : '0…1';
const LFO_CYCLE_DEF = LFO_PARAMS[0];
const lfoDuration = value => formatParamValue(value, LFO_CYCLE_DEF);
function lfoDetail(n) {
  return `${lfoPatternOf(n.pattern)} · ${lfoRangeText(n.range)} · ${lfoDuration(lfoCycleOf(n))}`;
}
// Blend inspector status. Canvas modes always exist; the shader modes depend on
// the shared WebGL2 compositor this window can actually create, so the note never
// promises a mode the runtime would fall back from.
function blendModeNote(mode, available = glCompositorAvailable()) {
  if (!isExtendedMode(mode)) return `${mode} runs as the browser's own canvas blend operation.`;
  return available ? `${mode} renders in the graph's WebGL2 compositor.` : `${mode} needs WebGL2; this browser renders Normal instead.`;
}
// Transform inspector status: identity never needs the GPU, and a real transform
// must say plainly when this browser cannot run it instead of looking broken.
function transformNote(params, available = glCompositorAvailable()) {
  if (isIdentityTransform(params)) return 'Identity: the input is copied pixel for pixel.';
  return available ? 'WebGL2 perspective transform.' : 'WebGL2 is unavailable: the image passes through unchanged.';
}
// Capability belongs to the live descriptor (also for custom scripts). Wiring,
// not a pattern-node selector or its camera/group name, activates image FX.
const acceptsImage = sketch => sketch?.fx?.input === 'image' && Object.keys(sketch.fx).length === 1;
// Presentation-only level read straight from SIGNAL_TYPES (the single source of
// truth already shared by the model and runtime): violet for signal-level
// sources (Audio/Math/Script), cool blue-gray for image-level nodes
// (Camera/Pattern/Blend/Color/Output, i.e. everything else). The palette buttons, the
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
// The elements that own their own text editing, and with it the browser's own
// undo. Every canvas shortcut (and the canvas-wide Ctrl/Cmd+A) is skipped inside
// them: replacing the characters the operator is typing is never what a canvas
// key means.
const EDITABLE = 'input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const editableTarget = target => target instanceof Element && !!target.closest(EDITABLE);
// Undo/redo narrows that to the elements that really do own a text undo. A
// slider, checkbox, select or button has none, so Ctrl+Z still reaches the draft
// while one of those holds focus — which is exactly where the previous edit was
// made.
const TEXT_FIELD = 'textarea,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"]),[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const textTarget = target => target instanceof Element && !!target.closest(TEXT_FIELD);
// Structural palette items are drag-only, exactly like Pattern sources: dropping
// one on the workspace creates the node at the drop point. There is no click-to-add.
const CREATE_NODES = [
  { type: 'blend', label: '+ Blend', title: 'Drag Blend onto the canvas to create a node' },
  { type: 'color', label: '+ Color', title: 'Drag Color onto the canvas to create a node (saturation, brightness, contrast, hue shift)' },
  { type: 'transform', label: '+ Transform', title: 'Drag Transform onto the canvas to create an image node (move, scale and rotate the picture in X, Y and Z)' },
  { type: 'camera', label: '+ Camera', title: 'Drag Camera onto the canvas to create an image source (Global Settings video input or a pinned camera)' },
  { type: 'script', label: '+ Script', title: 'Drag Script onto the canvas to create a node (restricted scalar expression and compiled body)' },
  { type: 'audio', label: '+ Audio', title: 'Drag Audio onto the canvas to create a node (bass, mid or high activity)' },
  { type: 'lfo', label: '+ LFO', title: 'Drag LFO onto the canvas to create a signal source: a free-running oscillator (linear, sine, noise, random or a drawn pattern) over 0…1 or −1…1, with a logarithmic cycle time of 100 ms…10 s' },
  { type: 'midi', label: '+ MIDI', title: 'Drag MIDI onto the canvas to create a signal source: one channel of a controller (note gates, or one control-change value) as a normalized 0…1 signal. Configure access and pick a device in its inspector' },
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
// The Custom LFO pattern's drawing pad: one cycle across the width, value up the
// height, point i sitting at i + 0.5 columns. A stroke is ONE undo step (every
// move merges under the node's key and the editor's pointer-release listener
// seals it) and only the y value of an existing column is ever written, so the
// table keeps its length and stays a valid 0…1 curve whatever the pointer does.
function LfoShapePad({ points, onDraw, onReset }) {
  const pad = useRef(null);
  const stroke = useRef(false);
  const count = points.length;
  const columnAt = event => {
    const rect = pad.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    return { index: Math.min(count - 1, Math.max(0, Math.floor(x * count))), value: Math.min(1, Math.max(0, 1 - y)) };
  };
  const paint = event => {
    const { index, value } = columnAt(event);
    if (points[index] === value) return;
    const next = points.slice(); next[index] = value; onDraw(next);
  };
  const vertices = points.map((v, i) => `${i + 0.5},${1 - v}`);
  return <div className="nodes-lfo-pad-wrap">
    <svg ref={pad} className="nodes-lfo-pad" viewBox={`0 0 ${count} 1`} preserveAspectRatio="none" aria-hidden="true"
      onPointerDown={e => { if (e.button !== 0) return; stroke.current = true; e.currentTarget.setPointerCapture(e.pointerId); paint(e); }}
      onPointerMove={e => { if (stroke.current) paint(e); }}
      onPointerUp={() => { stroke.current = false; }}
      onPointerCancel={() => { stroke.current = false; }}>
      <path className="nodes-lfo-pad-area" d={`M 0 1 L ${vertices.join(' L ')} L ${count} ${1 - points[0]} L ${count} 1 Z`} />
      {/* The trailing segment shows the wrap back to the first point, so the pad
          reads as a loop instead of a one-shot ramp. */}
      <polyline className="nodes-lfo-pad-line" points={[...vertices, `${count},${1 - points[0]}`].join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
    <p className="nodes-lfo-pad-hint">Drag across the pad to draw one cycle ({count} points); the shape repeats and wraps.</p>
    <button className="btn" aria-label="Reset LFO shape" title="Return the drawn shape to a plain ramp" onClick={onReset}>Reset shape</button>
  </div>;
}
// LFO inspector status: the one non-obvious part of the node is that its cycle
// time is a rate — the runtime accumulates travel, so a mapped signal speeds the
// shape up or slows it down and never restarts it — and that its two sliders are
// automatable like every other numeric control.
function lfoStatus(node) {
  return `One cycle takes ${lfoDuration(lfoCycleOf(node))}. Cycle time is a rate: a signal mapped onto it accelerates or slows the shape without jumping it, and Start Position is the phase it is anchored to.`;
}
// The MIDI node's card line: which device and channel it listens to, and what the
// value comes from.
function midiDetail(n, deviceLabel) {
  const mode = midiModeOf(n.mode);
  const source = mode === 'cc' ? `CC ${midiCcOf(n)}` : MIDI_GATE_MODE_LABELS[midiGateModeOf(n.gateMode)].split(' ')[0];
  return `${deviceLabel} · Ch ${midiChannelOf(n.channel)} · ${source} · 0…1`;
}
// One line of operator-facing MIDI truth: what is missing and what to do about it.
// The node keeps outputting 0 until this says ready.
function midiStatusText(status) {
  if (!status) return 'MIDI status unavailable.';
  if (!status.supported) return 'This browser has no Web MIDI support — open the app in desktop Chrome.';
  if (status.state === 'requesting') return 'Requesting MIDI access…';
  if (status.state === 'denied') return 'MIDI access was denied. Allow MIDI devices for this site and retry.';
  if (status.state === 'error') return `MIDI unavailable: ${status.error}`;
  if (status.state !== 'ready') return 'MIDI is not configured yet — turn it on to read a controller.';
  if (!status.inputs.length) return 'MIDI ready · no input devices detected — connect one and it appears automatically.';
  return `MIDI ready · ${status.inputs.length} input${status.inputs.length === 1 ? '' : 's'} connected.`;
}
// The MIDI inspector: the switches (mode, device, channel) plus the configuration
// button, the CC number with Learn, and the live readout. Its Attack, Decay and Apply
// Velocity sliders are the shared parameter controls below, so a signal is mapped onto
// them exactly like any other node's slider.
function MidiNodeInspector({ node, patch, reportError, runtime, modulations = [] }) {
  // Status is a subscription, not a per-frame read: a session change repaints once,
  // and a steady controller never re-renders the inspector.
  const [status, setStatus] = useState(() => MIDI.status());
  const [learning, setLearning] = useState(false);
  // One Learn attempt at a time. The token is cancelled by Cancel, by selecting
  // another node, by leaving the editor and by leaving CC mode, so a late permission
  // answer or CC message can never edit a node the operator has moved on from.
  const attempt = useRef(null);
  const currentNode = useRef(node.id);
  currentNode.current = node.id;
  useEffect(() => MIDI.subscribe(setStatus), []);
  // A MIDI node on the canvas is what makes this window need MIDI: ask once, silently
  // when the origin already allows it, and leave the button for a denial or a retry.
  useEffect(() => { MIDI.ensure(); }, [node.id]);
  useEffect(() => {
    setLearning(false);
    return () => { if (attempt.current) attempt.current.cancelled = true; attempt.current = null; MIDI.cancelLearn(); };
  }, [node.id]);
  const cancel = () => {
    if (attempt.current) attempt.current.cancelled = true;
    MIDI.cancelLearn();
    setLearning(false);
  };
  // Learn only exists in CC mode: leaving it ends the attempt instead of leaving a
  // message able to switch the node back.
  useEffect(() => { if (midiModeOf(node.mode) !== 'cc') cancel(); }, [node.mode]);
  const learn = async () => {
    const token = { nodeId: node.id, cancelled: false };
    attempt.current = token;
    const live = () => !token.cancelled && currentNode.current === token.nodeId;
    setLearning(true);
    try {
      // Learn implies configuration: ask for access first and only wait for a message
      // once the session is actually ready — a denial must never look like "waiting".
      const current = await MIDI.request();
      if (!live()) return;
      if (current?.state !== 'ready') { reportError(`Learn needs MIDI access first: ${midiStatusText(current)}`); return; }
      const picked = await MIDI.learnCc({});
      if (!picked || !live()) return;
      patch({ mode: 'cc', channel: picked.channel, params: { ...node.params, cc: picked.cc } });
    } catch (error) { if (live()) reportError(error.message); }
    finally { if (attempt.current === token) { attempt.current = null; setLearning(false); } }
  };
  const mode = midiModeOf(node.mode), gateMode = midiGateModeOf(node.gateMode);
  const device = midiDeviceOf(node.deviceId) ?? '';
  const inputOptions = status?.inputs ?? [];
  const ready = status?.state === 'ready';
  // Switching to a mode that hides a mapped slider drops that mapping (the model's
  // rule: a mapping no control can show could never be edited or removed, and would
  // block Save). Say so, with what to do about it.
  const changeMode = value => {
    const hidden = modulations.filter(m => m.to === node.id && m.param && !midiParameters({ mode: value }).some(def => def.key === m.param));
    patch({ mode: value });
    if (hidden.length) reportError(`${MIDI_MODE_LABELS[value]} has no ${hidden.map(m => m.param).join('/')} slider, so that mapping was removed. Switch back and map it again to restore the automation.`);
  };
  return <>
    <label>Mode<Select aria-label="MIDI mode" title="Gate turns note on/off into an envelope; CC returns one control-change value" value={mode} onChange={e => changeMode(e.target.value)}>
      {MIDI_MODES.map(value => <option key={value} value={value}>{MIDI_MODE_LABELS[value]}</option>)}
    </Select></label>
    <label>MIDI input device<Select aria-label="MIDI input device" title="Any device listens to every controller; a pinned entry follows that one input" value={device} onChange={e => patch({ deviceId: e.target.value || null })}>
      <option value="">Any device</option>
      {inputOptions.map((input, i) => <option key={input.id} value={input.id}>{input.name || `MIDI input ${i + 1}`}</option>)}
      {device && !inputOptions.some(input => input.id === device) && <option value={device}>{`Unavailable input (…${device.slice(-6)})`}</option>}
    </Select></label>
    <label>Channel<Select aria-label="MIDI channel" title="Which of the 16 MIDI channels this node listens to" value={midiChannelOf(node.channel)} onChange={e => patch({ channel: Number(e.target.value) })}>
      {MIDI_CHANNELS.map(channel => <option key={channel} value={channel}>{channel}</option>)}
    </Select></label>
    {mode === 'gate'
      ? <label>Gate mode<Select aria-label="MIDI gate mode" title="Pulse fires one envelope per note and ignores how long the key is held; Sustain follows the held level" value={gateMode} onChange={e => patch({ gateMode: e.target.value })}>
        {MIDI_GATE_MODES.map(value => <option key={value} value={value}>{MIDI_GATE_MODE_LABELS[value]}</option>)}
      </Select></label>
      : <>
        <label>CC number<input className="control-input" type="number" min="0" max={MIDI_MAX_CC} step="1" aria-label="MIDI CC number" title="The control-change number this node returns, 0…127" value={midiCcOf(node)} onChange={e => { const next = Math.round(e.target.valueAsNumber); if (Number.isInteger(next) && next >= 0 && next <= MIDI_MAX_CC) patch({ params: { ...node.params, cc: next } }, { merge: `param:${node.id}:cc` }); }} /></label>
        <div className="nodes-midi-learn">
          <button className="btn" type="button" data-testid="midi-learn" disabled={learning} title="Move the control you want to use: the next CC message sets both the channel and the CC number" onClick={learn}>{learning ? 'Waiting for a CC message…' : 'Learn CC'}</button>
          {learning && <button className="btn" type="button" data-testid="midi-learn-cancel" onClick={cancel}>Cancel</button>}
        </div>
      </>}
    <output className="nodes-midi-status" data-testid="node-midi-status" aria-live="polite">{midiStatusText(status)}</output>
    {status?.supported !== false && !ready && <button className="btn" type="button" data-testid="midi-enable" onClick={() => MIDI.request()}>{status?.state === 'idle' ? 'Enable MIDI' : 'Retry MIDI'}</button>}
    <SignalReadout runtime={runtime} nodeId={node.id} />
  </>;
}
// A Script node's persistent state. Sampled rather than animated: the values
// change every frame, and a 10 Hz readout is what makes `state` legible without
// re-rendering the inspector sixty times a second. Read-only — it never advances
// the state it shows.
function formatScriptState(entries) {
  if (!entries?.length) return '';
  return entries.map(({ name, kind, size, value, values }) => kind === 'buffer'
    ? `${name}[${size}] = ${values.slice(0, 8).map(v => v.toFixed(3)).join(', ')}${values.length > 8 ? ', …' : ''}`
    : `${name} = ${value.toFixed(3)}`).join(' · ');
}
function ScriptState({ runtime, nodeId }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const update = () => setText(formatScriptState(runtime.current?.getScriptState?.(nodeId)));
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [runtime, nodeId]);
  if (!text) return null;
  return <div className="nodes-script-state">
    <output data-testid="script-state" aria-label="Script state" aria-live="off" title={SCRIPT_STATE_HELP}>state {text}</output>
    <button type="button" className="btn" data-testid="script-reset-state" title="Restore this script's declared initial state and forget the elapsed time" onClick={() => runtime.current?.resetScriptState?.(nodeId)}>Reset state</button>
  </div>;
}
// Requested-vs-actual input status for the selected Audio node: truthy text with
// a polite live region for transitions, never a color-only or per-tick signal.
function useCameraInputs() {
  const [catalog, setCatalog] = useState({ inputs: [], error: '' });
  useEffect(() => {
    const devices = navigator.mediaDevices;
    let active = true;
    // Listing devices must never request a camera stream or permission. Labels
    // may be blank until the output owner has acquired permission in Settings.
    const refresh = async () => {
      try {
        const list = await devices?.enumerateDevices?.() || [];
        if (active) setCatalog({ inputs: list.filter(d => d.kind === 'videoinput' && d.deviceId), error: '' });
      } catch {
        if (active) setCatalog(c => ({ ...c, error: 'Camera list unavailable. Pinned selections are kept; check Settings and reconnect the device.' }));
      }
    };
    const settingsChanged = event => { if (event.key === STORAGE.video) refresh(); };
    refresh();
    devices?.addEventListener?.('devicechange', refresh);
    window.addEventListener('storage', settingsChanged);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      devices?.removeEventListener?.('devicechange', refresh);
      window.removeEventListener('storage', settingsChanged);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return catalog;
}
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
  // Positions/name are presentation only. A lifecycle revision replaces the
  // graph; parameter and mapping-endpoint revisions update its live views.
  const content = JSON.stringify({ ...graph, name: 'preview', nodes: graph.nodes.map(({ x, y, ...n }) => ({ ...n, x: 0, y: 0 })) });
  const lifecycle = graphLifecycleKey(graph, SKETCHES, dependencies);
  const manifest = JSON.stringify(dependencies);
  useEffect(() => {
    // The provider lives above the Preview/inspector split; wait for it.
    if (!providerReady || !audioProvider?.current) return undefined;
    const audioProviderInstance = audioProvider.current;
    let runtime, frame, oldMessage = '', stopped = false;
    try {
      const children = [];
      runtime = new GraphRuntime({ graph: JSON.parse(content), dependencies: JSON.parse(manifest), sketches: SKETCHES,
        audio: audioProviderInstance.audio,
        context: { audioControlStore: audioProviderInstance.store, onAudioSlotsChanged: audioProviderInstance.refresh, registerChildRuntime: child => children.push(child) } });
      audioProviderInstance.setChildren(children);
      current.current = runtime;
      const render = async () => {
        try {
          // An async FX graph commits only after its upstream frames and child
          // draws finish. Never overlap evaluations or paint a late, disposed tick.
          const requestedTarget = target.current;
          const image = await (runtime.renderFrame
            ? runtime.renderFrame(requestedTarget || undefined)
            : runtime.renderAsync
              ? runtime.renderAsync(requestedTarget || undefined)
              : runtime.render(requestedTarget || undefined));
          if (stopped) return;
          if (target.current !== requestedTarget) { frame = requestAnimationFrame(render); return; }
          // The canvas is unmounted for scalar selections (audio/script), but the
          // runtime must keep ticking so signal readouts and mappings stay live.
          if (canvas.current) {
            const ctx = canvas.current.getContext('2d'); ctx.clearRect(0, 0, 480, 270);
            if (image) ctx.drawImage(image, 0, 0, 480, 270);
          }
          const diagnostics = runtime.getDiagnostics(); const text = diagnostics.join('\n');
          if (text !== oldMessage) { oldMessage = text; setMessages(diagnostics); }
          frame = requestAnimationFrame(render);
        } catch (error) { if (!stopped) setMessages([error.message]); }
      };
      setMessages([]); void render();
    } catch (e) { setMessages([e.message]); }
    return () => { stopped = true; cancelAnimationFrame(frame); runtime?.dispose(); audioProviderInstance.setChildren([]); current.current = null; };
  }, [lifecycle, manifest, revision, providerReady]);
  useEffect(() => {
    // The construction effect above runs first when topology changes. Ordinary
    // edits keep its child list and frame loop; only the graph's live views move.
    if (providerReady) current.current?.updateGraph(JSON.parse(content));
  }, [content, lifecycle, manifest, revision, providerReady]);
  // Audio, Script and LFO are scalar sources with no image to show, so their
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
  const [query, setQuery] = useState(''), [fxOnly, setFxOnly] = useState(false), [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  // The graph stays structurally valid while a name is being replaced character
  // by character. Only Save submits this raw text to strict graph validation.
  const [nameDraft, setNameDraft] = useState(null);
  const cameraCatalog = useCameraInputs();
  const [revision, setRevision] = useState(0);
  const [scriptDrafts, setScriptDrafts] = useState({});
  const [routeId, setRouteId] = useState(() => graphId !== undefined ? graphId : new URLSearchParams(location.search).get('graph'));
  const [loadState, setLoadState] = useState('loading');
  const navigation = useCanvasNavigation(loadState === 'ready');
  // Undo/redo covers the draft (graph + dependencies) only: selection, the name
  // being typed and unapplied Script text are not part of it, exactly as they are
  // not part of a save.
  const draftHistory = useDraftHistory(draft, setDraft);
  const selection = useNodeSelection(graph, draftHistory.apply, navigation);
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
  // The MIDI session's status drives the device select on the card line and in the
  // inspector; subscribing here means one repaint per session change, never per frame.
  const [midiStatus, setMidiStatus] = useState(() => MIDI.status());
  useEffect(() => MIDI.subscribe(setMidiStatus), []);
  useEffect(() => {
    const provider = sharedRuntime ? sharedRuntime.createEditorAudio() : createEditorAudio();
    audioProvider.current = provider;
    const unsubscribe = provider.subscribeInputs?.(snapshot => setInputsSnapshot(snapshot)) || null;
    setProviderReady(true);
    return () => { unsubscribe?.(); setProviderReady(false); provider.dispose(); audioProvider.current = null; };
  }, []);
  const inputOptions = Array.isArray(inputsSnapshot?.inputs) ? inputsSnapshot.inputs : [];
  const cameraOptions = cameraCatalog.inputs;
  const globalCameraId = localStorage.getItem(STORAGE.video);
  const globalCameraLabel = cameraOptions.find(d => d.deviceId === globalCameraId)?.label || null;
  const cameraLabel = deviceId => {
    if (!deviceId) return 'Global';
    const found = cameraOptions.find(d => d.deviceId === deviceId);
    return found ? (found.label || 'Camera input') : 'Unavailable camera';
  };
  const deviceLabel = deviceId => {
    if (!deviceId) return 'Global';
    const found = inputOptions.find(d => d.deviceId === deviceId);
    return found ? (found.label || 'Audio input') : 'Unavailable input';
  };
  const midiDeviceLabel = node => {
    const pinned = midiDeviceOf(node.deviceId);
    if (!pinned) return 'Any device';
    const found = (midiStatus?.inputs || []).find(input => input.id === pinned);
    return found ? (found.name || 'MIDI input') : 'Unavailable input';
  };
  const channelNoteFor = nodeId => {
    const status = previewRuntime.current?.getNodeStatus?.(nodeId);
    const channels = status?.source?.channels;
    return Number.isFinite(channels) && channels <= 1 ? '1-channel input; Left and Right use the same signal.' : '';
  };
  const globalActiveLabel = inputsSnapshot?.globalActiveId
    ? (inputOptions.find(d => d.deviceId === inputsSnapshot.globalActiveId)?.label || null) : null;
  const name = nameDraft ?? graph.name;
  const nameError = !name.trim() || name.length > 80 ? 'Name must contain 1–80 characters' : '';
  // Compare editable data, not a strict serialization of an intermediate name.
  // The baseline is the loaded/saved graph, including its dependency manifest.
  const snapshot = (value, manifest) => JSON.stringify({ graph: value, dependencies: manifest });
  const baseline = useRef(snapshot(newGraph(), []));
  const dirty = () => snapshot({ ...graph, name }, dependencies) !== baseline.current;
  const unappliedScripts = () => graph.nodes.filter(target => {
    if (target.type !== 'script' || !scriptDrafts[target.id]) return false;
    const { text, language } = scriptDrafts[target.id];
    return text !== target.source || language !== scriptNodeLanguage(target);
  });
  // Both guards inspect every pending Script, not just the selected one.
  const discard = () => (!unappliedScripts().length || window.confirm('Discard unapplied script text?')) && (!dirty() || confirmDiscard());
  const leave = () => { if (!discard()) return; onBack?.(); };
  const reportError = text => { setMessage(text); setActionError(text); };
  const clearMessage = () => { setMessage(''); setActionError(''); };
  const diskAction = async fn => {
    if (busy) return;
    setBusy(true); setDiskError(''); setActionError('');
    try { await fn(); }
    catch (e) {
      // Cancel is an operator decision; anything else is a real failure and must
      // be visible, not only recorded in the workspace's data-status attribute.
      if (e.name === 'AbortError') setMessage('Canceled. Draft retained.');
      else { reportError(e.message); setDiskError(e.message); }
    }
    finally { setBusy(false); }
  };
  const node = graph.nodes.find(n => n.id === selected);
  const sketch = SKETCHES.find(s => s.id === node?.patternId);
  const sourceDefault = descriptor => descriptor?.camera ? 'Camera default' : 'Source default';
  const imageWired = id => graph.edges.some(edge => edge.to === id && edge.port === 'image');
  // Image FX has a visible optional socket even before it has a wire. Until the
  // shared definitions understand descriptor-driven optional inputs, append it
  // for the editor only; preserve an existing wire if a descriptor goes missing.
  const visibleInputs = n => {
    const descriptor = n.type === 'pattern' ? SKETCHES.find(s => s.id === n.patternId) : null;
    const ports = activeInputs(n, descriptor);
    if (n.type !== 'pattern' || !(acceptsImage(descriptor) || n.inputMode === 'fx' || imageWired(n.id))) return ports;
    return ports.includes('image') ? ports : [...ports, 'image'];
  };
  // Modulation endpoints sit below the DOM's *visible* port rows, even when the
  // underlying model's legacy activeInputs() doesn't yet list the optional port.
  const visibleSignalAnchor = n => {
    const anchor = signalAnchor(n);
    return { ...anchor, y: anchor.y + portsHeight(visibleInputs(n).length) - portsHeight(activeInputs(n).length) };
  };
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
  const scriptDraft = scriptNode ? scriptDrafts[scriptNode.id] : null;
  const scriptLanguage = scriptDraft?.language ?? nodeLanguage;
  const scriptText = scriptNode ? (scriptDraft?.text ?? scriptNode.source) : '';
  const scriptCheck = scriptNode ? compileScript(scriptText, scriptLanguage) : null;
  const scriptApplied = !!scriptNode && scriptText === scriptNode.source && scriptLanguage === nodeLanguage;
  // The persistent slots this source will use, as the inspector names them.
  const scriptStateSummary = (scriptCheck?.program?.state?.entries || [])
    .map(({ name, kind, size }) => kind === 'buffer' ? `${name}[${size}]` : name);
  const updateScriptDraft = values => setScriptDrafts(previous => ({ ...previous, [scriptNode.id]: { language: scriptLanguage, text: scriptText, ...values } }));
  useEffect(() => {
    const refresh = () => { setRevision(v => v + 1); };
    const stop = watchGraphs(() => { if (nodePatterns.errors.length) reportError(nodePatterns.errors.join('; ')); });
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
    const scripts = new CustomScripts({ role: 'nodes', onChange: refresh, onStatus: status => { if (status.errors.length) reportError(status.errors.join('; ')); } });
    scripts.start();
    return () => { stop(); window.removeEventListener('storage', sync); scripts.close(); };
  }, []);
  const attempt = fn => {
    try { fn(); setActionError(''); return { ok: true }; }
    catch (e) { reportError(e.message); return { ok: false, error: e.message }; }
  };
  // The dependency manifest follows the graph: deleting the last node that used a
  // source also drops its manifest entry, so a removed/changed source (a custom
  // script, say) cannot keep blocking Save after its node is gone. Stored
  // fingerprints of surviving entries stay untouched until an explicit refresh.
  // Every committed edit goes through draftHistory.apply, which records the previous
  // draft for undo before the new one is stored; `options` optionally names the
  // gesture a change belongs to, so a drag is one undo step and not one per frame.
  const setGraph = (next, options) => draftHistory.apply(d => ({ ...d, graph: next, dependencies: pruneManifest(next, SKETCHES, d.dependencies) }), options);
  const edit = (next, options) => { const clean = validateGraph(next); setGraph(clean, options); };
  const patch = (values, options) => attempt(() => edit({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...values } : n) }, options));
  // Structural scalar/visual nodes share one creator so defaults and validation
  // always come from the shared definitions module. Audio keeps its established
  // column (x=300) so new nodes never cover an existing source row.
  const CREATE_X = { audio: 300 };
  function create(type, x = CREATE_X[type] ?? 70, y = 60 + graph.nodes.length * 35) {
    attempt(() => {
      const n = defaultNode(type, x, y);
      if (type === 'script') approveScript(n.language, n.source);
      edit({ ...graph, ...(type === 'camera' ? { version: 2 } : {}), nodes: [...graph.nodes, n] });
      setSelected(n.id); clearMessage();
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
      draftHistory.apply({ graph: next, dependencies: fresh.map(d => dependencies.find(old => old.id === d.id) || d) });
      setSelected(n.id); clearMessage();
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
    attempt(() => { edit(connectSignal(graph, pending, to)); focusSignal(pending, to); setPending(null); clearMessage(); });
  }
  function assignSignal(from, def) {
    if (!numeric(def)) { reportError('Unsupported: only numeric sliders can map; enum, bool and text cannot.'); return; }
    if (!(graph.modulations || []).some(m => m.from === from && m.to === node.id)) { reportError('Connect this signal to the target node first.'); return; }
    const existing = (graph.modulations || []).find(m => m.to === node.id && m.param === def.key);
    if (existing && !window.confirm(`Replace the existing ${def.label} mapping?`)) return;
    const base = clampStep(node.type === 'blend' ? node.opacity : node.params[def.key] ?? def.default, def);
    // A brand-new mapping starts from the source's own domain (a −1…1 LFO maps
    // across the whole slider). Replacing an existing mapping keeps the input
    // range the operator already set, exactly as it did before.
    const range = existing ? null : defaultInputRange(graph.nodes.find(n => n.id === from));
    attempt(() => edit(mapSignal(graph, from, node.id, def.key, base, base < def.max ? clampStep(base + (def.max - def.min) * .25, def) : def.min, true, range)));
  }
  function port(to, name) {
    if (!pending) return;
    const from = graph.nodes.find(n => n.id === pending), target = graph.nodes.find(n => n.id === to);
    if (isSignalSource(from) && !isScalarConsumer(target)) { reportError('Scalar outputs connect to Math/Script inputs or a signal endpoint, not image inputs.'); return; }
    if (isVisualSource(from) && isScalarConsumer(target)) { reportError('Image outputs connect to image inputs (Blend/Color/FX/Output), not scalar ports.'); return; }
    if (target?.type === 'pattern' && !acceptsImage(SKETCHES.find(s => s.id === target.patternId))) {
      reportError('This pattern cannot accept an image input; choose an FX-capable pattern.'); return;
    }
    // The model atomically infers FX/v2 from the new image wire. Removing that
    // wire via removeConnection restores the camera/default source behavior.
    attempt(() => { edit(isSignalSource(from) ? connectSignalEdge(graph, pending, to, name) : connect(graph, pending, to, name, { sketches: SKETCHES })); setPending(null); clearMessage(); });
  }
  const applyScript = () => {
    if (node?.type !== 'script') return;
    const { text, language } = scriptDraft || { text: node.source, language: scriptNodeLanguage(node) };
    const check = compileScript(text, language);
    // A failed Apply leaves both the approved/running source and this node's
    // pending text untouched; other Script drafts are never affected.
    if (!check.ok) { reportError(`Script: ${check.error}`); return; }
    if (!attempt(() => edit({ ...graph, nodes: graph.nodes.map(n => n.id === node.id ? { ...n, source: text, language } : n) })).ok) return;
    approveScript(language, text);
    setScriptDrafts(previous => { const next = { ...previous }; delete next[node.id]; return next; });
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
  const saveProblems = [...(nameError ? [nameError] : []), ...diagnostics.messages];
  const blocked = saveProblems.length > 0;
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
        draftHistory.apply(d => ({ ...d, graph: removeConnection(d.graph, selection.wire) }));
        selection.clearWire(); setPending(null); setSignalEndpoint(null); clearMessage();
      });
      else selection.clearWire();
      return;
    }
    const protectsOutput = graph.nodes.some(n => n.type === 'output' && selection.ids.includes(n.id));
    if (removable.length) {
      const abandoned = removable.filter(n => n.type === 'script' && unappliedScripts().some(d => d.id === n.id));
      if (abandoned.length && !window.confirm(`Delete ${abandoned.length} Script node${abandoned.length === 1 ? '' : 's'} and discard unapplied script text?`)) return;
      setGraph(deleteNodes(graph, selection.ids));
      setScriptDrafts(previous => {
        const next = { ...previous };
        for (const n of removable) delete next[n.id];
        return next;
      });
      setSelected(graph.nodes.find(n => n.type === 'output').id);
      setPending(null); setSignalEndpoint(null);
    }
    if (protectsOutput) reportError(removable.length ? 'Output is required and was kept. Other selected nodes and their connections were deleted.' : 'Output is required and cannot be deleted.');
    else clearMessage();
  };
  // Undo/redo restores a whole draft, so the editor state that hangs off it is
  // reconciled to what the restored graph actually contains: a node or wire that
  // no longer exists is never left selected, the pending connection is dropped
  // when its node is gone, and a Script node that disappears takes its unapplied
  // text with it — which asks first, exactly like Delete's own guard. The name
  // being typed is deliberately untouched: that text belongs to the field.
  const losesScriptText = target => graph.nodes.filter(n => n.type === 'script' && scriptDrafts[n.id] && !target.graph.nodes.some(m => m.id === n.id));
  const syncAfterHistory = restored => {
    // The name is outside the history, so a restore must never rewind it: an entry
    // carries the name its graph had when it was recorded, while the operator may
    // have typed — and already saved — a different one since. Nothing typed at the
    // moment of the restore means the current name wins, pinned in the name draft
    // so the restored graph itself keeps the validated name it was saved with.
    if (nameDraft === null && restored.graph.name !== name) setNameDraft(name);
    const ids = new Set(restored.graph.nodes.map(n => n.id));
    setScriptDrafts(previous => {
      const kept = Object.entries(previous).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
    });
    const survives = id => id !== null && ids.has(id);
    if (!selection.ids.every(survives) || (selected !== null && !survives(selected))) {
      const kept = selection.ids.filter(survives);
      const fallback = selection.wire ? null : restored.graph.nodes.find(n => n.type === 'output')?.id ?? null;
      selection.reset(kept.at(-1) ?? fallback);
    }
    if (selection.wire && !findConnection(restored.graph, selection.wire)) selection.clearWire();
    if (pending && !survives(pending)) setPending(null);
    if (signalEndpoint && !(survives(signalEndpoint.from) && survives(signalEndpoint.to))) setSignalEndpoint(null);
    clearMessage();
  };
  const stepHistory = direction => {
    if (busy) return;
    const target = draftHistory.peek(direction);
    if (!target) return;
    const lost = losesScriptText(target);
    if (lost.length && !window.confirm(`Delete ${lost.length} Script node${lost.length === 1 ? '' : 's'} and discard unapplied script text?`)) return;
    syncAfterHistory(direction === 'redo' ? draftHistory.redo() : draftHistory.undo());
  };
  function load(record) {
    const data = { graph: structuredClone(record.graph), dependencies: structuredClone(record.dependencies || []) };
    setDraft(data); setCurrent(record); baseline.current = snapshot(data.graph, data.dependencies);
    // A freshly read file is a new starting point: nothing before it can be undone.
    draftHistory.reset();
    setNameDraft(null);
    // A reload shows disk state only: stale script drafts are dropped.
    setScriptDrafts({});
    setSelected(data.graph.nodes.find(n => n.type === 'output').id); setPending(null); clearMessage();
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
    } catch (e) { reportError(e.message); setLoadState('error'); }
  }
  useEffect(() => { resolveRoute(); }, []);
  function updateRoute(id) {
    if (!sharedRuntime) history.replaceState(null, '', nodeEditorUrl(id));
    onSaved?.(id);
    setRouteId(id ?? null);
  }
  useEffect(() => {
    const warn = e => { if (dirty() || unappliedScripts().length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, nameDraft, scriptDrafts]);
  // Ctrl/Cmd+A is the canvas's select-all: every node except the structural
  // Output. The browser's own "select every text run in the UI" is prevented,
  // because that is what the shortcut used to do in this editor. The listener
  // belongs to the window rather than to <main>: a freshly opened editor has no
  // focused element, so a keystroke read only by the root element would fall
  // through to the browser exactly when the operator first reaches for it.
  // Editable fields keep their own select-all, and the browser is refused even
  // when the editor itself will not act (a held shortcut, or a busy disk write),
  // so no key state can quietly fall back to selecting the UI text.
  useEffect(() => {
    if (loadState !== 'ready') return;
    const onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      if (editableTarget(e.target)) return;
      e.preventDefault();
      if (busy || e.repeat) return;
      selection.selectAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loadState, busy, selection.selectAll]);
  // Ctrl/Cmd+Z undoes the last draft change; Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y)
  // redoes it. There is no button, no menu entry and no panel: the shortcut is the
  // whole feature, and the same "editable fields keep their own undo" rule as
  // Ctrl+A above means a typed name or Script body is never replaced by a graph
  // step. The latest handler is read through a ref so the window keeps one
  // listener for the editor's whole life. A busy disk write refuses the edit, but
  // the browser default is still refused with it: a Ctrl+Z that the editor owns
  // must never fall through to something else.
  const historyKeys = useRef(null);
  historyKeys.current = e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (textTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    e.preventDefault();
    stepHistory(key === 'y' || e.shiftKey ? 'redo' : 'undo');
  };
  useEffect(() => {
    if (loadState !== 'ready') return;
    const onKey = e => historyKeys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loadState]);
  // A pointer release ends the current edit gesture (history.js): the next slider
  // or mapping drag is a new undo step, and a drag that ended exactly where it
  // started leaves no step behind at all.
  useEffect(() => {
    const release = () => draftHistory.seal();
    for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, release, true);
    return () => { for (const type of ['pointerup', 'pointercancel', 'blur']) window.removeEventListener(type, release, true); };
  }, [draftHistory.seal]);
  useEffect(() => { onState?.({ name, dirty: dirty() || !!unappliedScripts().length, busy }); }, [draft, nameDraft, scriptDrafts, busy, current]);
  if (loadState !== 'ready') return <main className={`nodes-app${loadState === 'error' ? ' has-errors' : ''}`}>
    <header className="nodes-toolbar"><h1>Pattern editor</h1><BackToMain onBack={onBack} /></header>
    {loadState === 'loading' ? <p role="status">Loading selected node pattern from disk…</p> : <section role="alert"><p>{message}</p><button className="btn" onClick={() => resolveRoute(true)}>Retry loading</button></section>}
  </main>;
  return <main className={`nodes-app${blocked ? ' has-errors' : ''}`} data-errors={saveProblems.join(' | ') || undefined} onKeyDown={e => {
    if (busy || editableTarget(e.target)) return;
    if (e.key === 'Escape') { setPending(null); selection.cancel(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
  }}>
    <header className="nodes-toolbar">
      <BackToMain onBack={onBack && leave} busy={busy} />
      <input className="control-input" aria-label="Graph name" aria-invalid={!!nameError} aria-describedby={nameError ? 'nodes-name-error' : undefined} title="Edit pattern name" disabled={busy} value={name} maxLength={80} onChange={e => {
        setNameDraft(e.target.value);
        if (e.target.value.trim()) setDiskError(previous => previous === 'Name must contain 1–80 characters' ? '' : previous);
      }} />
      <div className="nodes-toolbar-actions">
        {current && <IconControl className="btn--status-size" icon="reload" label="Reload from Disk" title="Discard edits and reload this pattern from disk" disabled={busy} onClick={() => { if (discard()) diskAction(async () => { await nodePatterns.reconnect(); load(await nodePatterns.load(current.id)); }); }} />}
        <button className="btn btn--solid btn--status-size nodes-save" title={blocked ? `Save is blocked: ${saveProblems.join('; ')}` : 'Save pattern to the linked folder'} disabled={busy} onClick={() => diskAction(async () => {
          if (unappliedScripts().length && !window.confirm('Script text has not been applied. Save without it?')) throw new DOMException('Canceled', 'AbortError');
          if (blocked) throw new Error(saveProblems.join('; '));
          const record = await nodePatterns.save({ ...graph, name }, dependencies, current);
          setCurrent(record); setDraft({ graph: record.graph, dependencies: record.dependencies });
          setNameDraft(null); baseline.current = snapshot(record.graph, record.dependencies); updateRoute(record.id);
          clearMessage();
        })}>Save</button>
      </div>
      {nameError && <p id="nodes-name-error" className="nodes-name-error" role="alert">{nameError}</p>}
      {diskError && <p className="nodes-disk-error" role="alert">{diskError}</p>}
    </header>
    {/* Only failures are displayed in this small action alert. Successful edits
        keep the workspace quiet; data-status retains diagnostic compatibility. */}
    {actionError && !diskError && <p className="nodes-action-error" role="alert" data-testid="nodes-action-error">{actionError}</p>}
    <div className="nodes-layout" inert={busy}>
      <aside className="nodes-palette" aria-label="Pattern palette">
        <div className="nodes-palette-create">
          <span className="nodes-palette-label">Nodes</span>
          {CREATE_NODES.map(n => <button className={`btn level-${levelOf(n.type)}`} key={n.type} title={n.title} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, nodeType: n.type })); }}>{n.label}</button>)}
        </div>
        <div className="nodes-palette-patterns">
          <span className="nodes-palette-label">Patterns</span>
          <input className="control-input" aria-label="Search patterns" title="Filter available patterns" placeholder="Search patterns…" value={query} onChange={e => setQuery(e.target.value)} />
          <label className="nodes-fx-filter"><input type="checkbox" checked={fxOnly} onChange={e => setFxOnly(e.target.checked)} />FX only</label>
          <div className="nodes-pattern-list">{(() => {
            const matches = SKETCHES.filter(s => !s.nodesGraph && (!fxOnly || acceptsImage(s)) && `${s.name} ${s.group}`.toLowerCase().includes(query.toLowerCase()));
            return matches.length ? matches.map(s => <div className="nodes-pattern-row" key={s.id}>
              <button className="btn nodes-pattern-source" title={`Drag ${s.name} onto the canvas${acceptsImage(s) ? '; connect an image to use as FX' : ''}`} draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ version: 1, patternId: s.id })); }}>
                <span className="nodes-pattern-name">{s.name}{acceptsImage(s) && <span className="nodes-fx-badge" title="Accepts an image input" aria-label="Accepts an image input">◇ FX</span>}</span>
                <small>{s.group}{s.camera ? ' · Output camera' : ''}</small>
              </button>
            </div>) : <p className="nodes-pattern-empty" role="status">No matching patterns{fxOnly ? ' with image-input FX capability' : ''}.</p>;
          })()}</div>
        </div>
      </aside>
      <section ref={navigation.workspace} {...selection.workspaceHandlers} className="nodes-workspace" aria-label="Graph workspace" tabIndex={0} data-status={message || undefined} title={blocked ? saveProblems.join('; ') : undefined} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => {
        e.preventDefault(); const drag = readPaletteDrag(e.dataTransfer, SKETCHES);
        if (!drag) { reportError('Invalid palette drag payload'); return; }
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
            return <Wire key={`signal-${ref.key}`} kind="modulation" link={m} from={outputAnchor(a)} to={visibleSignalAnchor(b)} bow={bundleBow(m)} selected={sameConnection(selection.wire, ref)} description={describeConnection(graph, ref, m)} onSelect={pickConnection} />;
          })}</svg>
          {graph.nodes.map(n => <article key={n.id} className={`nodes-node level-${levelOf(n.type)} ${selection.ids.includes(n.id) ? 'is-selected' : ''}${nodeError(n.id) ? ' is-invalid' : ''}`} data-node-id={n.id} data-primary={selected === n.id || undefined} data-node-error={nodeError(n.id) || undefined} title={nodeError(n.id) || undefined} style={{ left: n.x, top: n.y }} onClick={e => selection.nodeClick(n.id, e)}>
            <button className="nodes-node-title" title={`Select or drag ${label(n)}${n.type === 'pattern' && acceptsImage(SKETCHES.find(s => s.id === n.patternId)) ? ' — accepts an image input' : ''}`} aria-label={`Select ${label(n)}`} aria-describedby={n.type === 'pattern' && acceptsImage(SKETCHES.find(s => s.id === n.patternId)) ? `fx-capability-${n.id}` : undefined} aria-pressed={selection.ids.includes(n.id)} {...selection.titleHandlers(n)}><span className="nodes-title-name">{label(n)}</span>{n.type === 'pattern' && acceptsImage(SKETCHES.find(s => s.id === n.patternId)) && <span id={`fx-capability-${n.id}`} className="nodes-fx-badge" title="Accepts an image input">◇ FX <span className="nodes-visually-hidden">Accepts an image input</span></span>}</button>
            <div className="nodes-ports">{visibleInputs(n).map(name => <button key={name} className="nodes-input" title={`Connect to ${label(n)} ${name} input`} aria-label={`${n.id} input ${name}`} onClick={() => port(n.id, name)}>● {name}</button>)}
              {n.type !== 'output' && <button className={`nodes-output ${pending === n.id ? 'active' : ''}`} title={`Connect from ${label(n)} output`} aria-label={`${n.id} output`} onClick={() => { setPending(n.id); clearMessage(); }}>out ●</button>}
            </div><small className="nodes-node-detail">{n.type === 'blend' ? `${n.mode} · ${Math.round(n.opacity * 100)}%` : n.type === 'output' ? 'Final image' : n.type === 'audio' ? `${deviceLabel(n.deviceId)} · ${AUDIO_CHANNEL_LABELS[n.channel] || 'Mono'} · ${n.band} activity · 0…1` : n.type === 'camera' ? `${cameraLabel(n.deviceId)} · image out` : n.type === 'color' ? 'image → filtered image' : n.type === 'transform' ? 'image → transformed image' : n.type === 'lfo' ? lfoDetail(n) : n.type === 'midi' ? midiDetail(n, midiDeviceLabel(n)) : n.type === 'math' ? `${n.op} · scalar out` : n.type === 'script' ? (compileScript(n.source, scriptNodeLanguage(n)).ok ? (scriptNodeLanguage(n) === 'body' ? 'script body' : 'restricted expression') : 'script error') : n.type === 'pattern' && visibleInputs(n).includes('image') ? `${imageWired(n.id) ? 'Image wired' : sourceDefault(SKETCHES.find(s => s.id === n.patternId))} · ${n.patternId}` : n.patternId}</small>
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
            : 'Image-level node (Camera, Pattern, Blend, Color, Output): carries pixels.'}>{levelOf(node.type)}</span>}</div>
        {/* Blocking graph errors remain readable and announced when they change;
            the name also has its own field-level error in the toolbar. */}
        {blocked && <section className="nodes-blocked" aria-label="Editor errors" aria-live="polite" data-testid="nodes-blocked">
          <h2>Cannot save yet</h2>
          <ul>{saveProblems.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </section>}<Preview graph={graph} dependencies={dependencies} selected={selected} revision={revision} current={previewRuntime} sharedRuntime={sharedRuntime} audioProvider={audioProvider} providerReady={providerReady} visible={!(node && SIGNAL_TYPES.includes(node.type))} />
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
          <SignalReadout runtime={previewRuntime} nodeId={node.id} /></>}
        {node?.type === 'camera' && <><label>Camera input device<Select aria-label="Camera input device" title="Global follows the Settings video input; a pinned entry requests that exact camera on the output screen" value={node.deviceId ?? ''} onChange={e => patch({ deviceId: e.target.value || null })}>
          <option value="">Global input (Settings){globalCameraLabel ? ` — ${globalCameraLabel}` : ''}</option>
          {cameraOptions.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera input ${i + 1}`}</option>)}
          {node.deviceId && !cameraOptions.some(d => d.deviceId === node.deviceId) && <option value={node.deviceId}>{`Unavailable camera (…${node.deviceId.slice(-6)})`}</option>}
        </Select></label>
          <output className="nodes-camera-status" data-testid="node-camera-status" aria-live="polite">{cameraCatalog.error && `${cameraCatalog.error} `}{node.deviceId && !cameraOptions.some(d => d.deviceId === node.deviceId) ? 'Pinned camera unavailable; select another input or reconnect it. ' : ''}Editor preview shows a generated sample clip, not your real camera; live capture runs only on the output screen. Connect Camera out to an image input (FX, Blend, Color or Output). Global follows Settings; a pinned camera requests that exact device on the output screen.</output></>}
        {node?.type === 'lfo' && <><label>Range<Select aria-label="LFO range" title="The domain the pattern is scaled into: 0…1 or −1…1" value={lfoRangeOf(node.range)} onChange={e => patch({ range: e.target.value })}>
          {LFO_RANGES.map(range => <option key={range} value={range}>{LFO_RANGE_LABELS[range]}</option>)}
        </Select></label>
          <label>Pattern<Select aria-label="LFO pattern" title="The shape one cycle traces; Noise and Random are seeded and repeat every cycle" value={lfoPatternOf(node.pattern)} onChange={e => patch({ pattern: e.target.value })}>
            {LFO_PATTERNS.map(pattern => <option key={pattern} value={pattern}>{LFO_PATTERN_LABELS[pattern]}</option>)}
          </Select></label>
          {lfoPatternOf(node.pattern) === 'custom' && <LfoShapePad points={lfoPointsOf(node)}
            onDraw={points => patch({ points }, { merge: `lfo:points:${node.id}`, windowMs: Infinity })}
            onReset={() => patch({ points: defaultLfoPoints() })} />}
          {(lfoPatternOf(node.pattern) === 'noise' || lfoPatternOf(node.pattern) === 'random') && <button className="btn" aria-label="Reshuffle LFO shape" title="Reseed this pattern's shape; the sequence still repeats every cycle" onClick={() => patch({ seed: (lfoSeedOf(node) + 1 + Math.floor(Math.random() * LFO_MAX_SEED)) % (LFO_MAX_SEED + 1) })}>Reshuffle</button>}
          <output className="nodes-lfo-status" data-testid="node-lfo-status" aria-live="polite">{lfoStatus(node)}</output>
          <SignalReadout runtime={previewRuntime} nodeId={node.id} /></>}
        {node?.type === 'midi' && <MidiNodeInspector node={node} patch={patch} reportError={reportError} runtime={previewRuntime} modulations={graph.modulations} />}
        {node?.type === 'transform' && <output className="nodes-transform-status" data-testid="node-transform-status" aria-live="polite">{transformNote(node.params)}</output>}
        {node?.type === 'math' && <><label>Operation<Select aria-label="Math operation" title="Choose the scalar operation" value={node.op} onChange={e => changeMathOp(e.target.value)}>{MATH_OPS.map(op => <option key={op} value={op}>{MATH_LABELS[op]}</option>)}</Select></label>
          {MATH_INPUTS.map(port => {
            // Value C exists only for clamp. Outside clamp the row is hidden and
            // disabled; the stored literal stays untouched for when it returns.
            const active = mathPorts(node.op).includes(port);
            return <label key={port} hidden={!active}>{MATH_PORT_LABELS[port]} literal<input className="control-input" type="number" step="0.01" disabled={!active} aria-label={`Math ${port} literal`} title={active ? `Literal used when ${port} has no wire` : `${MATH_PORT_LABELS[port]} is only used by clamp`} value={node[port]} onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) patch({ [port]: next }, { merge: `literal:${node.id}:${port}` }); }} /></label>;
          })}
          <SignalReadout runtime={previewRuntime} nodeId={node.id} /></>}
        {node?.type === 'script' && <><label>Language<Select aria-label="Script language" title="Expression is the original single-value language; Body is a compiled statement list with return" value={scriptLanguage} onChange={e => updateScriptDraft({ language: e.target.value })}>
          {['body', 'expression'].map(value => <option key={value} value={value}>{scriptLanguageLabel(value)}</option>)}
        </Select></label>
          <label>Script source<textarea className="control-input nodes-script-source" aria-label="Script source" title={helpForLanguage(scriptLanguage)} maxLength={limitForLanguage(scriptLanguage)} rows={scriptLanguage === 'body' ? 6 : 2} spellCheck={false} value={scriptText} onChange={e => updateScriptDraft({ text: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyScript(); } }} /></label>
          <button className="btn" aria-label="Apply script" title="Validate, store and approve this exact source" disabled={!scriptCheck?.ok} onClick={applyScript}>Apply</button>
          {!scriptCheck?.ok && <p className="nodes-script-error" role="alert">Script: {scriptCheck?.error}</p>}
          <p className="nodes-script-status" role="status" data-testid="script-status">{!scriptCheck?.ok ? 'Not applied' : `${scriptApplied ? (isScriptApproved(nodeLanguage, node.source) ? 'Applied and approved' : 'Applied · review required to run') : 'Not applied'} · ${scriptLanguage} · uses ${SCRIPT_VARIABLES.filter(name => scriptCheck.uses?.[name]).join(', ') || 'no inputs'} · ${scriptStateSummary.length ? `state ${scriptStateSummary.join(', ')}` : 'no state'}`}</p>
          <ScriptState runtime={previewRuntime} nodeId={node.id} />
          {SCRIPT_INPUTS.map(port => <label key={port}>{SCRIPT_PORT_LABELS[port]} literal<input className="control-input" type="number" step="0.01" aria-label={`Script ${port} literal`} title={`Literal used when ${port} has no wire`} value={node[SCRIPT_LITERAL_FIELDS[port]]} onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) patch({ [SCRIPT_LITERAL_FIELDS[port]]: next }, { merge: `literal:${node.id}:${port}` }); }} /></label>)}
          <SignalReadout runtime={previewRuntime} nodeId={node.id} /></>}
        {node?.type === 'blend' && <><label>Blend mode<Select aria-label="Blend mode" title="Choose the pixel blend operation (TouchDesigner's Composite TOP list)" value={node.mode} onChange={e => patch({ mode: e.target.value })}>
          <optgroup label="Canvas blend modes">{MODE_NAMES.filter(mode => !isExtendedMode(mode)).map(mode => <option key={mode}>{mode}</option>)}</optgroup>
          <optgroup label="WebGL2 blend modes">{MODE_NAMES.filter(isExtendedMode).map(mode => <option key={mode}>{mode}</option>)}</optgroup>
        </Select></label>
          <output className="nodes-blend-status" data-testid="node-blend-status" aria-live="polite">{blendModeNote(node.mode)}</output></>}
        {node?.type === 'pattern' && visibleInputs(node).includes('image') && <div className="nodes-pattern-image-status">
          <output data-testid="node-image-input-status" aria-live="polite">Image input: {imageWired(node.id) ? 'wired' : `not connected (${sourceDefault(sketch).toLowerCase()})`}</output>
          {!acceptsImage(sketch) && <p className="nodes-fx-warning" role="status">FX capability unavailable. Restore an FX-capable version of this pattern; the existing image wire is retained for repair.</p>}
        </div>}
        {node?.type === 'pattern' && !sketch && <p>Missing pattern. Delete and replace this node, or restore its dependency.</p>}
        {signalNode && (graph.modulations || []).some(m => m.to === signalNode.id) && <section className="nodes-signals" aria-label="Connected signals"><h2>Connected signals</h2>
          {[...new Set(graph.modulations.filter(m => m.to === signalNode.id).map(m => m.from))].map(from => <button key={from} className={`btn nodes-signal-chip ${signalEndpoint?.from === from && signalEndpoint?.to === signalNode.id ? 'active' : ''}`} draggable title="Drag onto a numeric slider to map it" onDragStart={e => e.dataTransfer.setData(SIGNAL_DRAG, from)} onClick={() => focusSignal(from, signalNode.id)}>{label(graph.nodes.find(n => n.id === from))}</button>)}
        </section>}
        {/* Inspector parameters. A pointer drag on a mapped range owns its whole
            gesture as one undo step however long it pauses (`part` is absent); a
            field typed into names itself, so that field's keystrokes group into one
            step and min/max stay separate controls. */}
        {node && definitions(node, SKETCHES).map(def => {
          const mapping = (graph.modulations || []).find(m => m.to === node.id && m.param === def.key);
          return <ModulatedParameter key={`${node.id}:${def.key}`} node={node} def={def} value={node.type === 'blend' ? node.opacity : node.params[def.key] ?? def.default}
            onChange={value => node.type === 'blend' ? patch({ opacity: value }, { merge: `param:${node.id}:opacity` }) : patch({ params: { ...node.params, [def.key]: value } }, { merge: `param:${node.id}:${def.key}` })}
            readEffective={() => previewRuntime.current?.params.get(node.id)?.[def.key]} mapping={mapping} onMap={assignSignal}
            onRange={(min, max, part) => attempt(() => edit(mapSignal(graph, mapping.from, node.id, def.key, min, max, true), { merge: `range:${node.id}:${def.key}:${part || 'gesture'}`, windowMs: part ? undefined : Infinity }))}
            sourceLabel={mapping ? signalSourceName(mapping.from) : null}
            onInputRange={(inputMin, inputMax, changed) => {
              const low = mappingEndpoint(inputMin), high = mappingEndpoint(inputMax);
              if (high <= low) {
                const error = 'Signal input range needs a max greater than its min.';
                reportError(error); return { error };
              }
              const result = attempt(() => edit(mapSignalInput(graph, mapping.from, node.id, def.key, low, high), { merge: `inputRange:${node.id}:${def.key}:${changed}` }));
              if (!result.ok) return { error: result.error };
              const original = changed === 'inputMin' ? inputMin : inputMax;
              const accepted = changed === 'inputMin' ? low : high;
              return { note: original !== accepted ? `Signal in ${changed === 'inputMin' ? 'min' : 'max'} clamped to ${accepted}.` : '' };
            }}
            onRemove={() => attempt(() => edit({ ...graph, modulations: graph.modulations.filter(m => m !== mapping) }))} />;
        })}
        {/* Wires and nodes are removed from the graph itself: clicking a wire (or a
            ◇ endpoint) and pressing Delete/Backspace, or the sidebar Delete
            connection button, owns connection removal, and Delete/Backspace on a
            node selection owns node removal. The inspector carries no destructive
            buttons of its own. */}
      </aside>
    </div>
  </main>;
}
