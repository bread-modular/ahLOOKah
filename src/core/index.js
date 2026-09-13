// Public entry point of the focused rendering core that replaces p5.js.
//
//   import VizCore from '../core/index.js';
//   const instance = new VizCore((p) => { p.setup = ...; p.draw = ...; }, hostNode);
//
// `disposeVizInstance` is the teardown used by ProgramRuntime: it stops the draw
// loop, releases a WebGL context (so rapid LIVE/CUE swaps cannot exhaust the
// browser's context budget) and detaches the canvas.

import VizCore from './sketch.js';

export default VizCore;
export { VizCore };
export { Graphics } from './graphics.js';
export { Renderer2D, defaultDensity } from './renderer-2d.js';
export { RendererGL, VizShader } from './renderer-gl.js';
export { VizImage, VizMediaElement, resolveSource } from './media.js';
export { parseColorArgs, colorFromArgs, VizColor } from './color.js';

/**
 * Release the WebGL context backing an instance (no-op for Canvas2D).
 * Returns true when WEBGL_lose_context reported success.
 */
export function releaseVizContext(instance) {
  const renderer = instance?._renderer;
  if (!renderer) return false;
  if (typeof renderer.loseContext === 'function') {
    try { return renderer.loseContext() !== false; } catch { return false; }
  }
  const context = renderer.gl || renderer.GL || renderer.drawingContext;
  if (context && typeof context.getExtension === 'function') {
    try {
      const extension = context.getExtension('WEBGL_lose_context');
      if (extension) {
        extension.loseContext();
        return true;
      }
    } catch { return false; }
  }
  return false;
}

/** Full teardown: stop rendering, release GL, detach the canvas and elements. */
export function disposeVizInstance(instance) {
  if (!instance) return;
  try { instance.noLoop?.(); } catch { /* already stopped */ }
  releaseVizContext(instance);
  try {
    const removal = instance.remove?.();
    removal?.catch?.(() => {});
  } catch { /* instance already removed */ }
}
