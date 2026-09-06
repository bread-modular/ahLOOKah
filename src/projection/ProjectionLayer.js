import { ScreenMappingRenderer } from '../screen-mapping-renderer.js';
import { IDENTITY_QUAD, quadToMatrix3d } from '../screen-mapping.js';
import { surfaceQuad } from './projection-registry.js';

// One presentation layer per top-level projection pattern (also in a merge).
// Child canvases remain the CSS fallback and pointer targets; GPU failure must
// never turn a calibrated projection into a full-frame, unwarped image.
export class ProjectionLayer {
  constructor({ host, pattern, getParams, getSize, onPresented }) {
    this.onPresented = onPresented;
    this.renderRaf = 0;
    this.captureRevision = 0;
    this.presentedRevision = 0;
    this.pattern = pattern;
    this.getParams = getParams;
    this.getSize = getSize;
    this.children = [];
    this.presented = false;
    this.disposed = false;
    this.element = document.createElement('div');
    this.element.className = 'projection-layer';
    this.element.dataset.projectionId = pattern.id;
    this.sources = document.createElement('div');
    this.sources.className = 'projection-sources';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'projection-output';
    this.element.append(this.sources, this.canvas);
    host.appendChild(this.element);
    this.onContextLost = (event) => { event.preventDefault(); this.fail(new Error('WebGL context lost')); };
    try {
      this.renderer = new ScreenMappingRenderer(this.canvas);
      this.canvas.addEventListener('webglcontextlost', this.onContextLost);
      this.resize();
    } catch (error) { this.fail(error); }
  }

  fail(error) {
    if (this.disposed) return;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer?.dispose();
    this.renderer = null;
    this.element.dataset.fallback = 'true';
    this.element.dataset.mappingError = String(error?.message || error);
    this.sources.style.opacity = '1';
    this.canvas.style.display = 'none';
    this.presented = true;
  }

  resize() {
    const [width, height] = this.getSize();
    try { this.renderer?.configure(IDENTITY_QUAD, width, height, devicePixelRatio || 1); }
    catch (error) { this.fail(error); }
    this.queueRender();
  }

  capture(node, canvas) {
    if (this.disposed) return;
    node.canvas = canvas;
    this.captureRevision += 1;
    try { this.renderer?.capture(canvas); }
    catch (error) { this.fail(error); }
    this.queueRender();
  }

  queueRender() {
    if (this.renderRaf || this.disposed) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      this.render();
      this.onPresented?.();
    });
  }

  render() {
    if (this.disposed) return;
    const [width, height] = this.getSize();
    const surfaces = this.children.map((node) => ({
      canvas: node.canvas,
      quad: node.surface ? surfaceQuad(node.surface, this.getParams()) : IDENTITY_QUAD,
    }));
    for (const { canvas, quad } of surfaces) {
      if (!canvas) continue;
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = quadToMatrix3d(quad, width, height) || 'none';
    }
    if (!this.renderer) { this.presentedRevision = this.captureRevision; return; }
    try {
      if (surfaces.every(({ canvas }) => canvas) && this.renderer.renderSurfaces(surfaces)) {
        this.presented = true;
        this.presentedRevision = this.captureRevision;
        this.sources.style.opacity = '0';
      }
    } catch (error) { this.fail(error); }
  }

  dispose() {
    this.disposed = true;
    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = 0;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer?.dispose();
    this.renderer = null;
    this.element.remove();
  }
}
