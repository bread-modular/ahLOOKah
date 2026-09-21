// Wire endpoints are geometry, not decoration: an image, scalar or modulation
// wire must land on the socket the DOM actually draws. Every constant here
// mirrors one rule in nodes.css (declared inline) and every endpoint in the
// editor is computed from these helpers, so a wire can never drift back into a
// hand-written node-height offset. tests/nodes-wire-selection.spec.js measures
// the live sockets against the emitted paths, so a CSS change that invalidates
// these numbers fails loudly instead of silently mis-drawing the wires.
import { activeInputs } from './definitions.js';

export const FRAME = 1;              // .nodes-node border
export const HEADER = 30;            // .nodes-node-title height
export const PORT_ROW = 32;          // .nodes-input / .nodes-output height
export const PORTS_PAD = 2;          // .nodes-ports block padding (top and bottom)
export const PORTS_MIN_HEIGHT = 36;  // .nodes-ports min-height
export const DETAIL_HEIGHT = 20;     // .nodes-node-detail: 11px line + 9px padding
export const SIGNAL_ROW = 28;        // .nodes-signal-endpoint height
export const ANCHOR_IN = 12;         // ◇ / ● input socket centre inside the node
export const ANCHOR_OUT = 168;       // out ● socket centre inside the node
export const CURVE = 80;             // Bézier control offset on each side
export const BUNDLE_BOW = 16;        // vertical split for wires sharing both endpoints

// Precomputed sums keep the emitted path arithmetic identical to the previous
// hand-written offsets (y + 49 / y + 49 + 32·index) for the wires that were
// already correct, so their `d` text does not change.
const PORT_BASE_Y = FRAME + HEADER + PORTS_PAD + PORT_ROW / 2;   // 49
const SIGNAL_BASE_Y = FRAME + HEADER + DETAIL_HEIGHT + SIGNAL_ROW / 2; // 65

export const portsHeight = (count) => Math.max(PORTS_MIN_HEIGHT, PORTS_PAD * 2 + count * PORT_ROW);
// Rows are the *active* ports: Math hides C for every operation but clamp, and
// the rows below it move up with it.
export const inputAnchor = (node, port) => ({
  x: node.x + ANCHOR_IN,
  y: node.y + PORT_BASE_Y + Math.max(0, activeInputs(node).indexOf(port)) * PORT_ROW,
});
// An output socket always sits on the first row; the node itself is at least
// PORTS_MIN_HEIGHT tall, so a port-less source still has a real anchor.
export const outputAnchor = (node) => ({ x: node.x + ANCHOR_OUT, y: node.y + PORT_BASE_Y });
// ◇ signal endpoint: below the (active) port rows and the detail line.
export const signalAnchor = (node) => ({
  x: node.x + ANCHOR_IN,
  y: node.y + SIGNAL_BASE_Y + portsHeight(activeInputs(node).length),
});
// `bow` splits wires that share both endpoints (several parameters of one target
// fed by the same source) so each one stays visible and clickable in the middle.
// Both ends are untouched, so every wire still lands exactly on its socket.
export const wirePath = (from, to, bow = 0) =>
  `M ${from.x} ${from.y} C ${from.x + CURVE} ${from.y + bow}, ${to.x - CURVE} ${to.y + bow}, ${to.x} ${to.y}`;
