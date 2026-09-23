// Blend modes for the node graph's Blend node, named after the operations in
// TouchDesigner's Composite / Layer TOP menus (the "Operation" parameter).
//
// Two implementation classes, one stored contract — the graph only ever saves
// the mode NAME, so a file never depends on which class rendered it:
//
//   native   Chromium's 2D canvas performs the mode itself through
//            `globalCompositeOperation`. The long-standing Canvas2D path keeps
//            its exact pixels, its alpha behavior and its zero-cost entry.
//   extended The mode has no canvas equivalent (Subtract, Divide, Average, the
//            light family, the quadratic family, the color selectors), so it
//            runs in the graph's shared WebGL2 compositor
//            (src/nodes/gl-compositor.js). If WebGL2 is unavailable the runtime
//            renders Normal and reports a visible per-node diagnostic instead of
//            silently showing different pixels.
//
// Alpha contract (both classes agree, matching the W3C compositing rules the
// canvas implementation follows):
//
//   Cs' = (1 - αb)·Cs + αb·B(Cb, Cs)          blended source color
//   αo  = αs + αb·(1 - αs)                    with αs = layer alpha × opacity
//   Co  = αs·Cs' + αb·(1 - αs)·Cb             premultiplied result
//
// so a fully opaque base runs B(base, layer) exactly, and a transparent base
// shows the layer unchanged (no blend against black).
//
// TouchDesigner operations with no published formula are deliberately absent
// rather than guessed: inverse, subtractive, chromadifference, luminancedifference,
// inside/outside/stencil luminance, yfilm and zfilm. Everything else in that menu
// is covered, and docs/blend-modes-and-transform.md lists each formula.

// Ordered so the editor's normal-mode group reads like the TD menu.
export const NATIVE_MODES = Object.freeze({
  // TD: Over. Kept as "Normal" because graphs saved before this table exist.
  Normal: 'source-over',
  // TD: Add / Linear Dodge. `lighter` is the canvas compositing operator the
  // Blend node has always used, so Add keeps its exact existing pixels.
  Add: 'lighter',
  Multiply: 'multiply',
  Screen: 'screen',
  Overlay: 'overlay',
  // TD: Dimmest / Minimum.
  Darken: 'darken',
  // TD: Brightest / Maximum.
  Lighten: 'lighten',
  'Color Dodge': 'color-dodge',
  'Color Burn': 'color-burn',
  'Hard Light': 'hard-light',
  'Soft Light': 'soft-light',
  Difference: 'difference',
  Exclusion: 'exclusion',
  // TD: Under. The layer goes behind the base.
  Under: 'destination-over',
  // TD: Atop / Inside. The layer survives only where the base has alpha.
  Inside: 'source-atop',
  // TD: Outside. The base survives only where the layer has alpha.
  Outside: 'destination-atop',
  Xor: 'xor',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
});

// GLSL for the modes Chromium's canvas cannot express. `b` is the base (TD's
// first input) and `s` is the layer (TD's second input); both are straight-alpha
// vec3. HELPERS below defines burn/dodge/luma and EPS.
export const EXTENDED_MODES = Object.freeze({
  Subtract: 'max(b - s, vec3(0.0))',
  // base ÷ layer; a zero layer is white, matching TD's "divide by zero is max".
  Divide: 'mix(clamp(b / max(s, EPS), vec3(0.0), vec3(1.0)), vec3(1.0), step(s, vec3(0.0)))',
  Average: '(b + s) * 0.5',
  'Linear Burn': 'clamp(b + s - vec3(1.0), vec3(0.0), vec3(1.0))',
  'Vivid Light': 'mix(burn(b, 2.0 * s), dodge(b, 2.0 * s - vec3(1.0)), step(vec3(0.5), s))',
  'Linear Light': 'clamp(b + 2.0 * s - vec3(1.0), vec3(0.0), vec3(1.0))',
  'Pin Light': 'mix(min(b, 2.0 * s), max(b, 2.0 * s - vec3(1.0)), step(vec3(0.5), s))',
  'Hard Mix': 'step(vec3(1.0), b + s)',
  Negate: 'vec3(1.0) - abs(vec3(1.0) - b - s)',
  Reflect: 'mix(min(vec3(1.0), b * b / max(vec3(1.0) - s, EPS)), vec3(1.0), step(vec3(1.0), s))',
  Glow: 'mix(min(vec3(1.0), s * s / max(vec3(1.0) - b, EPS)), vec3(1.0), step(vec3(1.0), b))',
  Freeze: 'mix(vec3(1.0) - min(vec3(1.0), (1.0 - b) * (1.0 - b) / max(s, EPS)), vec3(0.0), step(s, vec3(0.0)))',
  Heat: 'mix(vec3(1.0) - min(vec3(1.0), (1.0 - s) * (1.0 - s) / max(b, EPS)), vec3(0.0), step(b, vec3(0.0)))',
  // Color selectors compare whole-pixel luma instead of working per channel.
  'Darker Color': 'luma(b) <= luma(s) ? b : s',
  'Lighter Color': 'luma(b) >= luma(s) ? b : s',
});

// One ordered lookup for validation and the editor: every mode name is a key,
// and the value is the canvas operation for native modes or null for the
// shader-only modes. Object key order is the menu order.
export const MODES = Object.freeze({
  ...NATIVE_MODES,
  ...Object.fromEntries(Object.keys(EXTENDED_MODES).map(mode => [mode, null])),
});
export const MODE_NAMES = Object.freeze(Object.keys(MODES));
export const isExtendedMode = mode => Object.hasOwn(EXTENDED_MODES, mode);
export const isNativeMode = mode => Object.hasOwn(NATIVE_MODES, mode);
export const canvasOperation = mode => NATIVE_MODES[mode] || 'source-over';

const SHADER_HELPERS = `#define EPS 1e-5
// Rec.709 luma, the same weights the CSS/canvas separable blend modes use.
float luma(vec3 c) { return dot(c, vec3(0.213, 0.715, 0.072)); }
// W3C Color Burn / Color Dodge, vectorized: a zero divisor saturates instead of
// producing NaN, and the documented edge cases (burn with s = 0, dodge with
// b = 0) fall out of the step() selects.
vec3 burn(vec3 b, vec3 s) {
  return mix(vec3(1.0) - min(vec3(1.0), (1.0 - b) / max(s, EPS)), vec3(0.0), step(s, vec3(0.0)));
}
vec3 dodge(vec3 b, vec3 s) {
  return mix(min(vec3(1.0), b / max(1.0 - s, EPS)), vec3(0.0), step(b, vec3(0.0)));
}`;

// The extended-mode table is the single source of truth for the shader: each
// entry becomes one branch, keyed by its 1-based index, so a mode can never
// render as a different mode than the one the editor list shows.
export function blendFragmentSource(modes = EXTENDED_MODES) {
  const branches = Object.values(modes)
    .map((expression, index) => `  if (uMode == ${index + 1}) return ${expression};`)
    .join('\n');
  return `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uLayer;
uniform vec2 uSize;
uniform float uOriginY;
uniform float uOpacity;
uniform int uMode;
out vec4 outColor;
${SHADER_HELPERS}

vec3 blendMode(int mode, vec3 b, vec3 s) {
${branches}
  return s;
}

void main() {
  // Node canvases are top-down; gl_FragCoord is bottom-up *from the framebuffer*,
  // so the intermediate canvas' viewport origin (non-zero once it has grown for a
  // bigger graph) must be removed before the size normalisation. Both operands are
  // full-frame, so one uv drives both.
  vec2 uv = vec2(gl_FragCoord.x / uSize.x, 1.0 - (gl_FragCoord.y - uOriginY) / uSize.y);
  vec4 base = texture(uBase, uv);
  vec4 layer = texture(uLayer, uv);
  float as = layer.a * uOpacity;
  float ab = base.a;
  vec3 color = mix(layer.rgb, blendMode(uMode, base.rgb, layer.rgb), ab);
  float alpha = as + ab * (1.0 - as);
  outColor = vec4(color * as + ab * (1.0 - as) * base.rgb, alpha);
}`;
}

export const blendModeIndex = (() => {
  const indexes = new Map(Object.keys(EXTENDED_MODES).map((mode, index) => [mode, index + 1]));
  return mode => indexes.get(mode) || 0;
})();
