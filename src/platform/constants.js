// Compatibility constants: storage keys, BroadcastChannel name, Web Lock names,
// and timing knobs. These are part of the external contract (docs §12.4) and
// must never be renamed during this migration.
export const CHANNEL_NAME = 'viz2_channel';

export const TAB_ID_KEY = 'viz2_tab_id';

export const STORAGE = Object.freeze({
  audio: 'viz2_audio_device_id',
  video: 'viz2_video_device_id',
  params: 'viz2_params',
  slotOrder: 'viz2_slot_order',
  effectOrder: 'viz2_effect_order',
  noiseFloor: 'viz2_noise_floor',
  deviceSetupDone: 'viz2_device_setup_done',
  bandEqOpen: 'viz2_band_eq_open',
  postFxOpen: 'viz2_post_fx_open',
});

export const SINGLETON_KEY = Object.freeze({
  screen: 'viz2_singleton_screen',
  control: 'viz2_singleton_control',
});

export const SINGLETON_LEASE_MS = 4000;
export const SINGLETON_HEARTBEAT_MS = 1400;

export const AUDIO_LOCK_NAME = 'viz2_audio_capture_owner';
export const AUDIO_LEASE_KEY = 'viz2_audio_capture_lease';
export const AUDIO_LEASE_MS = 3000;

export const CUE_WARM_TIMEOUT_MS = 12_000;
