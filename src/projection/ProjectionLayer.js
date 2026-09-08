import { ScreenMappingRenderer } from '../screen-mapping-renderer.js';
import { IDENTITY_QUAD, quadToMatrix3d, mappingEdgeMask } from '../screen-mapping.js';
import { surfaceQuad, surfaceEdgeBlur, projectionKey } from './projection-registry.js';

// One presentation layer per top-level projection pattern (also in a merge).
// Child canvases remain the CSS fallback and pointer targets; GPU failure must
// never turn a calibrated projection into a full-frame, unwarped image.
export class ProjectionLayer {
  constructor({ host, pattern, getParams, getSize, onPresented, onRenderCost }) {
    this.onPresented = onPresented;
    this.onRenderCost = onRenderCost;
    this.renderRaf = 0;
    this.captureRevision = 0;
    this.presentedRevision = 0;
    this.pattern = pattern;
    this.getParams = getParams;
    this.getSize = getSize;
    this.children = [];
    this.surfaceStates = new WeakMap();
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

  capture(node, canvas, changed = true) {
    if (this.disposed) return;
    if (!changed && node.canvas === canvas && (!this.renderer || this.renderer.textures.has(canvas))) return;
    node.canvas = canvas;
    this.captureRevision += 1;
    try { this.renderer?.capture(canvas); }
    catch (error) { this.fail(error); }
    this.queueRender();
  }

  queueRender() {
    if (this.renderRaf || this.disposed) return;
    this.captureRevision += 1; // Geometry-only edits also need a presented-frame gate.
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      this.render();
      this.onPresented?.();
    });
  }

  render() {
    if (this.disposed) return;
    const started = this.onRenderCost ? performance.now() : 0;
    const [width, height] = this.getSize();
    const values = this.getParams();
    const alphaBlend = values.alphaBlend === 1;
    if (this.element.dataset.alphaBlend !== String(alphaBlend)) this.element.dataset.alphaBlend = String(alphaBlend);
    const surfaces = this.children.map((node) => {
      const canvas = node.canvas;
      let wrapper = canvas && this.alphaWrappers.get(canvas);
      if (canvas && alphaBlend && !wrapper) {
        // A transparent wrapper preserves source alpha in Chromium's CSS
        // fallback. Filtering/keying itself is enabled only on GPU failure.
        wrapper = document.createElement('div');
        wrapper.className = 'projection-alpha-surface';
        wrapper.style.setProperty('--projection-alpha-filter', `url(#${this.alphaFilterId})`);
        canvas.before(wrapper);
        wrapper.appendChild(canvas);
        canvas.style.transform = 'none';
        canvas.style.setProperty('--projection-edge-mask', 'none');
        this.alphaWrappers.set(canvas, wrapper);
      } else if (!alphaBlend && wrapper) {
        wrapper.before(canvas);
        wrapper.remove();
        this.alphaWrappers.delete(canvas);
        wrapper = null;
      }
      // Async p5 attachment can assign z-index after the first cached draw.
      if (wrapper && wrapper.style.zIndex !== canvas.style.zIndex) wrapper.style.zIndex = canvas.style.zIndex;
      let state = this.surfaceStates.get(node);
      const keys = state?.keys || (node.surface ? IDENTITY_QUAD.flatMap((_, i) =>
        ['x', 'y'].map((axis) => projectionKey(node.surface.id, `${i}${axis}`))) : []);
      const geometry = keys.map((key) => values[key]);
      const edgeBlur = node.surface ? surfaceEdgeBlur(node.surface, values) : 0;
      if (!state || state.canvas !== canvas || state.width !== width || state.height !== height
        || state.alphaBlend !== alphaBlend || state.edgeBlur !== edgeBlur || geometry.some((value, i) => value !== state.geometry[i])) {
        const quad = node.surface ? surfaceQuad(node.surface, values) : IDENTITY_QUAD;
        state = { canvas, quad, edgeBlur, geometry, keys, width, height, alphaBlend };
        this.surfaceStates.set(node, state);
        if (canvas) {
          // Hidden sources need neither a second mask nor an alpha-key filter.
          const target = wrapper || canvas;
          target.style.setProperty('--projection-edge-mask', mappingEdgeMask(edgeBlur));
          target.style.transformOrigin = '0 0';
          target.style.transform = quadToMatrix3d(quad, width, height) || 'none';
        }
      }
      return state;
    });
    if (!this.renderer) { this.presentedRevision = this.captureRevision; return; }
    try {
      if (surfaces.every(({ canvas }) => canvas) && this.renderer.renderSurfaces(surfaces, { alphaBlend })) {
        this.presented = true;
        this.presentedRevision = this.captureRevision;
        if (this.sources.style.opacity !== '0') this.sources.style.opacity = '0';
      }
    } catch (error) { this.fail(error); }
    finally { this.onRenderCost?.(performance.now() - started); }
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
