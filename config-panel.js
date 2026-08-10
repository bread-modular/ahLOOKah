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

// Inline stroke icons for panel buttons (styled via .btn-icon in style.css) —
// they sit on the text baseline at a matching size, unlike emoji/text glyphs.
const ICON_RESET =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';
const ICON_MIC =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
const ICON_X =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const ICON_MONITOR =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>';

// Persist a <details> section's open state synchronously on the user's click.
// The native `toggle` event is dispatched from a queued task, so a reload
// racing the click can preempt it and lose the persisted state.
function persistSectionOpen(section, key) {
  const summary = section && section.querySelector('summary');
  if (!summary) return;
  summary.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    // The default action (the actual open flip) runs after this handler,
    // so store the state the section is about to have.
    localStorage.setItem(key, section.open ? '0' : '1');
  });
}

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
    onCuePatternChange,
    onCuePatternChangeId,
    onDevicesChange,
    onOpenScreen,
    onCuePrimary,
    onCueCancel,
    onParamChange,
    onReorder,
    onNoiseCapture,
    onNoiseCancel,
    onNoiseClear,
    onPreviewReady,
    onPreviewChange,
    getParams,
    getPattern,
    isScreen,
    isScreenOnline,
  }) {
    this.onPatternChange = onPatternChange;
    this.onPatternChangeId = onPatternChangeId;
    this.onCuePatternChange = onCuePatternChange;
    this.onCuePatternChangeId = onCuePatternChangeId;
    this.onDevicesChange = onDevicesChange;
    this.onOpenScreen = onOpenScreen;
    this.onCuePrimary = onCuePrimary;
    this.onCueCancel = onCueCancel;
    this.onParamChange = onParamChange;
    this.onReorder = onReorder;
    this.onNoiseCapture = onNoiseCapture;
    this.onNoiseCancel = onNoiseCancel;
    this.onNoiseClear = onNoiseClear;
    this.onPreviewReady = onPreviewReady;
    this.onPreviewChange = onPreviewChange;
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
    this.screenOnline = isScreen ? Boolean(isScreen()) : false;
    // Audio capture belongs to a control window and remains available even when
    // no output screen is open, so its lifecycle is independent of screen state.
    this.audioStatus = { status: 'idle' };
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
    // The screen owns these snapshots. `currentPattern*` above represent the
    // current editing scope; these two selections are retained independently so
    // operators can always see LIVE and CUE at the same time.
    const initialId = getOrderedSketches()[this.currentPattern]?.id || null;
    this.liveSelection = initialId ? { ids: [initialId], merge: false } : { ids: [], merge: false };
    this.cueState = null;
    this.lastCueRevision = null;
    this.lastTransportNotice = '';

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
      <div id="preview-pane">
        <section class="preview-section" aria-labelledby="preview-title">
          <div class="preview-heading">
            <h3 id="preview-title">LIVE PREVIEW</h3>
            <span id="preview-renderer" class="preview-renderer">LIVE RENDER</span>
          </div>
          <div class="preview-surface">
            <div id="preview-stage" class="preview-stage" aria-label="Live visualization preview"></div>
            <div id="cue-preview-controls" class="cue-preview-controls" aria-label="Cue transport controls" hidden>
              <span id="cue-preview-phase" class="cue-preview-phase">CUE / WARMING</span>
              <div class="cue-preview-actions">
                <button id="cue-primary" class="cue-primary" type="button" disabled>
                  <span class="transport-action">GO LIVE</span><kbd>ENTER</kbd>
                </button>
                <button id="cue-cancel" class="cue-cancel" type="button" disabled>
                  <span class="transport-action">CANCEL</span><kbd>ESC</kbd>
                </button>
              </div>
            </div>
          </div>
          <div id="cue-live-region" class="sr-only" aria-live="polite" aria-atomic="true"></div>
        </section>

        <section class="pad-section" aria-labelledby="pad-title">
          <h3 id="pad-title">Pattern Pad <span class="pad-hint">1–0</span></h3>
          <div id="pattern-pad" class="pattern-pad"></div>
        </section>
      </div>

      <div id="library-pane">
        <h3>Pattern Library</h3>
        <div id="pattern-library" class="pattern-library"></div>
        <p>Drag a pattern from the library onto a pad slot to assign it; drag a slot onto another slot to swap. Keys 1–9 / 0 play a slot. Shift-click a pattern or press Shift + 1–0 to stage a CUE; Enter goes live and Esc cancels. Hold two unmodified number keys together to blend them — the blend persists until you pick another. While blending: + / − adjust the level, Tab switches Blend / Additive.</p>
      </div>

      <div id="controls-pane">
        <h3 class="panel-title">VIZ CONTROL</h3>
        <div id="status-line" class="status-line"></div>

        <h3 id="params-heading">Parameters</h3>
        <div id="params-list" class="params-list"></div>

        <details id="post-fx" class="config-section"${postFxOpen ? ' open' : ''}>
          <summary class="config-section-header">Post Processing</summary>
          <div class="config-section-body">
            <div id="post-fx-list" class="params-list"></div>
            <div class="config-group actions">
              <button id="post-fx-reset-btn" type="button">${ICON_RESET}Reset to Natural</button>
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
                <button id="noise-capture-btn" type="button">${ICON_MIC}<span class="btn-label">Capture Noise Floor</span></button>
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
            </div>
          </div>
        </details>
      </div>
    `;

    if (this.onPreviewReady) this.onPreviewReady(this.panel.querySelector('#preview-stage'));

    this.renderAll();

    // Persist only real user toggles (the programmatic open from
    // showSetupNotice must not overwrite a deliberate collapse).
    persistSectionOpen(this.panel.querySelector('#device-setup'), this.deviceSectionKey);
    persistSectionOpen(this.panel.querySelector('#post-fx'), this.postFxKey);

    this.panel.querySelector('#refresh-devices-btn').onclick = () => this.refreshDevices();
    this.panel.querySelector('#setup-all-btn').onclick = () => this.requestPermissions();

    this.initPostFx();
    this.initBandEq();

    this.renderStatus();
    const cuePrimary = this.panel.querySelector('#cue-primary');
    const cueCancel = this.panel.querySelector('#cue-cancel');
    if (cuePrimary) cuePrimary.onclick = () => {
      if (this.onCuePrimary) this.onCuePrimary();
    };
    if (cueCancel) cueCancel.onclick = () => {
      if (this.onCueCancel) this.onCueCancel();
    };
    this.renderTransport();

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
  // The capture-owning control broadcasts a compact log-spaced spectrum
  // (~15fps); this section draws it with three regions and two draggable
  // crossover handles. Moving one updates every window's feature extractor.
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

    // Noise-floor capture UI; live state arrives from the audio-owning panel,
    // while the stored profile is read straight from localStorage.
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

    persistSectionOpen(this.eqSection, this.bandEqKey);
    this.eqSection.addEventListener('toggle', () => {
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
  // back if the capture owner closes or its audio device stops.
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

  // Spectrum message from the capture-owning control (see main.js).
  handleSpectrum(msg) {
    if (!msg || !msg.freqs || !msg.dbs || msg.freqs.length !== msg.dbs.length || !msg.freqs.length) return;
    this.eqSpectrum = msg;
    this.lastSpectrumAt = performance.now();
    // The status event may have been emitted before this panel opened. A real
    // spectrum is definitive proof that capture + Web Audio are both running.
    if (this.audioStatus?.status !== 'running') {
      this.audioStatus = { ...this.audioStatus, status: 'running', state: 'running' };
    }
    if (this.eqSection && this.eqSection.open) this.drawEq();
  }

  setAudioStatus(msg = {}) {
    if (typeof msg.status !== 'string') return;
    this.audioStatus = {
      status: msg.status,
      state: msg.state,
      deviceId: msg.deviceId,
      activeDeviceId: msg.activeDeviceId,
      fallback: Boolean(msg.fallback),
      error: msg.error || null,
    };
    if (this.eqSection && this.eqSection.open) this.drawEq();
  }

  audioIdleMessage() {
    const status = this.audioStatus?.status || 'idle';
    if (status === 'offline') return 'Waiting for an audio control panel…';

    if (status === 'unselected' || status === 'idle' || status === 'stopped') {
      return 'Select an audio input in Devices & Setup.';
    }
    if (status === 'starting') return 'Starting audio input…';
    if (status === 'suspended') return 'Click this control panel to enable audio.';
    if (status === 'running') {
      return this.audioStatus.fallback
        ? 'Using the default input — waiting for audio data…'
        : 'Audio connected — waiting for audio data…';
    }

    if (status === 'error') {
      const name = this.audioStatus.error?.name || 'AudioError';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return 'Microphone access denied. Re-initialize Devices & Setup.';
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return 'Selected audio input unavailable. Choose another input.';
      }
      if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
        return 'Audio input is busy or unavailable. Close other audio apps and retry.';
      }
      if (name === 'DeviceEndedError') return 'Audio input disconnected — reconnecting…';
      return `Audio input failed (${name}). Select the device again.`;
    }

    return 'Waiting for audio…';
  }

  // Noise-floor lifecycle broadcast from the capture owner (capturing/ready/
  // failed/cancelled/cleared). The profile is reloaded from localStorage by
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
        this.noiseCaptureBtn.innerHTML = `${ICON_X}<span class="btn-label">Cancel Capture</span>`;
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
      if (this.noiseCaptureBtn) this.noiseCaptureBtn.innerHTML = `${ICON_MIC}<span class="btn-label">Re-capture Noise Floor</span>`;
      return;
    }

    this.noiseStatusEl.classList.remove('noise-active');
    if (st === 'failed') {
      this.noiseStatusEl.textContent = this.noiseState.reason === 'no-audio'
        ? 'Capture failed — no audio input is running in the control panel.'
        : 'Capture failed.';
    } else {
      this.noiseStatusEl.textContent =
        'No noise profile. Capture a few seconds of silence to subtract room & interface hum from the spectrum.';
    }
    if (this.noiseCaptureBtn) this.noiseCaptureBtn.innerHTML = `${ICON_MIC}<span class="btn-label">Capture Noise Floor</span>`;
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

    // 5) Idle overlay when the spectrum feed is missing/stale. Explain the
    // actual blocker instead of leaving every failure as "Waiting for audio".
    if (this.eqIdle) {
      this.eqIdle.hidden = !idle;
      if (idle) this.eqIdle.textContent = this.audioIdleMessage();
    }
  }

  // ---------------------------------------------------------------------------
  // CUE transport + dual LIVE/CUE selection state
  // ---------------------------------------------------------------------------

  normalizeSelection(selection = {}) {
    const ids = Array.isArray(selection.ids) ? selection.ids.filter(Boolean).slice(0, 2) : [];
    return { ids, merge: Boolean(selection.merge && ids.length === 2) };
  }

  selectionName(selection) {
    const names = this.normalizeSelection(selection).ids
      .map((id) => SKETCHES.find((sketch) => sketch.id === id)?.name || id);
    return names.join(selection?.merge ? ' + ' : '') || 'No program';
  }

  setTransportState({ live, cue = null, screenOnline, notice = '' } = {}) {
    if (live) this.liveSelection = this.normalizeSelection(live);
    this.cueState = cue
      ? {
        ...cue,
        selection: this.normalizeSelection(cue.selection),
        params: cue.params || {},
      }
      : null;

    const editing = this.cueState?.selection || this.liveSelection;
    this.setEditingSelection(editing);
    this.setScreenOnline(Boolean(screenOnline));
    this.renderTransport(notice);
    this.updateCueDeviceLock();
    this.updateCueEditLock();

    // Do not rebuild sliders on each screen acknowledgement: doing so would
    // destroy a range input during a drag. Update the existing elements in place.
    const bank = this.cueState?.params;
    if (bank) {
      this.setPostFx(bank[POSTFX_ID] || this.getParams?.(POSTFX_ID) || {});
      const activeId = this.currentPatternId;
      const values = bank[activeId];
      if (values) {
        if (this.mergeMode && typeof values.mode === 'number' && values.mode !== this.renderedBlendMode) {
          this.renderParams();
        } else {
          this.applyParam(activeId, values);
        }
      }
    } else {
      this.setPostFx(this.getParams?.(POSTFX_ID) || {});
    }
  }

  // Kept as a small public compatibility surface for state delivery code and
  // future integrations that only have cue data to update.
  setCueState(cue, live = this.liveSelection, notice = '') {
    this.setTransportState({ live, cue, screenOnline: this.screenOnline, notice });
  }

  setEditingSelection(selection) {
    const next = this.normalizeSelection(selection);
    const ordered = getOrderedSketches();
    const indices = next.ids.map((id) => ordered.findIndex((sketch) => sketch.id === id));
    this.mergeMode = next.merge;
    this.mergePatternIds = next.merge ? [...next.ids] : null;
    this.mergeIndices = next.merge ? indices : null;
    this.currentPattern = indices[0] ?? -1;
    this.currentPatternId = next.merge ? BLEND_ID : (next.ids[0] || null);
    this.refreshSelection();
  }

  selectionButtons(selection) {
    const normalized = this.normalizeSelection(selection);
    const out = [];
    for (const id of normalized.ids) {
      const slotIndex = this.slotOrder.indexOf(id);
      if (slotIndex >= 0) {
        const slot = this.panel.querySelector(`#pattern-pad .pattern-btn[data-index="${slotIndex}"]`);
        if (slot) out.push(slot);
      } else {
        this.panel.querySelectorAll(`#pattern-library .pattern-btn[data-id="${id}"]`).forEach((button) => out.push(button));
      }
    }
    return out;
  }

  markProgramSelection(selection, scope) {
    const normalized = this.normalizeSelection(selection);
    if (!normalized.ids.length) return;
    const isLive = scope === 'live';
    const classes = normalized.merge
      ? (isLive ? ['live-merge-active', 'merge-active'] : ['cue-merge-active'])
      : (isLive ? ['live-active', 'active'] : ['cue-active']);
    this.selectionButtons(normalized).forEach((button) => button.classList.add(...classes));
  }

  renderTransport(notice = '') {
    if (!this.panel) return;
    const cue = this.cueState;
    const online = Boolean(this.screenOnline);
    const controls = this.panel.querySelector('#cue-preview-controls');
    const phaseEl = this.panel.querySelector('#cue-preview-phase');
    const primary = this.panel.querySelector('#cue-primary');
    const cancel = this.panel.querySelector('#cue-cancel');
    const previewTitle = this.panel.querySelector('#preview-title');
    const previewRenderer = this.panel.querySelector('#preview-renderer');
    const previewStage = this.panel.querySelector('#preview-stage');
    const paramsHeading = this.panel.querySelector('#params-heading');
    const liveRegion = this.panel.querySelector('#cue-live-region');

    // CUE entry is gesture-driven (Shift + a pattern), so the transport controls
    // only appear over the preview once a staged candidate actually exists.
    let action = 'GO LIVE';
    let phase = 'CUE / WARMING';
    let disabled = !cue || !online;
    if (cue) {
      switch (cue.phase) {
        case 'same':
          phase = 'CUE / SAME AS LIVE';
          break;
        case 'warming':
          phase = 'CUE / WARMING';
          break;
        case 'ready':
          phase = 'CUE / READY';
          break;
        case 'take-pending':
          action = 'GOING LIVE';
          phase = 'GOING LIVE / WARMING';
          disabled = true;
          break;
        case 'error':
          action = 'RETRY CUE';
          phase = `CUE ERROR — ${cue.error || 'LIVE SAFE'}`;
          break;
        default:
          phase = 'CUE / WARMING';
      }
    }

    if (controls) controls.hidden = !cue;
    if (phaseEl) {
      phaseEl.textContent = phase;
      phaseEl.classList.toggle('is-ready', cue?.phase === 'ready' || cue?.phase === 'same');
      phaseEl.classList.toggle('is-error', cue?.phase === 'error');
    }
    if (primary) {
      primary.querySelector('.transport-action').textContent = action;
      primary.disabled = disabled;
      primary.setAttribute('aria-label', `${action}; Enter`);
      primary.title = `${action} with the cued program (Enter)`;
    }
    if (cancel) {
      cancel.disabled = !cue;
      cancel.setAttribute('aria-label', 'Cancel cue; Escape');
      cancel.title = 'Cancel cue (Escape)';
    }

    this.panel.classList.toggle('cue-active', Boolean(cue));
    this.panel.classList.toggle('cue-pending', cue?.phase === 'take-pending');
    if (previewTitle) previewTitle.textContent = cue ? 'CUE PREVIEW' : 'LIVE PREVIEW';
    if (previewRenderer) previewRenderer.textContent = cue ? phase.replace(/^CUE \/ /, '') : 'LIVE RENDER';
    if (previewStage) {
      previewStage.classList.toggle('cue-preview', Boolean(cue));
      previewStage.setAttribute('aria-label', cue ? 'Cue visualization preview' : 'Live visualization preview');
    }
    if (paramsHeading) {
      paramsHeading.textContent = cue
        ? `CUE Parameters — ${this.selectionName(cue.selection)}`
        : 'Parameters';
    }
    if (notice && notice !== this.lastTransportNotice && liveRegion) {
      this.lastTransportNotice = notice;
      liveRegion.textContent = notice;
    }
  }

  updateCueDeviceLock() {
    const videoSelect = this.panel?.querySelector('#video-select');
    if (!videoSelect) return;
    if (this.cueState) videoSelect.disabled = true;
    else if (videoSelect.options.length > 1) videoSelect.disabled = false;
  }

  updateCueEditLock() {
    const locked = Boolean(this.cueState?.takePending);
    this.panel?.querySelectorAll(
      '#pattern-pad button, #pattern-library button, #params-list input, #params-list button, #post-fx-list input, #post-fx button',
    ).forEach((element) => {
      // These controls are normally enabled; the narrow selector intentionally
      // excludes transport CANCEL and system/global setup controls.
      element.disabled = locked;
    });
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

      btn.title = 'Click to play live. Shift-click to stage this pattern as CUE.';
      btn.onclick = (event) => {
        if (!sketch || this.cueState?.takePending) return;
        if (event.shiftKey) {
          if (this.onCuePatternChange) this.onCuePatternChange(i);
        } else if (this.onPatternChange) {
          this.onPatternChange(i);
        }
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

        btn.title = 'Click to play live. Shift-click to stage this pattern as CUE.';
        btn.onclick = (event) => {
          if (this.cueState?.takePending) return;
          if (slotIdx !== undefined) {
            // Assigned patterns retain their stable pad identity for both LIVE
            // and CUE actions, even after the operator has reordered slots.
            if (event.shiftKey) {
              if (this.onCuePatternChange) this.onCuePatternChange(slotIdx);
            } else if (this.onPatternChange) {
              this.onPatternChange(slotIdx);
            }
          } else if (event.shiftKey) {
            if (this.onCuePatternChangeId) this.onCuePatternChangeId(sketch.id);
          } else if (this.onPatternChangeId) {
            // Unassigned pattern -> play live by stable id.
            this.onPatternChangeId(sketch.id);
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
    this.setEditingSelection(this.cueState?.selection || this.liveSelection);
    this.renderTransport();
  }

  // Re-apply whatever the current editing selection is after a DOM rebuild.
  applySelection() {
    this.setEditingSelection(this.cueState?.selection || this.liveSelection);
  }

  // Legacy public helpers remain useful to existing callers; they now change
  // the editing selection only. The screen state still decides LIVE versus CUE.
  setPattern(index) {
    const id = getOrderedSketches()[index]?.id;
    this.setEditingSelection({ ids: id ? [id] : [], merge: false });
  }

  setPatternById(id) {
    this.setEditingSelection({ ids: id ? [id] : [], merge: false });
  }

  setMerge(merge) {
    if (!merge || merge.length !== 2) return;
    const ids = merge.map((index) => getOrderedSketches()[index]?.id).filter(Boolean);
    this.setEditingSelection({ ids, merge: ids.length === 2 });
  }

  // Draw two independent markers. LIVE retains the old active/merge-active
  // classes for backward compatibility, while CUE receives its own amber class.
  // A single button can carry both when the candidate equals the program.
  refreshSelection() {
    this.panel.querySelectorAll('.pattern-btn').forEach((btn) => {
      btn.classList.remove(
        'active', 'merge-active', 'live-active', 'live-merge-active',
        'cue-active', 'cue-merge-active', 'live-cue-active',
      );
    });

    this.markProgramSelection(this.liveSelection, 'live');
    if (this.cueState?.selection) this.markProgramSelection(this.cueState.selection, 'cue');
    this.panel.querySelectorAll('.pattern-btn.live-active.cue-active, .pattern-btn.live-merge-active.cue-merge-active')
      .forEach((button) => button.classList.add('live-cue-active'));

    const editing = this.cueState?.selection || this.liveSelection;
    const key = `${this.cueState ? 'cue' : 'live'}:${editing.merge ? 'merge' : 'single'}:${editing.ids.join(',')}`;
    if (this.renderedKey !== key) {
      this.renderedKey = key;
      this.renderParams();
      if (this.onPreviewChange) this.onPreviewChange(editing);
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
    this.renderedBlendMode = null;

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
    this.updateCueEditLock();
  }

  // Blend controls replace the individual effect params while merging: a
  // Blend / Additive mode toggle plus ONE level slider that drives whichever
  // mode is active (crossfade mix or additive strength).
  renderBlendParams(list) {
    const ordered = getOrderedSketches();
    const nameFor = (index, id) => ordered[index]?.name || SKETCHES.find((sketch) => sketch.id === id)?.name || 'Effect';
    const nameA = nameFor(this.mergeIndices?.[0], this.mergePatternIds?.[0]);
    const nameB = nameFor(this.mergeIndices?.[1], this.mergePatternIds?.[1]);

    const header = document.createElement('div');
    header.className = 'blend-header';
    header.innerHTML = `<span>Blend</span><span class="blend-names">${nameA} + ${nameB}</span>`;
    list.appendChild(header);

    const values = this.getParams ? this.getParams(BLEND_ID) : {};
    const additive = values.mode === 1;
    this.renderedBlendMode = additive ? 1 : 0;

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
    this.updateCueEditLock();
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
    if (this.mergeMode && 'mode' in values && values.mode !== this.renderedBlendMode) {
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
    this.renderTransport();
    if (this.eqSection && this.eqSection.open) this.drawEq();
  }

  renderStatus() {
    const el = this.panel.querySelector('#status-line');
    if (!el) return;

    const isScreen = this.isScreen ? this.isScreen() : false;
    const online = this.screenOnline !== undefined ? this.screenOnline : (this.isScreenOnline ? this.isScreenOnline() : false);

    el.innerHTML = `
      <span class="badge ${isScreen ? 'badge-screen' : 'badge-control'}">${isScreen ? 'SCREEN' : 'CONTROL'}</span>
      <span class="badge ${online ? 'badge-online' : 'badge-offline'}">SCREEN ${online ? 'ONLINE' : 'OFFLINE'}</span>
      <button id="open-screen-btn" class="status-btn" type="button" title="Open a new screen window">${ICON_MONITOR}Open Screen</button>
    `;

    // innerHTML wipes any previous listeners, so bind the handler AFTER
    // rendering (renderStatus re-runs on every status change).
    const openBtn = el.querySelector('#open-screen-btn');
    if (openBtn) openBtn.onclick = () => {
      if (this.onOpenScreen) this.onOpenScreen();
    };
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
    this.updateCueDeviceLock();
  }

  handleAudioChange(id) {
    if (!id) return;
    localStorage.setItem(this.audioKey, id);
    if (this.onDevicesChange) this.onDevicesChange({ audioDeviceId: id });
  }

  handleVideoChange(id) {
    if (!id || this.cueState) return;
    localStorage.setItem(this.videoKey, id);
    if (this.onDevicesChange) this.onDevicesChange({ videoDeviceId: id });
  }
}
