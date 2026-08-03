import {
  SKETCHES,
  getOrderedSketches,
  getGroups,
  getSketchesByGroup,
  SHORTCUT_COUNT,
  BLEND_ID,
  BLEND_PARAMS,
  BANDS_ID,
  BAND_SPLIT_DEFAULTS,
  POSTFX_ID,
  POSTFX_PARAMS,
} from './sketch-registry.js';
import {
  BAND_SPLIT_LIMITS,
  EQ_MIN_HZ,
  EQ_MAX_HZ,
  EQ_DB_TOP,
  EQ_DB_BOTTOM,
} from './sketches/audio-features.js';
import {
  NOISE_CAPTURE_DEFAULT_SECONDS,
  getNoiseFloorMeta,
  sampleNoiseFloorDb,
} from './noise-floor.js';

// Band colours of the split EQ — same hues as the legend chips in style.css.
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

// Log-frequency <-> pixel mapping shared by drawing and separator dragging.
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

// Format a param value for display based on its step size
function formatParamValue(v, def) {
  const step = def.step ?? 0.01;
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

// Signed display for the post-processing offsets (0 = natural level;
// the sign shows which way the trim pulls).
function formatPostFxValue(v) {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? `+${n}` : String(n);
}

// Pad slot label for a position (0-9 renders as keys 1-9, 0)
function slotLabel(i) {
  return i === 9 ? '0' : String(i + 1);
}

export class ConfigPanel {
  constructor({
    onPatternChange,
    onPatternChangeId,
    onDevicesChange,
    onTakeover,
    onOpenControl,
    onParamChange,
    onReorder,
    onNoiseCapture,
    onNoiseCancel,
    onNoiseClear,
    getParams,
    getPattern,
    isScreen,
    isScreenOnline,
  }) {
    this.onPatternChange = onPatternChange;
    this.onPatternChangeId = onPatternChangeId;
    this.onDevicesChange = onDevicesChange;
    this.onTakeover = onTakeover;
    this.onOpenControl = onOpenControl;
    this.onParamChange = onParamChange;
    this.onReorder = onReorder;
    this.onNoiseCapture = onNoiseCapture;
    this.onNoiseCancel = onNoiseCancel;
    this.onNoiseClear = onNoiseClear;
    this.getParams = getParams;
    this.getPattern = getPattern;
    this.isScreen = isScreen;
    this.isScreenOnline = isScreenOnline;

    this.audioKey = 'viz2_audio_device_id';
    this.videoKey = 'viz2_video_device_id';
    // Persisted open/closed state of the collapsible devices & setup section.
    this.deviceSectionKey = 'viz2_device_setup_open';
    // Persisted open/closed state of the band-split EQ section.
    this.bandEqKey = 'viz2_band_eq_open';
    // Persisted open/closed state of the post-processing section.
    this.postFxKey = 'viz2_post_fx_open';
    this.container = null;
    this.panel = null;
    this.devices = [];
    this.currentPattern = getPattern ? getPattern() : 0;
    this.currentPatternId = null;
    // Merge mode state: two effects selected at once. currentPatternId becomes
    // BLEND_ID so the params list renders the global blend sliders instead.
    this.mergeMode = false;
    this.mergeIndices = null;
    this.mergePatternIds = null;
    // Key used to skip redundant re-renders (see refreshSelection).
    this.renderedKey = null;
    // HTML5 drag state: { type: 'slot'|'library', id, index }
    this.dragSource = null;
    // Current 10 pad ids (kept in sync with the pad render).
    this.slotOrder = [];

    this.init();
  }

  async init() {
    this.container = document.createElement('div');
    this.container.id = 'config-container';
    document.body.appendChild(this.container);

    this.panel = document.createElement('div');
    this.panel.id = 'config-panel';
    this.container.appendChild(this.panel);

    // Initial visibility of the devices & setup section. Fresh profile: open
    // (setup still pending). Once a device has been saved the section is only
    // needed for changes, so collapse it — unless the user pinned a preference.
    // Computed before the template renders so there is no open→closed flash.
    const savedPref = localStorage.getItem(this.deviceSectionKey);
    const hasSavedDevice = !!(localStorage.getItem(this.audioKey) || localStorage.getItem(this.videoKey));
    const deviceSectionOpen =
      savedPref !== null ? savedPref === '1' : !hasSavedDevice;

    // Band-split EQ: a fresh profile starts open so the new tool is visible.
    const bandEqOpen = localStorage.getItem(this.bandEqKey) !== '0';

    // Post Processing: same convention — open until the user collapses it.
    const postFxOpen = localStorage.getItem(this.postFxKey) !== '0';

    this.panel.innerHTML = `
      <div id="effects-pane">
        <h3>Pattern Pad <span class="pad-hint">1–0</span></h3>
        <div id="pattern-pad" class="pattern-pad"></div>
        <h3>Pattern Library</h3>
        <div id="pattern-library" class="pattern-library"></div>
        <p>Drag a pattern from the library onto a pad slot to assign it; drag a slot onto another slot to swap. Keys 1–9 / 0 play a slot. Hold two keys together to blend them — the blend persists until you pick another. While blending: + / − adjust the level, Tab switches Blend / Additive.</p>
      </div>

      <div id="effects-resizer" class="effects-resizer" title="Drag to resize"></div>

      <div id="controls-pane">
        <h3 class="panel-title">VIZ CONTROL</h3>
        <div id="status-line" class="status-line"></div>

        <h3>Parameters</h3>
        <div id="params-list" class="params-list"></div>

        <details id="post-fx" class="config-section"${postFxOpen ? ' open' : ''}>
          <summary class="config-section-header">Post Processing</summary>
          <div class="config-section-body">
            <div id="post-fx-list" class="params-list"></div>
            <div class="config-group actions">
              <button id="post-fx-reset-btn" type="button">↺ Reset to Natural</button>
            </div>
            <p>Global output trim — applied on top of every effect, including blends. 0 is the natural level; negative values reduce, positive values boost.</p>
          </div>
        </details>

        <details id="band-eq" class="config-section"${bandEqOpen ? ' open' : ''}>
          <summary class="config-section-header">Band Split EQ</summary>
          <div class="config-section-body">
            <div class="band-eq-wrap">
              <canvas id="band-eq-canvas"></canvas>
              <div id="band-eq-idle" class="band-eq-idle">Waiting for audio…</div>
            </div>
            <div class="band-eq-legend">
              <span class="band-chip band-chip-bass"><i></i>Bass <b data-eq-range="bass">—</b></span>
              <span class="band-chip band-chip-mid"><i></i>Mid <b data-eq-range="mid">—</b></span>
              <span class="band-chip band-chip-high"><i></i>High <b data-eq-range="high">—</b></span>
            </div>
            <div class="band-eq-noise">
              <div id="noise-status" class="noise-status">No noise profile yet.</div>
              <div class="noise-actions">
                <button id="noise-capture-btn" type="button">🎙 Capture Noise Floor</button>
                <button id="noise-clear-btn" type="button">Clear</button>
              </div>
            </div>
            <p>Drag the two handles to set the Bass / Mid / High borders. Every effect's Bass, Mid &amp; High controls follow this split. Capture a few seconds of silence to record the input's noise signature — it is subtracted from the live spectrum (dashed line).</p>
          </div>
        </details>

        <details id="device-setup" class="config-section"${deviceSectionOpen ? ' open' : ''}>
          <summary class="config-section-header">Devices &amp; Setup</summary>
          <div class="config-section-body">
            <h3>Audio Input</h3>
            <div class="config-group">
              <select id="audio-select" disabled>
                <option value="">Select Audio...</option>
              </select>
            </div>

            <h3>Camera Input</h3>
            <div class="config-group">
              <select id="video-select" disabled>
                <option value="">Select Camera...</option>
              </select>
            </div>

            <div id="setup-notice" class="config-group" style="display: none;">
              <p>Permissions needed for audio &amp; camera selection.</p>
              <button id="setup-all-btn">Initialize</button>
            </div>

            <div class="config-group actions">
              <button id="refresh-devices-btn">Refresh Devices</button>
              <button id="takeover-btn" class="primary">⛶ Take Over as Screen</button>
              <button id="open-control-btn">＋ New Control Panel</button>
            </div>
          </div>
        </details>
      </div>
    `;

    this.renderAll();

    // Persist only real user toggles (the programmatic open from
    // showSetupNotice must not overwrite a deliberate collapse).
    const deviceSection = this.panel.querySelector('#device-setup');
    if (deviceSection) {
      deviceSection.addEventListener('toggle', (e) => {
        if (e.isTrusted) localStorage.setItem(this.deviceSectionKey, deviceSection.open ? '1' : '0');
      });
    }

    const postFxSection = this.panel.querySelector('#post-fx');
    if (postFxSection) {
      postFxSection.addEventListener('toggle', (e) => {
        if (e.isTrusted) localStorage.setItem(this.postFxKey, postFxSection.open ? '1' : '0');
      });
    }

    this.panel.querySelector('#refresh-devices-btn').onclick = () => this.refreshDevices();
    this.panel.querySelector('#takeover-btn').onclick = () => {
      if (this.onTakeover) this.onTakeover();
    };
    this.panel.querySelector('#open-control-btn').onclick = () => {
      if (this.onOpenControl) this.onOpenControl();
    };
    this.panel.querySelector('#setup-all-btn').onclick = () => this.requestPermissions();

    this.initResizer();
    this.initPostFx();
    this.initBandEq();

    this.renderStatus();

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasPermissions = devices.some((d) => d.label !== '');

      if (hasPermissions) {
        this.renderSelectors(devices);
      } else {
        this.showSetupNotice();
      }
    } catch (e) {
      console.error('Auto-detect failed', e);
      this.showSetupNotice();
    }
  }

  showSetupNotice() {
    // Permissions are missing — force the section open so the Initialize
    // button stays reachable even if the user had collapsed it.
    this.openDeviceSection();
    const notice = this.panel.querySelector('#setup-notice');
    if (notice) notice.style.display = 'flex';
  }

  // Force the devices & setup section open (used when permissions are needed).
  openDeviceSection() {
    const section = this.panel.querySelector('#device-setup');
    if (section) section.open = true;
  }

  hideSetupNotice() {
    const notice = this.panel.querySelector('#setup-notice');
    if (notice) notice.style.display = 'none';
  }

  // Draggable divider between the effects list and the controls.
  // The effects pane width is persisted so the split survives reloads.
  initResizer() {
    const resizer = this.panel.querySelector('#effects-resizer');
    const pane = this.panel.querySelector('#effects-pane');
    if (!resizer || !pane) return;

    const saved = parseInt(localStorage.getItem('viz2_effects_width') || '', 10);
    // Default fits exactly 2 columns of 200px+ buttons (2 * 200 + 8 gap + 40 padding)
    this.effectsWidth = Number.isFinite(saved) && saved > 0 ? saved : 460;
    pane.style.width = `${this.effectsWidth}px`;

    // 240 = one 200px button + 40px pane padding (never narrower than a column)
    const MIN_WIDTH = 240;
    const CONTROL_MIN_WIDTH = 340; // keep the controls column usable

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.effectsWidth;
      const maxW = Math.max(MIN_WIDTH, this.panel.clientWidth - CONTROL_MIN_WIDTH);

      const onMove = (ev) => {
        const w = Math.min(maxW, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
        this.effectsWidth = w;
        pane.style.width = `${w}px`;
        localStorage.setItem('viz2_effects_width', String(w));
      };

      const onUp = () => {
        document.body.classList.remove('resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      document.body.classList.add('resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ---------------------------------------------------------------------------
  // Post-processing (global brightness / contrast / saturation trim)
  // Three offset sliders (-100..+100, 0 = natural) that ride the shared param
  // store under POSTFX_ID, exactly like the band-split crossovers. The screen
  // applies them as a CSS filter on its stage wrapper (#screen-wrap); this
  // panel only edits, displays and syncs the values.
  // ---------------------------------------------------------------------------

  initPostFx() {
    const list = this.panel.querySelector('#post-fx-list');
    const resetBtn = this.panel.querySelector('#post-fx-reset-btn');
    if (!list) return;

    const values = this.getParams ? this.getParams(POSTFX_ID) : {};

    for (const def of POSTFX_PARAMS) {
      const val = values[def.key] ?? def.default;

      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML = `
        <div class="param-head">
          <label for="postfx-${def.key}">${def.label}</label>
          <span class="param-value" data-value="${def.key}">${formatPostFxValue(val)}</span>
        </div>
        <input type="range" id="postfx-${def.key}" data-key="${def.key}"
               min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
      `;

      const input = row.querySelector('input');
      const valueEl = row.querySelector('.param-value');

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valueEl.textContent = formatPostFxValue(v);
        if (this.onParamChange) this.onParamChange(POSTFX_ID, def.key, v);
      });

      list.appendChild(row);
    }

    if (resetBtn) {
      resetBtn.onclick = () => {
        for (const def of POSTFX_PARAMS) {
          if (this.onParamChange) this.onParamChange(POSTFX_ID, def.key, def.default);
        }
      };
    }
  }

  // Sync slider positions/values for a post-fx change from another window
  // (or our own broadcast round-trip).
  setPostFx(values = {}) {
    const list = this.panel.querySelector('#post-fx-list');
    if (!list) return;
    for (const [key, v] of Object.entries(values)) {
      const input = list.querySelector(`input[data-key="${key}"]`);
      if (input) input.value = v;
      const valueEl = list.querySelector(`.param-value[data-value="${key}"]`);
      if (valueEl) valueEl.textContent = formatPostFxValue(v);
    }
  }

  // ---------------------------------------------------------------------------
  // Band-split EQ (Ableton-style log spectrum + draggable bass/mid/high borders)
  // The screen broadcasts a compact log-spaced dB spectrum (~15fps); this
  // section draws it with the three band regions and two draggable crossover
  // handles. Moving a handle broadcasts the new crossover as the global
  // BANDS_ID param set, and the screen retunes its feature extractor.
  // ---------------------------------------------------------------------------

  initBandEq() {
    this.eqSection = this.panel.querySelector('#band-eq');
    this.eqCanvas = this.panel.querySelector('#band-eq-canvas');
    this.eqCtx = this.eqCanvas ? this.eqCanvas.getContext('2d') : null;
    this.eqIdle = this.panel.querySelector('#band-eq-idle');

    const stored = this.getParams ? this.getParams(BANDS_ID) : null;
    this.eqSplit = {
      low: Number.isFinite(Number(stored?.low)) ? Number(stored.low) : BAND_SPLIT_DEFAULTS.low,
      high: Number.isFinite(Number(stored?.high)) ? Number(stored.high) : BAND_SPLIT_DEFAULTS.high,
    };
    this.eqSpectrum = null;
    this.lastSpectrumAt = 0;
    // e2e probe: frames drawn with live spectrum data
    this.eqDrawn = 0;
    this.eqDrag = null;
    this.lastEqBroadcastAt = 0;
    this.eqWatchTimer = 0;

    // Noise-floor capture UI; live state arrives via 'noise-floor' broadcasts
    // from the screen, the stored profile is read straight from localStorage.
    this.noiseStatusEl = this.panel.querySelector('#noise-status');
    this.noiseCaptureBtn = this.panel.querySelector('#noise-capture-btn');
    this.noiseClearBtn = this.panel.querySelector('#noise-clear-btn');
    this.noiseState = { status: getNoiseFloorMeta() ? 'ready' : 'idle' };
    if (this.noiseCaptureBtn) {
      this.noiseCaptureBtn.onclick = () => {
        if (this.noiseState.status === 'capturing') {
          if (this.onNoiseCancel) this.onNoiseCancel();
        } else if (this.onNoiseCapture) {
          this.onNoiseCapture(NOISE_CAPTURE_DEFAULT_SECONDS);
        }
      };
    }
    if (this.noiseClearBtn) {
      this.noiseClearBtn.onclick = () => {
        if (this.onNoiseClear) this.onNoiseClear();
      };
    }
    this.updateNoiseUi();

    if (!this.eqSection || !this.eqCanvas) return;

    this.eqSection.addEventListener('toggle', () => {
      localStorage.setItem(this.bandEqKey, this.eqSection.open ? '1' : '0');
      if (this.eqSection.open) {
        this.drawEq();
        this.startEqWatch();
      } else {
        this.stopEqWatch();
      }
    });

    window.addEventListener('resize', () => this.drawEq());

    this.eqCanvas.addEventListener('pointerdown', (e) => {
      const { x, w } = this.eqPointerPos(e);
      const hit = this.eqHitSeparator(x, w);
      if (!hit) return;
      this.eqDrag = hit;
      this.eqCanvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.eqCanvas.addEventListener('pointermove', (e) => {
      const { x, w } = this.eqPointerPos(e);
      if (!this.eqDrag) {
        this.eqCanvas.style.cursor = this.eqHitSeparator(x, w) ? 'col-resize' : 'default';
        return;
      }
      // Live local update for smooth dragging; the broadcast is throttled.
      this.eqSplit[this.eqDrag] = Math.round(this.eqClampHz(eqXToHz(x, w), this.eqDrag));
      this.updateEqLegend();
      this.drawEq();
      const now = performance.now();
      if (now - this.lastEqBroadcastAt > 90) {
        this.lastEqBroadcastAt = now;
        this.broadcastEqSplit(this.eqDrag);
      }
    });

    const endEqDrag = () => {
      if (!this.eqDrag) return;
      // Always commit the final value even if the throttle swallowed it
      this.broadcastEqSplit(this.eqDrag);
      this.eqDrag = null;
      this.eqCanvas.style.cursor = 'default';
    };
    this.eqCanvas.addEventListener('pointerup', endEqDrag);
    this.eqCanvas.addEventListener('pointercancel', endEqDrag);

    this.updateEqLegend();
    this.drawEq();
    if (this.eqSection.open) this.startEqWatch();
  }

  // Redraw periodically while open so the "waiting for audio" overlay comes
  // back if the spectrum feed stops (screen closed, audio device stopped).
  startEqWatch() {
    if (this.eqWatchTimer) return;
    this.eqWatchTimer = setInterval(() => {
      if (this.eqSection && this.eqSection.open) this.drawEq();
    }, 600);
  }

  stopEqWatch() {
    if (this.eqWatchTimer) clearInterval(this.eqWatchTimer);
    this.eqWatchTimer = 0;
  }

  // Spectrum message from the screen (see main.js spectrum broadcast).
  handleSpectrum(msg) {
    if (!msg || !msg.freqs || !msg.dbs || msg.freqs.length !== msg.dbs.length || !msg.freqs.length) return;
    this.eqSpectrum = msg;
    this.lastSpectrumAt = performance.now();
    if (this.eqSection && this.eqSection.open) this.drawEq();
  }

  // Noise-floor lifecycle broadcast from the screen (capturing/ready/failed/
  // cancelled/cleared). The profile itself is reloaded from localStorage by
  // main.js before this runs.
  setNoiseState(msg = {}) {
    switch (msg.status) {
      case 'capturing':
        this.noiseState = {
          status: 'capturing',
          progress: Number(msg.progress) || 0,
          elapsed: Number(msg.elapsed) || 0,
          seconds: Number(msg.seconds) || NOISE_CAPTURE_DEFAULT_SECONDS,
        };
        break;
      case 'ready':
        this.noiseState = { status: 'ready' };
        break;
      case 'failed':
        this.noiseState = { status: 'failed', reason: msg.reason };
        break;
      case 'cancelled':
      case 'cleared':
        this.noiseState = { status: getNoiseFloorMeta() ? 'ready' : 'idle' };
        break;
      default:
        return;
    }
    this.updateNoiseUi();
    if (this.eqSection && this.eqSection.open) this.drawEq();
  }

  updateNoiseUi() {
    if (!this.noiseStatusEl) return;
    const st = this.noiseState?.status || 'idle';
    const meta = getNoiseFloorMeta();

    if (st === 'capturing') {
      const s = this.noiseState;
      this.noiseStatusEl.textContent =
        `Capturing noise floor… ${Math.min(s.elapsed, s.seconds).toFixed(1)}s / ${s.seconds.toFixed(0)}s — stay quiet.`;
      this.noiseStatusEl.classList.remove('noise-active');
      if (this.noiseCaptureBtn) {
        this.noiseCaptureBtn.textContent = '✕ Cancel Capture';
        this.noiseCaptureBtn.disabled = false;
      }
      if (this.noiseClearBtn) this.noiseClearBtn.disabled = true;
      return;
    }

    if (this.noiseClearBtn) this.noiseClearBtn.disabled = !meta;

    if (st === 'ready' && meta) {
      const at = new Date(meta.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.noiseStatusEl.textContent =
        `Noise floor active — ${meta.seconds.toFixed(1)}s average captured at ${at}. The dashed line shows what gets removed.`;
      this.noiseStatusEl.classList.add('noise-active');
      if (this.noiseCaptureBtn) this.noiseCaptureBtn.textContent = '🎙 Re-capture Noise Floor';
      return;
    }

    this.noiseStatusEl.classList.remove('noise-active');
    if (st === 'failed') {
      this.noiseStatusEl.textContent = this.noiseState.reason === 'no-audio'
        ? 'Capture failed — the screen has no audio input running.'
        : 'Capture failed.';
    } else {
      this.noiseStatusEl.textContent =
        'No noise profile. Capture a few seconds of silence to subtract room & interface hum from the spectrum.';
    }
    if (this.noiseCaptureBtn) this.noiseCaptureBtn.textContent = '🎙 Capture Noise Floor';
  }

  // Crossover change arriving from another window (or our own round-trip).
  setEqSplit(values = {}) {
    let changed = false;
    for (const key of ['low', 'high']) {
      const v = Math.round(Number(values[key]));
      if (Number.isFinite(v) && v !== this.eqSplit[key]) {
        this.eqSplit[key] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this.updateEqLegend();
    this.drawEq();
  }

  broadcastEqSplit(key) {
    if (this.onParamChange) this.onParamChange(BANDS_ID, key, this.eqSplit[key]);
  }

  updateEqLegend() {
    if (!this.panel) return;
    const { low, high } = this.eqSplit;
    const set = (name, text) => {
      const el = this.panel.querySelector(`[data-eq-range="${name}"]`);
      if (el) el.textContent = text;
    };
    set('bass', `${formatHz(EQ_MIN_HZ)}–${formatHz(low)} Hz`);
    set('mid', `${formatHz(low)} Hz–${formatHz(high)}`);
    set('high', `${formatHz(high)}–${formatHz(EQ_MAX_HZ)}`);
  }

  eqPointerPos(e) {
    const rect = this.eqCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, w: Math.max(1, rect.width) };
  }

  eqHitSeparator(x, w) {
    const RADIUS = 9;
    const lowX = eqHzToX(this.eqSplit.low, w);
    const highX = eqHzToX(this.eqSplit.high, w);
    const dLow = Math.abs(x - lowX);
    const dHigh = Math.abs(x - highX);
    if (dLow <= RADIUS && dLow <= dHigh) return 'low';
    if (dHigh <= RADIUS) return 'high';
    return null;
  }

  eqClampHz(hz, which) {
    const L = BAND_SPLIT_LIMITS;
    if (which === 'low') {
      return Math.min(Math.max(hz, L.lowMin), Math.min(L.lowMax, this.eqSplit.high / L.minRatio));
    }
    return Math.max(Math.min(hz, L.highMax), Math.max(L.highMin, this.eqSplit.low * L.minRatio));
  }

  drawEq() {
    const canvas = this.eqCanvas;
    const ctx = this.eqCtx;
    if (!canvas || !ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    // HiDPI sizing (cheap no-op when nothing changed)
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { low, high } = this.eqSplit;
    const lowX = eqHzToX(low, w);
    const highX = eqHzToX(high, w);

    // 1) Band region tints: bass | mid | high
    ctx.fillStyle = EQ_COLORS.bassFill;
    ctx.fillRect(0, 0, lowX, h);
    ctx.fillStyle = EQ_COLORS.midFill;
    ctx.fillRect(lowX, 0, highX - lowX, h);
    ctx.fillStyle = EQ_COLORS.highFill;
    ctx.fillRect(highX, 0, w - highX, h);

    // 2) Musical grid (log frequency ticks + dB lines)
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

    // 3) Live spectrum curve, coloured per band (Ableton style)
    const spec = this.eqSpectrum;
    const idle = !spec || performance.now() - this.lastSpectrumAt > 1500;
    if (!idle) {
      const line = new Path2D();
      const area = new Path2D();
      const { freqs, dbs } = spec;
      for (let i = 0; i < freqs.length; i++) {
        const x = eqHzToX(freqs[i], w);
        const y = eqDbToY(dbs[i], h);
        if (i === 0) {
          line.moveTo(x, y);
          area.moveTo(x, y);
        } else {
          line.lineTo(x, y);
          area.lineTo(x, y);
        }
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
      this.eqDrawn += 1;
    }

    // 3b) Captured noise floor as a faint dashed curve — the signature that
    // is being subtracted from the live spectrum above.
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

    // 3c) Dim + label the canvas while a capture is running
    if (this.noiseState?.status === 'capturing') {
      ctx.fillStyle = 'rgba(5, 6, 8, 0.45)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `CAPTURING NOISE FLOOR… ${Math.min(this.noiseState.elapsed, this.noiseState.seconds).toFixed(1)}s`,
        w / 2,
        h / 2,
      );
    }

    // 4) Crossover separators with grab handles
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

    // 5) Idle overlay when the spectrum feed is missing/stale
    if (this.eqIdle) this.eqIdle.hidden = !idle;
  }

  // ---------------------------------------------------------------------------
  // Pattern pad + library rendering
  // ---------------------------------------------------------------------------

  // Render the fixed pad AND the grouped library, then re-apply the selection.
  renderAll() {
    this.renderPatternPad();
    this.renderLibrary();
    this.applySelection();
  }

  // Fixed 10-slot pad (keys 1-9, 0). Always visible; never scrolls.
  renderPatternPad() {
    const pad = this.panel.querySelector('#pattern-pad');
    pad.innerHTML = '';

    const ordered = getOrderedSketches();
    this.slotOrder = ordered.map((s) => s.id);

    for (let i = 0; i < SHORTCUT_COUNT; i++) {
      const sketch = ordered[i];
      const btn = document.createElement('button');
      btn.className = 'pattern-btn slot-btn';
      btn.dataset.id = sketch ? sketch.id : '';
      btn.dataset.index = String(i);
      btn.draggable = true;
      btn.innerHTML = `<span class="pattern-key">${slotLabel(i)}</span><span class="pattern-name">${sketch ? sketch.name : '—'}</span><span class="drag-handle" title="Drag to swap slots">⠿</span>`;

      btn.onclick = () => {
        if (!sketch) return;
        this.setPattern(i);
        if (this.onPatternChange) this.onPatternChange(i);
      };
      this.attachDrag(btn);
      pad.appendChild(btn);
    }
  }

  // Scrollable library: every pattern grouped by category. Items assigned to
  // the pad show a slot-number badge; unassigned items stay playable.
  renderLibrary() {
    const lib = this.panel.querySelector('#pattern-library');
    lib.innerHTML = '';

    const slotOf = new Map(this.slotOrder.map((id, i) => [id, i]));

    for (const group of getGroups()) {
      const sketches = getSketchesByGroup(group);
      if (sketches.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'library-group';

      const header = document.createElement('div');
      header.className = 'library-group-header';
      header.textContent = group;
      section.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'library-group-grid';

      for (const sketch of sketches) {
        const btn = document.createElement('button');
        btn.className = 'pattern-btn library-btn';
        btn.dataset.id = sketch.id;
        btn.draggable = true;

        const slotIdx = slotOf.get(sketch.id);
        const badge =
          slotIdx !== undefined
            ? `<span class="slot-badge" title="Assigned to pad slot ${slotLabel(slotIdx)}">${slotLabel(slotIdx)}</span>`
            : '';
        const cam = sketch.camera
          ? '<span class="camera-badge" title="Uses camera input">📷</span>'
          : '';
        btn.innerHTML = `<span class="pattern-name">${sketch.name}</span>${cam}${badge}<span class="drag-handle" title="Drag to pad slot">⠿</span>`;

        btn.onclick = () => {
          if (slotIdx !== undefined) {
            // Assigned pattern -> play through its pad slot (keeps indices in sync)
            this.setPattern(slotIdx);
            if (this.onPatternChange) this.onPatternChange(slotIdx);
          } else {
            // Unassigned pattern -> play by id (stays outside the pad)
            this.setPatternById(sketch.id);
            if (this.onPatternChangeId) this.onPatternChangeId(sketch.id);
          }
        };
        this.attachDrag(btn);
        grid.appendChild(btn);
      }

      section.appendChild(grid);
      lib.appendChild(section);
    }
  }

  // HTML5 drag & drop:
  //   library item -> slot : assign (replace the slot's pattern; if the item is
  //                           already assigned to another slot, the two swap)
  //   slot -> slot         : swap the two pad positions
  //   anything -> library  : no-op
  attachDrag(btn) {
    btn.addEventListener('dragstart', (e) => {
      this.dragSource = {
        type: btn.dataset.index !== undefined ? 'slot' : 'library',
        id: btn.dataset.id,
        index: btn.dataset.index !== undefined ? parseInt(btn.dataset.index, 10) : null,
      };
      btn.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', btn.dataset.id);
      }
    });

    btn.addEventListener('dragend', () => {
      this.dragSource = null;
      btn.classList.remove('dragging');
      this.clearDropTargets();
    });

    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.clearDropTargets();
      if (this.dragSource && btn.dataset.id !== this.dragSource.id) {
        btn.classList.add('drop-target');
      }
    });

    btn.addEventListener('dragleave', () => btn.classList.remove('drop-target'));

    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      this.clearDropTargets();
      const source = this.dragSource;
      const targetIndex = btn.dataset.index !== undefined ? parseInt(btn.dataset.index, 10) : null;
      if (!source || targetIndex === null) return;

      const ids = getOrderedSketches().map((s) => s.id);
      const existing = ids.indexOf(source.id);
      if (existing >= 0) {
        // Dragging an assigned pattern -> swap the two positions
        [ids[existing], ids[targetIndex]] = [ids[targetIndex], ids[existing]];
      } else {
        // Fresh library pattern -> replace the slot's contents
        ids[targetIndex] = source.id;
      }
      this.commitOrder(ids);
    });
  }

  clearDropTargets() {
    this.panel.querySelectorAll('.pattern-btn.drop-target').forEach((b) => b.classList.remove('drop-target'));
  }

  // Persist (via callback) and re-render after a pad edit, keeping the active
  // selection on the same pattern by id (positions shift on assign/swap).
  commitOrder(ids) {
    if (this.onReorder) this.onReorder(ids);
    this.setOrder();
  }

  setOrder() {
    this.renderAll();

    if (this.mergeMode && this.mergePatternIds) {
      const ordered = getOrderedSketches();
      const a = ordered.findIndex((s) => s.id === this.mergePatternIds[0]);
      const b = ordered.findIndex((s) => s.id === this.mergePatternIds[1]);
      if (a >= 0 && b >= 0) this.setMerge([a, b]);
      return;
    }

    const activeId = this.currentPatternId;
    if (!activeId || activeId === BLEND_ID) return;
    const idx = getOrderedSketches().findIndex((s) => s.id === activeId);
    if (idx >= 0) this.setPattern(idx);
    else this.setPatternById(activeId);
  }

  // Re-apply whatever the current selection is (single effect or a merge)
  applySelection() {
    if (this.mergeMode && this.mergeIndices) {
      this.setMerge(this.mergeIndices);
    } else if (this.currentPattern >= 0) {
      this.setPattern(this.currentPattern);
    } else if (this.currentPatternId) {
      this.setPatternById(this.currentPatternId);
    }
  }

  // Select a pad slot (clears any merge)
  setPattern(index) {
    this.currentPattern = index;
    this.mergeMode = false;
    this.mergeIndices = null;
    this.mergePatternIds = null;
    const ordered = getOrderedSketches();
    this.currentPatternId = ordered[index] ? ordered[index].id : null;
    this.refreshSelection();
  }

  // Select a library-only pattern by id (clears any merge)
  setPatternById(id) {
    this.currentPattern = -1;
    this.mergeMode = false;
    this.mergeIndices = null;
    this.mergePatternIds = null;
    this.currentPatternId = id;
    this.refreshSelection();
  }

  // Select two effects to merge. The params list switches to the global blend
  // sliders (currentPatternId -> BLEND_ID) and both pad slots highlight.
  setMerge(merge) {
    if (!merge || merge.length !== 2) return;
    this.mergeMode = true;
    this.mergeIndices = [...merge];
    const ordered = getOrderedSketches();
    this.mergePatternIds = merge.map((i) => (ordered[i] ? ordered[i].id : null));
    this.currentPattern = merge[0];
    this.currentPatternId = BLEND_ID;
    this.refreshSelection();
  }

  // Highlight the right buttons and rebuild the sliders only when the
  // selection actually changed. syncUI() calls the setters after EVERY
  // broadcast message — including the 'params' message a slider drag itself
  // emits — and rebuilding the list destroys the <input type="range">
  // mid-drag, so click-and-drag used to stop after a single step.
  refreshSelection() {
    this.panel.querySelectorAll('.pattern-btn').forEach((btn) => {
      btn.classList.remove('active', 'merge-active');
    });

    if (this.mergeMode && this.mergeIndices) {
      // Both pad slots in the blend get the purple highlight
      this.panel.querySelectorAll('#pattern-pad .pattern-btn').forEach((btn) => {
        const idx = parseInt(btn.dataset.index, 10);
        btn.classList.toggle('merge-active', this.mergeIndices.includes(idx));
      });
    } else if (this.currentPatternId) {
      // Single selection: highlight the slot it lives in, or the library item
      const slotIdx = this.slotOrder.indexOf(this.currentPatternId);
      if (slotIdx >= 0) {
        const slot = this.panel.querySelector(`#pattern-pad .pattern-btn[data-index="${slotIdx}"]`);
        if (slot) slot.classList.add('active');
      } else {
        this.panel
          .querySelectorAll(`#pattern-library .pattern-btn[data-id="${this.currentPatternId}"]`)
          .forEach((btn) => btn.classList.add('active'));
      }
    }

    const key = this.mergeMode ? `merge:${this.mergeIndices.join(',')}` : `single:${this.currentPatternId}`;
    if (this.renderedKey !== key) {
      this.renderedKey = key;
      this.renderParams();
    }
  }

  // Rebuild the slider list for the currently selected effect — or the global
  // blend sliders while two effects are merged.
  renderParams() {
    const list = this.panel.querySelector('#params-list');
    if (!list) return;

    list.innerHTML = '';

    if (this.mergeMode) {
      this.renderBlendParams(list);
      return;
    }

    const ordered = getOrderedSketches();
    const sketch =
      this.currentPattern >= 0
        ? ordered[this.currentPattern]
        : SKETCHES.find((s) => s.id === this.currentPatternId);
    const defs = (sketch && sketch.params) || [];
    if (defs.length === 0) {
      list.innerHTML = '<p class="param-empty">No parameters for this effect.</p>';
      return;
    }

    const values = this.getParams ? this.getParams(this.currentPatternId) : {};

    for (const def of defs) {
      const val = values[def.key] ?? def.default;

      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML = `
        <div class="param-head">
          <label for="param-${def.key}">${def.label}</label>
          <span class="param-value" data-value="${def.key}">${formatParamValue(val, def)}</span>
        </div>
        <input type="range" id="param-${def.key}" data-key="${def.key}"
               min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
      `;

      const input = row.querySelector('input');
      const valueEl = row.querySelector('.param-value');

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valueEl.textContent = formatParamValue(v, def);
        if (this.onParamChange) this.onParamChange(this.currentPatternId, def.key, v);
      });

      list.appendChild(row);
    }
  }

  // Blend controls replace the individual effect params while merging: a
  // Blend / Additive mode toggle plus ONE level slider that drives whichever
  // mode is active (crossfade mix or additive strength).
  renderBlendParams(list) {
    const ordered = getOrderedSketches();
    const nameA = ordered[this.mergeIndices[0]] ? ordered[this.mergeIndices[0]].name : 'Effect';
    const nameB = ordered[this.mergeIndices[1]] ? ordered[this.mergeIndices[1]].name : 'Effect';

    const header = document.createElement('div');
    header.className = 'blend-header';
    header.innerHTML = `<span>Blend</span><span class="blend-names">${nameA} + ${nameB}</span>`;
    list.appendChild(header);

    const values = this.getParams ? this.getParams(BLEND_ID) : {};
    const additive = values.mode === 1;

    // Mode toggle (Blend | Additive)
    const toggle = document.createElement('div');
    toggle.className = 'blend-mode-toggle';
    toggle.innerHTML = `
      <button type="button" class="blend-mode-btn${additive ? '' : ' active'}" data-mode="blend">Blend</button>
      <button type="button" class="blend-mode-btn${additive ? ' active' : ''}" data-mode="additive">Additive</button>
    `;
    toggle.querySelectorAll('.blend-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode === 'additive' ? 1 : 0;
        if (this.onParamChange) this.onParamChange(BLEND_ID, 'mode', mode);
      });
    });
    list.appendChild(toggle);

    // Single level slider for the active mode
    const activeDef = BLEND_PARAMS.find((d) => d.key === (additive ? 'add' : 'mix'));
    const val = values[activeDef.key] ?? activeDef.default;

    const row = document.createElement('div');
    row.className = 'param-row';
    row.innerHTML = `
      <div class="param-head">
        <label for="param-${activeDef.key}">${activeDef.label}</label>
        <span class="param-value" data-value="${activeDef.key}">${formatParamValue(val, activeDef)}</span>
      </div>
      <input type="range" id="param-${activeDef.key}" data-key="${activeDef.key}"
             min="${activeDef.min}" max="${activeDef.max}" step="${activeDef.step}" value="${val}">
    `;

    const input = row.querySelector('input');
    const valueEl = row.querySelector('.param-value');

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      valueEl.textContent = formatParamValue(v, activeDef);
      if (this.onParamChange) this.onParamChange(BLEND_ID, activeDef.key, v);
    });

    list.appendChild(row);
  }

  // Sync slider positions/values for a param change coming from another window
  applyParam(id, values) {
    // The post-processing trim is global — independent of the selection
    if (id === POSTFX_ID) {
      this.setPostFx(values);
      return;
    }

    // The band-split crossovers are global — independent of the selection
    if (id === BANDS_ID) {
      this.setEqSplit(values);
      return;
    }

    if (id !== this.currentPatternId) return;

    // Mode switches swap which level slider is shown — rebuild the blend section
    if (this.mergeMode && 'mode' in values) {
      this.renderParams();
      return;
    }

    const list = this.panel.querySelector('#params-list');
    if (!list) return;

    const defs = this.mergeMode
      ? BLEND_PARAMS
      : this.currentPattern >= 0
        ? (getOrderedSketches()[this.currentPattern]?.params || [])
        : (SKETCHES.find((s) => s.id === this.currentPatternId)?.params || []);

    for (const [key, v] of Object.entries(values)) {
      const input = list.querySelector(`input[data-key="${key}"]`);
      if (input) input.value = v;

      const valueEl = list.querySelector(`.param-value[data-value="${key}"]`);
      const def = defs.find((d) => d.key === key);
      if (valueEl && def) valueEl.textContent = formatParamValue(v, def);
    }
  }

  setScreenOnline(online) {
    this.screenOnline = online;
    this.renderStatus();
  }

  renderStatus() {
    const el = this.panel.querySelector('#status-line');
    if (!el) return;

    const isScreen = this.isScreen ? this.isScreen() : false;
    const online = this.screenOnline !== undefined ? this.screenOnline : (this.isScreenOnline ? this.isScreenOnline() : false);

    el.innerHTML = `
      <span class="badge ${isScreen ? 'badge-screen' : 'badge-control'}">${isScreen ? 'SCREEN' : 'CONTROL'}</span>
      <span class="badge ${online ? 'badge-online' : 'badge-offline'}">SCREEN ${online ? 'ONLINE' : 'OFFLINE'}</span>
    `;
  }

  async requestPermissions() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      await this.refreshDevices();
      this.hideSetupNotice();
    } catch (e) {
      console.error(e);
    }
  }

  async refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.renderSelectors(devices);
  }

  renderSelectors(devices) {
    this.devices = devices;
    this.hideSetupNotice();

    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');

    const audioSelect = this.panel.querySelector('#audio-select');
    const videoSelect = this.panel.querySelector('#video-select');

    audioSelect.disabled = false;
    videoSelect.disabled = false;
    audioSelect.innerHTML = '<option value="">Select Audio...</option>';
    videoSelect.innerHTML = '<option value="">Select Camera...</option>';

    const savedAudioId = localStorage.getItem(this.audioKey);
    const savedVideoId = localStorage.getItem(this.videoKey);

    audioInputs.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Audio ${d.deviceId.slice(0, 5)}`;
      audioSelect.appendChild(opt);
      if (savedAudioId && d.deviceId === savedAudioId) opt.selected = true;
    });

    videoInputs.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Camera ${d.deviceId.slice(0, 5)}`;
      videoSelect.appendChild(opt);
      if (savedVideoId && d.deviceId === savedVideoId) opt.selected = true;
    });

    audioSelect.onchange = (e) => this.handleAudioChange(e.target.value);
    videoSelect.onchange = (e) => this.handleVideoChange(e.target.value);
  }

  handleAudioChange(id) {
    if (!id) return;
    localStorage.setItem(this.audioKey, id);
    if (this.onDevicesChange) this.onDevicesChange();
  }

  handleVideoChange(id) {
    if (!id) return;
    localStorage.setItem(this.videoKey, id);
    if (this.onDevicesChange) this.onDevicesChange();
  }
}
