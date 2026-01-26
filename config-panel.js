export class ConfigPanel {
  constructor({ onAudioChange, onVideoChange }) {
    this.onAudioChange = onAudioChange;
    this.onVideoChange = onVideoChange;
    this.audioKey = 'viz2_audio_device_id';
    this.videoKey = 'viz2_video_device_id';
    this.container = null;
    this.panel = null;

    this.init();
  }

  async init() {
    this.container = document.createElement('div');
    this.container.id = 'config-container';
    document.body.appendChild(this.container);

    this.panel = document.createElement('div');
    this.panel.id = 'config-panel';
    this.container.appendChild(this.panel);

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasPermissions = devices.some(d => d.label !== '');

      if (hasPermissions) {
        this.renderSelectors(devices);
      } else {
        this.renderStartButton();
      }
    } catch (e) {
      console.error('Auto-detect failed', e);
      this.renderStartButton();
    }
  }

  renderStartButton() {
    this.panel.innerHTML = `
      <h3>System Setup</h3>
      <div class="config-group">
        <p>Permissions needed for audio & camera selection.</p>
        <button id="setup-all-btn">Initialize</button>
      </div>
    `;

    this.panel.querySelector('#setup-all-btn').onclick = () => this.requestPermissions();
  }

  renderSelectors(devices) {
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    this.panel.innerHTML = `
      <h3>Audio Input</h3>
      <div class="config-group">
        <select id="audio-select">
          <option value="">Select Audio...</option>
        </select>
      </div>
      <h3>Camera Input</h3>
      <div class="config-group">
        <select id="video-select">
          <option value="">Select Camera...</option>
        </select>
      </div>
      <div class="config-group" style="margin-top: 10px;">
        <button id="refresh-devices-btn">Refresh Devices</button>
      </div>
    `;

    const audioSelect = this.panel.querySelector('#audio-select');
    const videoSelect = this.panel.querySelector('#video-select');

    const savedAudioId = localStorage.getItem(this.audioKey);
    const savedVideoId = localStorage.getItem(this.videoKey);

    audioInputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Audio ${d.deviceId.slice(0, 5)}`;
      audioSelect.appendChild(opt);
      if (savedAudioId && d.deviceId === savedAudioId) opt.selected = true;
    });

    videoInputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Camera ${d.deviceId.slice(0, 5)}`;
      videoSelect.appendChild(opt);
      if (savedVideoId && d.deviceId === savedVideoId) opt.selected = true;
    });

    audioSelect.onchange = (e) => this.handleAudioChange(e.target.value);
    videoSelect.onchange = (e) => this.handleVideoChange(e.target.value);
    this.panel.querySelector('#refresh-devices-btn').onclick = () => this.refreshDevices();

    // Trigger initial callbacks if saved
    if (savedAudioId) this.onAudioChange(savedAudioId);
    if (savedVideoId) this.onVideoChange(savedVideoId);
  }

  async requestPermissions() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());
      this.refreshDevices();
    } catch (e) {
      console.error(e);
    }
  }

  async refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.renderSelectors(devices);
  }

  handleAudioChange(id) {
    if (!id) return;
    localStorage.setItem(this.audioKey, id);
    if (this.onAudioChange) this.onAudioChange(id);
  }

  handleVideoChange(id) {
    if (!id) return;
    localStorage.setItem(this.videoKey, id);
    if (this.onVideoChange) this.onVideoChange(id);
  }
}
