import { useEffect, useRef, useState } from 'react';
import {
  BAND_SPLIT_LIMITS,
  EQ_MIN_HZ,
  EQ_MAX_HZ,
  EQ_DB_TOP,
  EQ_DB_BOTTOM,
} from '../../sketches/audio-features.js';
import {
  NOISE_CAPTURE_DEFAULT_SECONDS,
  getNoiseFloorMeta,
  sampleNoiseFloorDb,
} from '../../noise-floor.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { ICON_MIC, ICON_X } from '../common/icons.jsx';

const EQ_COLORS = {
  bass: '#ff6a3d',
  mid: '#42d68a',
  high: '#5b9dff',
  bassFill: 'rgba(255, 106, 61, 0.16)',
  midFill: 'rgba(66, 214, 138, 0.14)',
  highFill: 'rgba(91, 157, 255, 0.14)',
  bassCurve: 'rgba(255, 106, 61, 0.36)',
  midCurve: 'rgba(66, 214, 138, 0.32)',
  highCurve: 'rgba(91, 157, 255, 0.32)',
  grid: 'rgba(255, 255, 255, 0.07)',
  label: 'rgba(255, 255, 255, 0.38)',
};

const eqHzToX = (hz, w) =>
  (Math.log(Math.min(Math.max(hz, EQ_MIN_HZ), EQ_MAX_HZ) / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ)) * w;
const eqXToHz = (x, w) =>
  EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, Math.min(Math.max(x / w, 0), 1));
const eqDbToY = (db, h) => {
  const t = (EQ_DB_TOP - db) / (EQ_DB_TOP - EQ_DB_BOTTOM);
  return Math.min(h, Math.max(0, t * h));
};
const formatHz = (hz) => {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(Math.round(hz));
};

function audioIdleMessage(status) {
  const st = status?.status || 'idle';
  if (st === 'offline') return 'Waiting for an audio control panel…';
  if (st === 'unselected' || st === 'idle' || st === 'stopped') return 'Select an audio input in Setup.';
  if (st === 'starting') return 'Starting audio input…';
  if (st === 'suspended') return 'Click this control panel to enable audio.';
  if (st === 'running') {
    return status.fallback ? 'Using the default input — waiting for audio data…' : 'Audio connected — waiting for audio data…';
  }
  if (st === 'error') {
    const name = status.error?.name || 'AudioError';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access denied. Re-initialize Setup.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Selected audio input unavailable. Choose another input.';
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'Audio input is busy or unavailable. Close other audio apps and retry.';
    if (name === 'DeviceEndedError') return 'Audio input disconnected — reconnecting…';
    return `Audio input failed (${name}). Select the device again.`;
  }
  return 'Waiting for audio…';
}

function useEqSplit(eqSink) {
  const [split, setSplit] = useState(() => ({ ...eqSink.split }));
  useEffect(() => {
    return eqSink.subscribe(() => {
      setSplit((prev) => {
        if (prev.low === eqSink.split.low && prev.high === eqSink.split.high) return prev;
        return { ...eqSink.split };
      });
    });
  }, [eqSink]);
  return split;
}

export function BandEqPanel() {
  const { runtime, store } = useRuntime();
  const split = useEqSplit(runtime.eqSink);
  const noiseState = useVizStore(store, (s) => s.noiseState);
  const audioStatus = useVizStore(store, (s) => s.audioStatus);
  const canvasRef = useRef(null);
  const idleRef = useRef(null);

  // Latest-value refs for the imperative draw loop (never re-render at ~15fps).
  const noiseStateRef = useRef(noiseState);
  noiseStateRef.current = noiseState;
  const audioStatusRef = useRef(audioStatus);
  audioStatusRef.current = audioStatus;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let eqDrag = null;
    let lastEqBroadcastAt = 0;
    let resizeRaf = 0;
    let watchTimer = 0;

    function drawEq() {
      if (!canvas || !ctx) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const { low, high } = runtime.eqSink.split;
      const lowX = eqHzToX(low, w);
      const highX = eqHzToX(high, w);

      ctx.fillStyle = EQ_COLORS.bassFill;
      ctx.fillRect(0, 0, lowX, h);
      ctx.fillStyle = EQ_COLORS.midFill;
      ctx.fillRect(lowX, 0, highX - lowX, h);
      ctx.fillStyle = EQ_COLORS.highFill;
      ctx.fillRect(highX, 0, w - highX, h);

      ctx.strokeStyle = EQ_COLORS.grid;
      ctx.lineWidth = 1;
      ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      for (const hz of [60, 250, 1000, 4000, 12000]) {
        const x = eqHzToX(hz, w);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h - 11);
        ctx.stroke();
        ctx.fillStyle = EQ_COLORS.label;
        ctx.fillText(formatHz(hz), x, h - 2);
      }
      for (let db = EQ_DB_TOP - 14; db > EQ_DB_BOTTOM; db -= 14) {
        const y = eqDbToY(db, h);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const spec = runtime.eqSink.spectrum;
      const idle = !spec || performance.now() - runtime.eqSink.lastSpectrumAt > 1500;
      if (!idle) {
        const line = new Path2D();
        const area = new Path2D();
        const { freqs, dbs } = spec;
        for (let i = 0; i < freqs.length; i++) {
          const x = eqHzToX(freqs[i], w);
          const y = eqDbToY(dbs[i], h);
          if (i === 0) { line.moveTo(x, y); area.moveTo(x, y); }
          else { line.lineTo(x, y); area.lineTo(x, y); }
        }
        area.lineTo(eqHzToX(freqs[freqs.length - 1], w), h);
        area.lineTo(eqHzToX(freqs[0], w), h);
        area.closePath();

        const regions = [
          { x0: 0, x1: lowX, stroke: EQ_COLORS.bass, fill: EQ_COLORS.bassCurve },
          { x0: lowX, x1: highX, stroke: EQ_COLORS.mid, fill: EQ_COLORS.midCurve },
          { x0: highX, x1: w, stroke: EQ_COLORS.high, fill: EQ_COLORS.highCurve },
        ];
        for (const r of regions) {
          if (r.x1 - r.x0 <= 0) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(r.x0, 0, r.x1 - r.x0, h);
          ctx.clip();
          ctx.fillStyle = r.fill;
          ctx.fill(area);
          ctx.strokeStyle = r.stroke;
          ctx.lineWidth = 1.6;
          ctx.stroke(line);
          ctx.restore();
        }
        runtime.eqSink.drawn += 1;
      }

      if (getNoiseFloorMeta()) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        const steps = 72;
        for (let i = 0; i <= steps; i++) {
          const x = (i / steps) * w;
          const db = sampleNoiseFloorDb(eqXToHz(x, w));
          const y = db === null ? h : eqDbToY(db, h);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (noiseStateRef.current?.status === 'capturing') {
        const s = noiseStateRef.current;
        ctx.fillStyle = 'rgba(5, 6, 8, 0.45)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`CAPTURING NOISE FLOOR… ${Math.min(s.elapsed, s.seconds).toFixed(1)}s`, w / 2, h / 2);
      }

      const drawSeparator = (x, color) => {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, h / 2, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        for (const dx of [-2, 2]) {
          ctx.beginPath();
          ctx.moveTo(x + dx, h / 2 - 3);
          ctx.lineTo(x + dx, h / 2 + 3);
          ctx.stroke();
        }
      };
      drawSeparator(lowX, EQ_COLORS.bass);
      drawSeparator(highX, EQ_COLORS.high);

      if (idleRef.current) {
        idleRef.current.hidden = !idle;
        if (idle) idleRef.current.textContent = audioIdleMessage(audioStatusRef.current);
      }
    }

    const pointerPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, w: Math.max(1, rect.width) };
    };
    const hitSeparator = (x, w) => {
      const RADIUS = 9;
      const splitNow = runtime.eqSink.split;
      const lowX = eqHzToX(splitNow.low, w);
      const highX = eqHzToX(splitNow.high, w);
      const dLow = Math.abs(x - lowX);
      const dHigh = Math.abs(x - highX);
      if (dLow <= RADIUS && dLow <= dHigh) return 'low';
      if (dHigh <= RADIUS) return 'high';
      return null;
    };
    const clampHz = (hz, which) => {
      const L = BAND_SPLIT_LIMITS;
      const s = runtime.eqSink.split;
      if (which === 'low') {
        return Math.min(Math.max(hz, L.lowMin), Math.min(L.lowMax, s.high / L.minRatio));
      }
      return Math.max(Math.min(hz, L.highMax), Math.max(L.highMin, s.low * L.minRatio));
    };

    const onPointerDown = (e) => {
      const { x, w } = pointerPos(e);
      const hit = hitSeparator(x, w);
      if (!hit) return;
      eqDrag = hit;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      const { x, w } = pointerPos(e);
      if (!eqDrag) {
        canvas.style.cursor = hitSeparator(x, w) ? 'col-resize' : 'default';
        return;
      }
      const value = Math.round(clampHz(eqXToHz(x, w), eqDrag));
      runtime.eqSink.setSplit({ [eqDrag]: value });
      drawEq();
      const now = performance.now();
      if (now - lastEqBroadcastAt > 90) {
        lastEqBroadcastAt = now;
        runtime.commands.changeParam('__bands', eqDrag, value);
      }
    };
    const endEqDrag = () => {
      if (!eqDrag) return;
      runtime.commands.changeParam('__bands', eqDrag, runtime.eqSink.split[eqDrag]);
      eqDrag = null;
      canvas.style.cursor = 'default';
    };

    const queueResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; drawEq(); });
    };
    const resizeObserver = new ResizeObserver(queueResize);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', queueResize);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endEqDrag);
    canvas.addEventListener('pointercancel', endEqDrag);

    const unsubscribe = runtime.eqSink.subscribe(drawEq);
    // Periodic redraw so the "waiting for audio" overlay returns when the feed
    // goes stale while the section stays open.
    watchTimer = window.setInterval(drawEq, 600);
    drawEq();

    return () => {
      unsubscribe();
      window.clearInterval(watchTimer);
      window.removeEventListener('resize', queueResize);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endEqDrag);
      canvas.removeEventListener('pointercancel', endEqDrag);
    };
  }, [runtime]);

  const meta = getNoiseFloorMeta();
  const noiseStatus = noiseState?.status || 'idle';

  const noiseStatusText = (() => {
    if (noiseStatus === 'capturing') {
      const s = noiseState;
      return `Capturing noise floor… ${Math.min(s.elapsed, s.seconds).toFixed(1)}s / ${s.seconds.toFixed(0)}s — stay quiet.`;
    }
    if (noiseStatus === 'ready' && meta) {
      const at = new Date(meta.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `Noise floor active — ${meta.seconds.toFixed(1)}s average captured at ${at}. The dashed line shows what gets removed.`;
    }
    if (noiseStatus === 'failed') {
      return noiseState.reason === 'no-audio'
        ? 'Capture failed — no audio input is running in the control panel.'
        : 'Capture failed.';
    }
    return 'No noise profile. Capture a few seconds of silence to subtract room & interface hum from the spectrum.';
  })();

  return (
    <div className="config-section-body">
      <div className="band-eq-wrap">
        <canvas id="band-eq-canvas" ref={canvasRef} />
        <div id="band-eq-idle" className="band-eq-idle" ref={idleRef}>Waiting for audio…</div>
      </div>
      <div className="band-eq-legend">
        <span className="band-chip band-chip-bass"><i></i>Bass <b data-eq-range="bass">{formatHz(EQ_MIN_HZ)}–{formatHz(split.low)} Hz</b></span>
        <span className="band-chip band-chip-mid"><i></i>Mid <b data-eq-range="mid">{formatHz(split.low)} Hz–{formatHz(split.high)}</b></span>
        <span className="band-chip band-chip-high"><i></i>High <b data-eq-range="high">{formatHz(split.high)}–{formatHz(EQ_MAX_HZ)}</b></span>
      </div>
      <div className="band-eq-noise">
        <div id="noise-status" className={`noise-status${noiseStatus === 'ready' && meta ? ' noise-active' : ''}`}>{noiseStatusText}</div>
        <div className="noise-actions">
          <button
            id="noise-capture-btn"
            type="button"
            onClick={() => {
              if (noiseStatus === 'capturing') runtime.commands.noiseCancel();
              else runtime.commands.noiseStart(NOISE_CAPTURE_DEFAULT_SECONDS);
            }}
          >
            {noiseStatus === 'capturing' ? ICON_X : ICON_MIC}
            <span className="btn-label">
              {noiseStatus === 'capturing' ? 'Cancel Capture' : (noiseStatus === 'ready' && meta ? 'Re-capture Noise Floor' : 'Capture Noise Floor')}
            </span>
          </button>
          <button id="noise-clear-btn" type="button" disabled={!meta} onClick={() => runtime.commands.noiseClear()}>Clear</button>
        </div>
      </div>
      <p>Drag the two handles to set the Bass / Mid / High borders. Every effect's Bass, Mid &amp; High controls follow this split. Capture a few seconds of silence to record the input's noise signature — it is subtracted from the live spectrum (dashed line).</p>
    </div>
  );
}
