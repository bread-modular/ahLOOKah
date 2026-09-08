import { ScreenMappingRenderer } from '../screen-mapping-renderer.js';
import { IDENTITY_QUAD, quadToMatrix3d, mappingEdgeMask } from '../screen-mapping.js';
import { surfaceQuad, surfaceEdgeBlur } from './projection-registry.js';

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
    this.edgeBlurs = new WeakMap();
    this.alphaWrappers = new WeakMap();
    this.presented = false;
    this.disposed = false;
    this.element = document.createElement('div');
    this.element.className = 'projection-layer';
    this.element.dataset.projectionId = pattern.id;
    this.sources = document.createElement('div');
    this.sources.className = 'projection-sources';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'projection-output';
    // SVG keys the unwarped source before CSS resampling, matching the GPU
    // prepass. Keep IDs unique across LIVE, CUE and control previews.
    this.alphaFilterId = `projection-alpha-${crypto.randomUUID()}`;
    const filters = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filters.classList.add('projection-filter-defs');
    filters.setAttribute('aria-hidden', 'true');
    filters.innerHTML = `<defs><filter id="${this.alphaFilterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  255 255 255 0 0" result="mask" />
      <feComposite in="SourceGraphic" in2="mask" operator="in" />
    </filter></defs>`;
    this.element.append(filters, this.sources, this.canvas);
    host.appendChild(this.element);
    this.onContextLost = (event) => { event.preventDefault(); this.fail(new Error('WebGL context lost')); };
    try {
      this.renderer = new ScreenMappingRenderer(this.canvas, { alpha: true });
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
    const values = this.getParams();
    const alphaBlend = values.alphaBlend === 1;
    this.element.dataset.alphaBlend = String(alphaBlend);
    const surfaces = this.children.map((node) => ({
      canvas: node.canvas,
      quad: node.surface ? surfaceQuad(node.surface, values) : IDENTITY_QUAD,
      edgeBlur: node.surface ? surfaceEdgeBlur(node.surface, values) : 0,
    }));
    for (const { canvas, quad, edgeBlur } of surfaces) {
      if (!canvas) continue;
      let wrapper = this.alphaWrappers.get(canvas);
      if (alphaBlend && !wrapper) {
        // Filtering a canvas directly can flatten SourceGraphic over black in
        // Chromium. A transparent wrapper preserves the source's original alpha.
        wrapper = document.createElement('div');
        wrapper.className = 'projection-alpha-surface';
        wrapper.style.filter = `url(#${this.alphaFilterId})`;
        canvas.before(wrapper);
        wrapper.appendChild(canvas);
        canvas.style.transform = 'none';
        canvas.style.maskImage = 'none';
        this.edgeBlurs.delete(canvas);
        this.alphaWrappers.set(canvas, wrapper);
      } else if (!alphaBlend && wrapper) {
        wrapper.before(canvas);
        wrapper.remove();
        this.alphaWrappers.delete(canvas);
        wrapper = null;
      }
      const target = wrapper || canvas;
      if (wrapper) wrapper.style.zIndex = canvas.style.zIndex;
      // Mask only CSS presentation; texture capture remains raw.
      if (this.edgeBlurs.get(target) !== edgeBlur) {
        target.style.maskImage = mappingEdgeMask(edgeBlur);
        target.style.maskMode = 'alpha';
        target.style.maskComposite = 'intersect';
        this.edgeBlurs.set(target, edgeBlur);
      }
      target.style.transformOrigin = '0 0';
      target.style.transform = quadToMatrix3d(quad, width, height) || 'none';
    }
    if (!this.renderer) { this.presentedRevision = this.captureRevision; return; }
    try {
      if (surfaces.every(({ canvas }) => canvas) && this.renderer.renderSurfaces(surfaces, { alphaBlend })) {
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
