export class ConfigPanel {
  constructor({ onDeviceChange }) {
    this.onDeviceChange = onDeviceChange;
    this.audioKey = 'viz2_audio_device_id';
    this.container = null;
    this.panel = null;

    this.init();
  }

  async init() {
    // Main Container (The invisible trigger area)
    this.container = document.createElement('div');
    this.container.id = 'config-container';
    document.body.appendChild(this.container);

    // Panel
    this.panel = document.createElement('div');
    this.panel.id = 'config-panel';
    this.container.appendChild(this.panel);

    // Auto-detection logic
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      const hasPermissions = audioInputs.some(d => d.label !== '');

      if (hasPermissions) {
        this.renderDeviceSelector(audioInputs);
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
      <h3>Audio Setup</h3>
      <div class="config-group">
        <p>Permissions needed for audio input selection.</p>
        <button id="setup-audio-btn">Initialize</button>
      </div>
    `;

    this.panel.querySelector('#setup-audio-btn').onclick = () => this.requestPermissions();
  }

  renderDeviceSelector(devices) {
    this.panel.innerHTML = `
      <h3>Input</h3>
      <div class="config-group">
        <select id="device-select">
          <option value="">Select...</option>
        </select>
        <button id="refresh-devices-btn">Refresh</button>
      </div>
    `;

    const select = this.panel.querySelector('#device-select');
    const savedId = localStorage.getItem(this.audioKey);
    let foundSaved = false;

    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Device ${d.deviceId.slice(0, 5)}...`;
      select.appendChild(opt);
      if (savedId && d.deviceId === savedId) {
        opt.selected = true;
        foundSaved = true;
      }
    });

    select.onchange = (e) => this.handleDeviceChange(e.target.value);
    this.panel.querySelector('#refresh-devices-btn').onclick = () => this.refreshDevices();

    if (foundSaved && savedId) {
      this.handleDeviceChange(savedId);
    }
  }

  async requestPermissions() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      this.refreshDevices();
    } catch (e) {
      console.error(e);
    }
  }

  async refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    this.renderDeviceSelector(audioInputs);
  }

  handleDeviceChange(deviceId) {
    if (!deviceId) return;
    localStorage.setItem(this.audioKey, deviceId);
    if (this.onDeviceChange) {
      this.onDeviceChange(deviceId);
    }
  }
}
