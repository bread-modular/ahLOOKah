import { SKETCHES } from './sketch-registry.js';

export class ConfigPanel {
  constructor({
    onPatternChange,
    onDevicesChange,
    onTakeover,
    onOpenControl,
    getPattern,
    isScreen,
    isScreenOnline,
  }) {
    this.onPatternChange = onPatternChange;
    this.onDevicesChange = onDevicesChange;
    this.onTakeover = onTakeover;
    this.onOpenControl = onOpenControl;
    this.getPattern = getPattern;
    this.isScreen = isScreen;
    this.isScreenOnline = isScreenOnline;

    this.audioKey = 'viz2_audio_device_id';
    this.videoKey = 'viz2_video_device_id';
    this.container = null;
    this.panel = null;
    this.devices = [];
    this.currentPattern = getPattern ? getPattern() : 0;

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
      <h3 class="panel-title">VIZ CONTROL</h3>
      <div id="status-line" class="status-line"></div>

      <h3>Pattern</h3>
      <div id="pattern-grid" class="pattern-grid"></div>
      <p>Keyboard 1–9 / 0 works here in the control panel.</p>

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

  renderPatternButtons() {
    const grid = this.panel.querySelector('#pattern-grid');

    SKETCHES.forEach((sketch, i) => {
      const btn = document.createElement('button');
      btn.className = 'pattern-btn';
      btn.dataset.index = i;
      btn.innerHTML = `<span class="pattern-key">${i === 9 ? '0' : i + 1}</span><span class="pattern-name">${sketch.name}</span>`;
      btn.onclick = () => {
        this.setPattern(i);
        if (this.onPatternChange) this.onPatternChange(i);
      };
      grid.appendChild(btn);
    });

    this.setPattern(this.currentPattern);
  }

  setPattern(index) {
    this.currentPattern = index;
    const grid = this.panel.querySelector('#pattern-grid');
    if (!grid) return;

    grid.querySelectorAll('.pattern-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.index, 10) === index);
    });
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
