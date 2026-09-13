// Constant surface of the focused rendering core that replaces p5.js.
//
// Only the constants the 91 registered patterns actually reference are exported
// here (plus a few aliases that share the same numeric/string value). The string
// values of the canvas blend constants are deliberately identical to the ones
// p5 exposes, because sketches hand them straight to `blendMode()`.

// Renderer identifiers (p5-compatible).
export const P2D = 'p2d';
export const WEBGL = 'webgl';

// Color modes.
export const RGB = 'rgb';
export const HSB = 'hsb';

// Canvas composite operations (p5's blend constants are the raw Canvas2D ops).
export const BLEND = 'source-over';
export const ADD = 'lighter';
export const LIGHTEST = 'lighten';
export const DARKEST = 'darken';
export const MULTIPLY = 'multiply';
export const SCREEN = 'screen';
export const EXCLUSION = 'exclusion';
export const DIFFERENCE = 'difference';
export const OVERLAY = 'overlay';
export const HARD_LIGHT = 'hard-light';
export const SOFT_LIGHT = 'soft-light';
export const BURN = 'color-burn';
export const DODGE = 'color-dodge';
export const REPLACE = 'copy';

// Alignment/text constants.
export const CENTER = 'center';
export const LEFT = 'left';
export const RIGHT = 'right';
export const TOP = 'top';
export const BOTTOM = 'bottom';
export const BASELINE = 'alphabetic';
export const CORNER = 'corner';
export const CORNERS = 'corners';
export const RADIUS = 'radius';
export const CLOSE = 'close';
export const OPEN = 'open';

// Math constants.
export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const QUARTER_PI = Math.PI / 4;

// Default color channel maxima (p5: RGB 255/full, HSB hue 360).
export const DEFAULT_COLOR_MAXES = Object.freeze({
  [RGB]: [255, 255, 255, 255],
  [HSB]: [360, 100, 100, 1],
});

// Default 3D camera setup: p5 places its default camera 800 units down +Z with a
// 60° vertical field of view and a near/far pair derived from the camera depth.
export const DEFAULT_CAMERA_Z = 800;
export const DEFAULT_FOV = Math.PI / 3;
