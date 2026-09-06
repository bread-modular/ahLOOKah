// Per-window in-house vanilla store. This is a *renderable mirror* of accepted
// runtime authority — never an alternate protocol authority. Long-lived browser
// resources (p5, MediaStream, AudioContext, FFT buffers, observers, timers, RAF
// ids, BroadcastChannel, Web Locks) and the canonical mutable parameter objects
// live in the runtime services, NOT here (see docs/react-refactor-plan.md §3.2).
import { createStore } from './vanillaStore.js';

export function createVizStore(role) {
  return createStore(() => ({
    // session
    role,
    bootStatus: 'checking', // 'checking' | 'ready' | 'blocked'
    singletonBlocked: false,
    screenOnline: role === 'screen',

    // program
    liveSelection: { ids: [], merge: false },
    cue: null,
    editingScope: 'live', // 'live' | 'cue'
    editingSelection: { ids: [], merge: false },
    padOrder: [],
    // Bumped whenever the user-loaded media pattern list changes (add/remove in
    // this window or synced from the other window) so library UI re-reads
    // SKETCHES without storing sketch objects in the store.
    mediaRevision: 0,
    // Bumped whenever the accepted param bank changes so param UI re-reads the
    // mutable runtime objects without storing them in the store.
    paramRevision: 0,
    bandValues: { low: 180, high: 2800 },
    postFxRevision: 0,

    // Screen mapping (projector keystone). Opt-in: when `enabled` is false the
    // output renders to the full frame untouched. quad is null = full frame;
    // each corner is normalized 0..1 against the OUTPUT window. Resolution is
    // the output window's innerWidth/innerHeight reported over the bus.
    screenMappingEnabled: false,
    screenMappingQuad: null,
    screenResolution: null,

    // audio
    audioStatus: { status: 'idle' },
    audioDeviceId: null,
    videoDeviceId: null,
    devices: [],

    // noise
    noiseState: { status: 'idle' },

    // ui
    appMenuOpen: false,
    setupModalOpen: false,
    keyMapOpen: false,
    postFxOpen: true,
    bandEqOpen: true,
    transportNotice: '',
  }));
}
