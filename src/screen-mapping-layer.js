import { ScreenMappingRenderer } from './screen-mapping-renderer.js';
import { IDENTITY_QUAD, mappingEdgeMask, quadToMatrix3d } from './screen-mapping.js';

// A calibrated ordinary input in a mixed projection/ordinary program. Keep it
// inside the program's blend/post-FX group, not in the global output overlay.
export class ScreenMappingLayer {
  constructor({ host, getMapping, getSize, onPresented }) {
    this.getMapping = getMapping;
    this.getSize = getSize;
    this.onPresented = onPresented;
    this.captureRevision = 0;
    this.presentedRevision = 0;
    this.presented = false;
    this.renderRaf = 0;
    this.disposed = false;
    this.element = document.createElement('div');
    this.element.className = 'screen-mapped-layer';
    this.sources = document.createElement('div');
    this.sources.className = 'screen-mapped-source';
    this.element.appendChild(this.sources);
    host.appendChild(this.element);
    this.onContextLost = (event) => { event.preventDefault(); this.fail(new Error('WebGL context lost')); };
    this.resize();
  }

  stopRenderer() {
    if (this.renderer) {
      const { canvas } = this.renderer;
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.renderer.dispose();
      canvas.remove();
      this.renderer = null;
    }
    this.sources.style.opacity = '1';
  }

  fail(error) {
    if (this.disposed) return;
    this.error = String(error?.message || error);
    this.element.dataset.fallback = 'true';
    this.stopRenderer();
    this.queueRender();
  }

  resize() {
    if (this.disposed) return false;
    const { enabled, quad, edgeBlur } = this.getMapping();
    const [width, height] = this.getSize();
    this.matrix = enabled ? quadToMatrix3d(quad, width, height) : null;
    this.edgeBlur = enabled ? edgeBlur : 0;
    this.captureRevision += 1;
    let created = false;
    if (!this.matrix && !this.edgeBlur) {
      this.stopRenderer();
      this.error = null; // Off/on retries a failed GPU context.
      delete this.element.dataset.fallback;
    } else if (!this.error) {
      try {
        if (!this.renderer) {
          const canvas = document.createElement('canvas');
          canvas.className = 'screen-mapped-output';
          this.renderer = new ScreenMappingRenderer(canvas, { alpha: true });
          canvas.addEventListener('webglcontextlost', this.onContextLost);
          this.element.appendChild(canvas);
          created = true;
        }
        this.renderer.configure(quad || IDENTITY_QUAD, width, height, devicePixelRatio || 1);
      } catch (error) { this.fail(error); }
    }
    this.queueRender();
    return created;
  }

  capture(canvas) {
    if (this.disposed) return;
    this.source = canvas;
    this.captureRevision += 1;
    // Synchronous capture is required for unpreserved WebGL source buffers.
    try { this.renderer?.capture(canvas); }
    catch (error) { this.fail(error); }
    this.queueRender();
  }

  queueRender() {
    if (this.disposed || this.renderRaf) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      this.render();
      this.onPresented?.();
    });
  }

  render() {
    if (this.disposed || !this.source) return;
    this.source.style.transformOrigin = '0 0';
    this.source.style.transform = this.matrix || 'none';
    this.source.style.maskImage = mappingEdgeMask(this.edgeBlur);
    this.source.style.maskMode = 'alpha';
    this.source.style.maskComposite = 'intersect';
    try {
      if (this.renderer) {
        if (!this.renderer.render({ canvases: [this.source], edgeBlur: this.edgeBlur, sourceAlpha: true })) return;
        this.sources.style.opacity = '0';
      }
    } catch (error) { this.fail(error); }
    this.presented = true;
    this.presentedRevision = this.captureRevision;
  }

  dispose() {
    this.disposed = true;
    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = 0;
    this.stopRenderer();
    this.element.remove();
  }
}
