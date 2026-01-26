export class ConfigPanel {
  constructor({ onDeviceChange }) {
    this.onDeviceChange = onDeviceChange;
    this.audioKey = 'viz2_audio_device_id';
    this.container = null;
    this.select = null;
    this.startButton = null;

    this.init();
  }

  async init() {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'config-panel';
    this.container.style.position = 'absolute';
    this.container.style.top = '10px';
    this.container.style.left = '10px';
    this.container.style.zIndex = '1000';
    this.container.style.background = 'rgba(0, 0, 0, 0.5)';
    this.container.style.padding = '10px';
    this.container.style.borderRadius = '8px';
    this.container.style.color = 'white';
    this.container.style.fontFamily = 'sans-serif';

    document.body.appendChild(this.container);

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
    this.container.innerHTML = '';
    const btn = document.createElement('button');
    btn.textContent = 'Setup Audio';
    btn.style.padding = '8px 16px';
    btn.style.cursor = 'pointer';
    btn.onclick = () => this.requestPermissions();
    this.container.appendChild(btn);
  }

  renderDeviceSelector(devices) {
    this.container.innerHTML = '';

    const label = document.createElement('label');
    label.textContent = 'Audio Input: ';
    label.style.marginRight = '10px';
    this.container.appendChild(label);

    this.select = document.createElement('select');
    this.select.style.padding = '5px';

    // Add default option
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.text = 'Select Device...';
    this.select.appendChild(defaultOpt);

    let foundSaved = false;
    const savedId = localStorage.getItem(this.audioKey);

    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `Device ${d.deviceId.slice(0, 5)}...`;
      this.select.appendChild(opt);
      if (savedId && d.deviceId === savedId) {
        opt.selected = true;
        foundSaved = true;
      }
    });

    this.select.onchange = (e) => this.handleDeviceChange(e.target.value);
    this.container.appendChild(this.select);

    // If we found the saved device, trigger it immediately
    if (foundSaved && savedId) {
      this.handleDeviceChange(savedId);
    }
  }

  async requestPermissions() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // Just getting permission
      this.refreshDevices();
    } catch (e) {
      console.error(e);
      alert('Could not get audio permissions');
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
