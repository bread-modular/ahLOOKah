// Per-window vanilla Zustand store. This is a *renderable mirror* of accepted
// runtime authority — never an alternate protocol authority. Long-lived browser
// resources (p5, MediaStream, AudioContext, FFT buffers, observers, timers, RAF
// ids, BroadcastChannel, Web Locks) and the canonical mutable parameter objects
// live in the runtime services, NOT here (see docs/react-refactor-plan.md §3.2).
import { createStore } from 'zustand/vanilla';

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
    // Bumped whenever the accepted param bank changes so param UI re-reads the
    // mutable runtime objects without storing them in the store.
    paramRevision: 0,
    bandValues: { low: 180, high: 2800 },
    postFxRevision: 0,

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
