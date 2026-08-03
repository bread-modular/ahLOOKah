import {
  SKETCHES,
  getOrderedSketches,
  getGroups,
  getSketchesByGroup,
  SHORTCUT_COUNT,
  BLEND_ID,
  BLEND_PARAMS,
} from './sketch-registry.js';

// Format a param value for display based on its step size
function formatParamValue(v, def) {
  const step = def.step ?? 0.01;
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
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

    this.renderAll();

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
