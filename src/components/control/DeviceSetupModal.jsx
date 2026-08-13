import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/RuntimeContext.jsx';

const AUDIO_KEY = 'viz2_audio_device_id';
const VIDEO_KEY = 'viz2_video_device_id';
const DONE_KEY = 'viz2_device_setup_done';

export function needsDeviceSetup() {
  if (localStorage.getItem(DONE_KEY) === '1') return false;
  const hasAudio = !!localStorage.getItem(AUDIO_KEY);
  const hasVideo = !!localStorage.getItem(VIDEO_KEY);
  if (hasAudio && hasVideo) {
    localStorage.setItem(DONE_KEY, '1');
    return false;
  }
  return true;
}

function optionLabel(device, placeholder) {
  return device.label || `${placeholder.replace('Select ', '').replace('...', '')} ${device.deviceId.slice(0, 5)}`;
}

export function DeviceSetupModal() {
  const { runtime, store } = useRuntime();
  const [devices, setDevices] = useState([]);
  const [audioId, setAudioId] = useState(() => localStorage.getItem(AUDIO_KEY) || '');
  const [videoId, setVideoId] = useState(() => localStorage.getItem(VIDEO_KEY) || '');
  const [closing, setClosing] = useState(false);

  const refresh = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch (e) {
      console.error('Auto-detect failed', e);
    }
  };

  useEffect(() => { refresh(); }, []);

  const hasPermission = devices.some((d) => d.label !== '');
  const audioInputs = devices.filter((d) => d.kind === 'audioinput');
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');

  const handleAudioChange = (id) => {
    if (!id) return;
    setAudioId(id);
    localStorage.setItem(AUDIO_KEY, id);
    runtime.commands.setDevices({ audioDeviceId: id });
  };
  const handleVideoChange = (id) => {
    if (!id) return;
    setVideoId(id);
    localStorage.setItem(VIDEO_KEY, id);
    runtime.commands.setDevices({ videoDeviceId: id });
  };

  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => store.setState({ setupModalOpen: false }), 300);
  };

  const requestPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (e) {
      console.error(e);
    }
  };

  const complete = () => {
    if (audioId) handleAudioChange(audioId);
    if (videoId) handleVideoChange(videoId);
    localStorage.setItem(DONE_KEY, '1');
    dismiss();
  };

  return createPortal(
    <div
      id="device-setup-modal"
      className={closing ? 'device-setup-modal--closing' : ''}
      role="dialog"
      aria-modal="true"
      aria-labelledby="device-setup-modal-title"
    >
      <div className="device-setup-modal-card">
        <button id="device-setup-modal-close" className="device-setup-modal-close" type="button" aria-label="Close" onClick={dismiss}>&times;</button>
        <h2 id="device-setup-modal-title">Connect Audio &amp; Video</h2>
        <p className="device-setup-modal-desc">Initialize your microphone and camera, then select the inputs to use.</p>

        <div id="device-setup-modal-notice" className="device-setup-modal-notice" style={{ display: hasPermission ? 'none' : '' }}>
          <p>Permissions are needed to list and use your audio &amp; camera inputs.</p>
          <button id="device-setup-modal-init" className="btn btn--solid" type="button" onClick={requestPermissions}>
            <span className="btn-label">Initialize</span>
          </button>
        </div>

        <div className="device-setup-modal-field">
          <label htmlFor="device-setup-modal-audio">Audio Input</label>
          <select id="device-setup-modal-audio" disabled={!hasPermission} value={audioId} onChange={(e) => handleAudioChange(e.target.value)}>
            <option value="">Select Audio...</option>
            {audioInputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{optionLabel(d, 'Select Audio...')}</option>)}
          </select>
        </div>

        <div className="device-setup-modal-field">
          <label htmlFor="device-setup-modal-video">Camera Input</label>
          <select id="device-setup-modal-video" disabled={!hasPermission} value={videoId} onChange={(e) => handleVideoChange(e.target.value)}>
            <option value="">Select Camera...</option>
            {videoInputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{optionLabel(d, 'Select Camera...')}</option>)}
          </select>
        </div>

        <div className="device-setup-modal-actions">
          <button id="device-setup-modal-refresh" className="btn btn--md" type="button" onClick={refresh}>
            <span className="btn-label">Refresh Devices</span>
          </button>
          <button id="device-setup-modal-ok" className="btn btn--md" type="button" onClick={complete}>
            <span className="btn-label">OK</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
