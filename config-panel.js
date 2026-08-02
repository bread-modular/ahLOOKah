import { getOrderedSketches, SHORTCUT_COUNT } from './sketch-registry.js';

// Format a param value for display based on its step size
function formatParamValue(v, def) {
  const step = def.step ?? 0.01;
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

export class ConfigPanel {
  constructor({
    onPatternChange,
    onDevicesChange,
    onTakeover,
    onOpenControl,
    onParamChange,
    onReorder,
    getParams,
    getPattern,
    isScreen,
    isScreenOnline,
  }) {
    this.onPatternChange = onPatternChange;
    this.onDevicesChange = onDevicesChange;
    this.onTakeover = onTakeover;
    this.onOpenControl = onOpenControl;
    this.onParamChange = onParamChange;
    this.onReorder = onReorder;
    this.getParams = getParams;
    this.getPattern = getPattern;
    this.isScreen = isScreen;
    this.isScreenOnline = isScreenOnline;

    this.audioKey = 'viz2_audio_device_id';
    this.videoKey = 'viz2_video_device_id';
    this.container = null;
    this.panel = null;
    this.devices = [];
    this.currentPattern = getPattern ? getPattern() : 0;
    this.currentPatternId = null;
    // Id of the sketch the slider list was last rendered for — used to skip
    // redundant re-renders (see setPattern).
    this.renderedPatternId = null;
    this.dragId = null;

    this.init();
  }

  async init() {
    this.container = document.createElement('div');
    this.container.id = 'config-container';
    document.body.appendChild(this.container);

    this.panel = document.createElement('div');
    this.panel.id = 'config-panel';
    this.container.appendChild(this.panel);

    this.panel.innerHTML = `
      <div id="effects-pane">
        <h3>Pattern</h3>
        <div id="pattern-grid" class="pattern-grid"></div>
        <p>Drag effects to reorder. Keys 1–9 / 0 select the first 10.</p>
      </div>

      <div id="effects-resizer" class="effects-resizer" title="Drag to resize"></div>

      <div id="controls-pane">
        <h3 class="panel-title">VIZ CONTROL</h3>
        <div id="status-line" class="status-line"></div>

        <h3>Parameters</h3>
        <div id="params-list" class="params-list"></div>

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
    `;

    this.renderPatternButtons();

    this.panel.querySelector('#refresh-devices-btn').onclick = () => this.refreshDevices();
    this.panel.querySelector('#takeover-btn').onclick = () => {
      if (this.onTakeover) this.onTakeover();
    };
    this.panel.querySelector('#open-control-btn').onclick = () => {
      if (this.onOpenControl) this.onOpenControl();
    };
    this.panel.querySelector('#setup-all-btn').onclick = () => this.requestPermissions();

    this.initResizer();

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
    const notice = this.panel.querySelector('#setup-notice');
    if (notice) notice.style.display = 'flex';
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

  renderPatternButtons() {
    const grid = this.panel.querySelector('#pattern-grid');
    grid.innerHTML = '';

    // Buttons render in the user's current order (localStorage-backed);
    // only the first SHORTCUT_COUNT positions carry a number key badge.
    getOrderedSketches().forEach((sketch, i) => {
      // Skip camera-input effects — hidden from the UI (scripts stay loaded)
      if (sketch.camera) return;

      const btn = document.createElement('button');
      btn.className = 'pattern-btn';
      btn.dataset.id = sketch.id;
      btn.dataset.index = i;
      btn.draggable = true;

      const hasKey = i < SHORTCUT_COUNT;
      if (!hasKey) btn.classList.add('no-key');
      const keyHtml = hasKey
        ? `<span class="pattern-key">${i === 9 ? '0' : i + 1}</span>`
        : '';
      btn.innerHTML = `${keyHtml}<span class="pattern-name">${sketch.name}</span><span class="drag-handle" title="Drag to reorder">⠿</span>`;

      btn.onclick = () => {
        this.setPattern(i);
        if (this.onPatternChange) this.onPatternChange(i);
      };
      this.attachDrag(btn);
      grid.appendChild(btn);
    });

    this.setPattern(this.currentPattern);
  }

  // HTML5 drag & drop — reorders the effect list and persists it
  attachDrag(btn) {
    btn.addEventListener('dragstart', (e) => {
      this.dragId = btn.dataset.id;
      btn.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.dragId);
      }
    });

    btn.addEventListener('dragend', () => {
      this.dragId = null;
      btn.classList.remove('dragging');
      this.clearDropTargets();
    });

    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.clearDropTargets();
      if (btn.dataset.id !== this.dragId) btn.classList.add('drop-target');
    });

    btn.addEventListener('dragleave', () => btn.classList.remove('drop-target'));

    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      this.clearDropTargets();
      const fromId = this.dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      const toId = btn.dataset.id;
      if (!fromId || fromId === toId) return;

      const ids = getOrderedSketches().map((s) => s.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;

      ids.splice(from, 1);
      ids.splice(to, 0, fromId);

      if (this.onReorder) this.onReorder(ids);
      // Keep the selection on the sketch that was active before the move
      this.setOrder();
    });
  }

  clearDropTargets() {
    const grid = this.panel.querySelector('#pattern-grid');
    if (!grid) return;
    grid.querySelectorAll('.pattern-btn.drop-target').forEach((b) => b.classList.remove('drop-target'));
  }

  // Re-render the grid after a reorder and re-select the active effect by id
  setOrder() {
    this.renderPatternButtons();
    const activeId = this.currentPatternId;
    if (!activeId) return;
    const idx = getOrderedSketches().findIndex((s) => s.id === activeId);
    if (idx >= 0) this.setPattern(idx);
  }

  setPattern(index) {
    this.currentPattern = index;
    const ordered = getOrderedSketches();
    this.currentPatternId = ordered[index] ? ordered[index].id : null;
    const grid = this.panel.querySelector('#pattern-grid');
    if (!grid) return;

    grid.querySelectorAll('.pattern-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.index, 10) === index);
    });

    // Only rebuild the sliders when the selected effect actually changes.
    // syncUI() calls setPattern() after EVERY broadcast message — including
    // the 'params' message a slider drag itself emits — and rebuilding the
    // list destroys the <input type="range"> mid-drag, so click-and-drag
    // used to stop after a single step.
    if (this.renderedPatternId !== this.currentPatternId) {
      this.renderedPatternId = this.currentPatternId;
      this.renderParams();
    }
  }

  // Rebuild the slider list for the currently selected effect
  renderParams() {
    const list = this.panel.querySelector('#params-list');
    if (!list) return;

    list.innerHTML = '';

    const ordered = getOrderedSketches();
    const sketch = ordered[this.currentPattern];
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

  // Sync slider positions/values for a param change coming from another window
  applyParam(id, values) {
    if (id !== this.currentPatternId) return;
    const list = this.panel.querySelector('#params-list');
    if (!list) return;

    const ordered = getOrderedSketches();
    const sketch = ordered[this.currentPattern];
    const defs = (sketch && sketch.params) || [];

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
