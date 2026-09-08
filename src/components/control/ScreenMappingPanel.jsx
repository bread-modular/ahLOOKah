import { SKETCHES } from '../../sketch-registry.js';
import { useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import {
  IDENTITY_QUAD,
  SCREEN_MAPPING_CORNER_LABELS,
  SCREEN_MAPPING_EDGE_BLUR_MAX,
  cloneQuad,
  isIdentityQuad,
  parseMappingQuad,
  quadToPointsString,
} from '../../screen-mapping.js';
import { ParamSlider } from './ParamSlider.jsx';
import { ICON_RESET } from '../common/icons.jsx';

const CORNER_HAND_CURSOR = { tl: 'nwse-resize', tr: 'nesw-resize', br: 'nwse-resize', bl: 'nesw-resize' };

// Label anchor offsets (viewBox units) keep the TL/TR/BR/BL tags outside the
// handle so they never block the drag.
const LABEL_OFFSETS = {
  0: { dx: 4, dy: -4, anchor: 'start' },
  1: { dx: -4, dy: -4, anchor: 'end' },
  2: { dx: -4, dy: 9, anchor: 'end' },
  3: { dx: 4, dy: 9, anchor: 'start' },
};

export function ScreenMappingPanel() {
  const { runtime, store } = useRuntime();
  const quad = useVizStore(store, (s) => s.screenMappingQuad);
  const mappingEnabled = useVizStore(store, (s) => s.screenMappingEnabled);
  const edgeBlur = useVizStore(store, (s) => s.screenMappingEdgeBlur);
  const resolution = useVizStore(store, (s) => s.screenResolution);
  const live = useVizStore(store, (s) => s.liveSelection);
  useVizStore(store, (s) => s.projectionRevision);
  const hasProjection = live.ids.some((id) => SKETCHES.find((s) => s.id === id)?.projection);
  const bypassed = live.ids.length > 0 && live.ids.every((id) => SKETCHES.find((s) => s.id === id)?.projection);
  const svgRef = useRef(null);
  const dragRaf = useRef(0);
  const draftRef = useRef(null);
  const [dragCorner, setDragCorner] = useState(null);
  // Live draft while a handle is under the pointer. The store only ever holds
  // renderable quads (invalid drags revert on release), but the editor draws
  // the raw draft and flags it red so the operator sees why nothing applies.
  // The ref is the authoritative latest draft; state mirrors it for rendering.
  const [draft, setDraft] = useState(null);

  const applyDraft = (next) => {
    draftRef.current = next;
    setDraft(next);
  };

  const normalizedFromEvent = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const flushDraft = () => {
    dragRaf.current = 0;
    if (!draftRef.current) return;
    runtime.commands.setScreenMapping(draftRef.current);
  };

  const scheduleFlush = () => {
    if (dragRaf.current) return;
    dragRaf.current = requestAnimationFrame(flushDraft);
  };

  const onHandleDown = (index) => (e) => {
    if (!mappingEnabled) return; // opt-in: corners are locked while off
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setDragCorner(index);
    // A null (full-frame) mapping starts the draft from the frame quad so the
    // first drag move already produces a renderable trapezoid.
    applyDraft(cloneQuad(quad || IDENTITY_QUAD));
  };

  const onHandleMove = (index) => (e) => {
    if (dragCorner !== index) return;
    const pt = normalizedFromEvent(e);
    if (!pt) return;
    const base = draftRef.current && draftRef.current.length === 4
      ? cloneQuad(draftRef.current)
      : cloneQuad(quad || IDENTITY_QUAD);
    if (!base) return;
    base[index] = pt;
    applyDraft(base);
    scheduleFlush();
  };

  const onHandleUp = (index) => (e) => {
    if (dragCorner !== index) return;
    if (dragRaf.current) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = 0;
    }
    if (draftRef.current) runtime.commands.setScreenMapping(draftRef.current);
    setDragCorner(null);
    applyDraft(null);
  };

  const reset = () => {
    if (!mappingEnabled) return;
    if (dragRaf.current) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = 0;
    }
    setDragCorner(null);
    applyDraft(null);
    runtime.commands.resetScreenMapping();
  };

  const displayQuad = draft || quad;
  const parsed = displayQuad ? parseMappingQuad(displayQuad) : { valid: true, quad: null };
  // Null (full-frame) mapping still shows the four corner handles on the frame
  // edges; an in-flight invalid draft keeps its raw shape (flagged red below).
  const points = (parsed.valid && parsed.quad) || displayQuad || IDENTITY_QUAD;
  const invalid = Boolean(displayQuad) && !parsed.valid;
  const isIdentity = isIdentityQuad(points);

  const aspect = resolution?.width > 0 && resolution?.height > 0
    ? `${resolution.width} / ${resolution.height}`
    : '16 / 9';

  return (
    <div className={`config-section-body screen-mapping-body${mappingEnabled ? '' : ' is-disabled'}`}>
      {bypassed && <p className="projection-warning">Bypassed by the live projection mapping pattern. Your global calibration is preserved.</p>}
      {hasProjection && !bypassed && <p className="projection-warning">Screen mapping applies to non-mapping patterns only. Projection patterns keep their own mapping.</p>}
      <label className="screen-mapping-toggle" title="Warp the output into the mapped quad (software keystone for projectors)">
        <input
          id="screen-mapping-enabled"
          type="checkbox"
          checked={mappingEnabled}
          onChange={(e) => runtime.commands.setScreenMappingEnabled(e.target.checked)}
        />
        <span>Enable screen mapping</span>
      </label>

      <div className="screen-mapping-meta">
        <span>Output</span>
        <b
          id="screen-mapping-resolution"
          className={resolution ? undefined : 'screen-offline'}
          title="Resolution of the fullscreen output window"
        >
          {resolution ? `${resolution.width} × ${resolution.height}` : 'offline — 16:9 assumed'}
        </b>
      </div>

      <svg
        id="screen-mapping-editor"
        ref={svgRef}
        className={invalid ? 'is-invalid' : undefined}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ aspectRatio: aspect }}
        role="application"
        aria-label="Screen mapping corner editor"
      >
        {[1, 2].map((i) => (
          <line key={`v${i}`} className="sm-grid" x1={i * (100 / 3)} y1="0" x2={i * (100 / 3)} y2="100" />
        ))}
        {[1, 2].map((i) => (
          <line key={`h${i}`} className="sm-grid" x1="0" y1={i * (100 / 3)} x2="100" y2={i * (100 / 3)} />
        ))}
        <rect className="sm-frame" x="0" y="0" width="100" height="100" />
        {points && (
          <polygon className="sm-quad" points={quadToPointsString(points)} />
        )}
        {(points || []).map((pt, index) => {
          const cx = pt.x * 100;
          const cy = pt.y * 100;
          const off = LABEL_OFFSETS[index];
          const key = SCREEN_MAPPING_CORNER_LABELS[index].toLowerCase();
          return (
            <g key={`corner-${index}`}>
              <circle
                className={`sm-handle${dragCorner === index ? ' is-dragging' : ''}`}
                cx={cx}
                cy={cy}
                r="2.6"
                style={{ pointerEvents: 'none' }}
              />
              <text className="sm-label" x={cx + off.dx} y={cy + off.dy} textAnchor={off.anchor}>
                {SCREEN_MAPPING_CORNER_LABELS[index]}
              </text>
              <circle
                className="sm-handle-hit"
                data-corner={key}
                data-corner-index={index}
                cx={cx}
                cy={cy}
                r="7"
                style={{ cursor: CORNER_HAND_CURSOR[key] }}
                onPointerDown={onHandleDown(index)}
                onPointerMove={onHandleMove(index)}
                onPointerUp={onHandleUp(index)}
                onPointerCancel={onHandleUp(index)}
              >
                <title>{`Drag the ${SCREEN_MAPPING_CORNER_LABELS[index]} corner`}</title>
              </circle>
            </g>
          );
        })}
      </svg>

      <div className="config-group actions">
        <button
          id="screen-mapping-reset-btn"
          type="button"
          onClick={reset}
          disabled={!mappingEnabled || (isIdentity && !draft)}
        >
          {ICON_RESET}
          Reset to Full Frame
        </button>
      </div>

      <ParamSlider
        scope="screen"
        id="mapping"
        def={{ key: 'edgeBlur', label: 'Edge blurring', min: 0, max: SCREEN_MAPPING_EDGE_BLUR_MAX, step: 0.5 }}
        getValue={() => edgeBlur}
        onChange={(value) => runtime.commands.setScreenMappingEdgeBlur(value)}
        valueFormat={(value) => value === 0 ? '0% (off)' : `${value}%`}
        disabled={!mappingEnabled}
      />
      <p>Softens all four edges into black without blurring the picture. Increase the percentage for a wider blend; 0% turns it off.</p>

      <p>
        Software keystone for projectors: enable it, then drag the four corners
        while watching the projection — each corner is where that edge of the
        picture lands on your physical screen. Adjust until the projected
        picture forms a true rectangle that fills the screen. While off,
        ordinary patterns render to the full screen. For ordinary-only programs,
        the warp applies after blending and post-processing. When merged with a
        projection pattern, ordinary patterns are mapped before the shared blend
        and post-processing; projection patterns keep their own geometry.
      </p>
    </div>
  );
}
