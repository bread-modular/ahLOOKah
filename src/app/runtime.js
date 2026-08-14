// Window runtime coordinator. Owns all long-lived browser resources and the
// screen-authoritative LIVE/CUE state machine. React only renders the shell and
// reads accepted snapshots from the per-window store; components invoke the
// `commands` surface below and never touch BroadcastChannel or p5 directly.
import p5 from 'p5';
import {
  getOrderedSketches,
  SKETCHES,
  BLEND_ID,
  BANDS_ID,
  POSTFX_ID,
  BLEND_PARAMS,
  POSTFX_PARAMS,
  BAND_SPLIT_DEFAULTS,
  defaultParamValues,
  saveSlotOrder,
} from '../sketch-registry.js';
import {
  ProgramRuntime,
  copyProgramSelection,
  disposeP5Instance,
  selectionsEqual,
} from '../program-runtime.js';
import { SharedCameraSource } from '../shared-camera-source.js';
import { AudioManager } from '../audio-manager.js';
import { PreviewAudio } from '../preview-audio.js';
import { PatternAudioControlStore } from '../pattern-audio-controls.js';
import { PatternAudioControlEngine } from '../pattern-audio-engine.js';
import {
  PATTERN_AUDIO_CONTROLS_TYPE,
  PATTERN_AUDIO_PLAN_TYPE,
  PATTERN_AUDIO_PLAN_REQUEST_TYPE,
  PATTERN_AUDIO_PROTOCOL_VERSION,
  snapshotPatternParams,
  paramsFingerprint,
  toPublicPlanSlot,
} from '../pattern-audio-protocol.js';
import { setBandSplit, computeLogSpectrum } from '../sketches/audio-features.js';
import {
  loadNoiseFloor,
  clearNoiseFloor,
  startNoiseCapture,
  cancelNoiseCapture,
  isNoiseCapturing,
  getNoiseCaptureState,
  getNoiseFloorMeta,
  sampleNoiseFloorDb,
  NOISE_CAPTURE_DEFAULT_SECONDS,
} from '../noise-floor.js';
import {
  CHANNEL_NAME,
  STORAGE,
  AUDIO_LOCK_NAME,
  AUDIO_LEASE_KEY,
  AUDIO_LEASE_MS,
  CUE_WARM_TIMEOUT_MS,
} from '../platform/constants.js';
import { createBroadcastBus } from '../platform/BroadcastBus.js';
import { createSingletonCoordinator } from '../platform/SingletonCoordinator.js';
import { createKeyboardController } from '../input/KeyboardController.js';
import { createParamRepository } from '../params/ParamRepository.js';
import { createWindowLifecycle } from '../platform/WindowLifecycle.js';
import {
  installEarlyVizStub,
  installDebugBridge,
  markVizBlocked,
} from '../platform/debugBridge.js';
import { openControlWindow, openScreenWindow } from '../platform/openRoleWindow.js';
import {
  singleSelection,
  mergeSelection,
  selectionFromIndices,
  selectionFromId,
  validCueSelection,
  selectionIndices,
  selectionName,
  paramObjectsEqual,
  visualParamId,
  copyVisualParamBank,
  visualParamBanksEqual,
  visualParamBankUsesOnlyDefaults,
  isKnownLiveParamId,
  cueRequiresRuntime,
} from '../program/selection.js';

export function createAppRuntime({
  role,
  windowId,
  tabId,
  bootTime,
  store,
}) {
  const dev = Boolean(import.meta.env.DEV);
  const params = createParamRepository({ dev });
  const paramValues = params.initialize();
  const getParams = (id) => params.getParams(id);

  // Apply persisted crossovers before the singleton handshake so a reloaded
  // screen exposes the same feature split immediately.
  setBandSplit(paramValues[BANDS_ID] || defaultParamValues(BANDS_ID));

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------
  const audio = new AudioManager();
  const screenAudio = new PreviewAudio({ idleSignal: false, staleAfterMs: 750 });
  const previewAudio = new PreviewAudio();
  const patternAudioStore = new PatternAudioControlStore({ consumerSessionId: windowId });
  const patternAudioEngine = new PatternAudioControlEngine({
    ownerId: windowId,
    getSketchById: (id) => SKETCHES.find((sketch) => sketch.id === id) || null,
  });
  const cameraSource = new SharedCameraSource();

  const knownAudioConsumers = new Set();
  let patternAudioPlanRevision = 0;
  let patternAudioTopologyFingerprint = '';
  let patternAudioPlanPayloadFingerprint = '';
  let patternAudioPlanRaf = 0;
  let patternAudioPlanForce = false;
  let patternAudioPlanHeartbeat = 0;
  let lastPatternControlAt = 0;

  // Legacy selection projection (panel/DEV compatibility).
  let currentP5 = null;
  let currentIndex = 0;
  let activeSketchId = null;
  let mergeIndices = null;
  let mergeIds = null;
  let mergeP5 = [];

  // Screen program slots.
  let liveRuntime = null;
  let cueRuntime = null;
  let incomingRuntime = null;
  let retiringRuntime = null;
  let liveProgram = null;
  let cueSession = null;
  let screenStage = null;
  let stageLiveLayer = null;
  let stageCueLayer = null;
  let cueStageRaf = 0;

  // Control-originated cue mutation queue.
  let cueMutationRaf = 0;
  let cueMutationInFlight = null;
  let queuedCueSelection = null;
  const queuedCueParams = new Map();
  let queuedCueTake = false;
  let cueEntryPending = null;
  const canceledCueEntryRequests = new Set();
  let cueTakeIntent = null;
  let runtimeGeneration = 0;
  let directGeneration = 0;
  const lastCueTimings = [];

  let currentVideoDeviceId = null;
  let currentAudioDeviceId = null;
  let screenOnline = role === 'screen';
  let lastAudioStatus = audio.getStatus();
  let audioRestartTimer = 0;
  let isAudioOwner = false;
  let wantsAudioOwnership = false;
  let audioOwnershipTask = null;
  let audioOwnershipAbort = null;
  let releaseAudioOwnershipLock = null;
  let audioLockHeld = false;
  let fallbackLeaseTimer = 0;

  let lastAudioOwnerBroadcast = null;
  let lastAudioStatusBroadcast = null;

  // Preview state.
  let previewStage = null;
  let previewP5 = [];
  let previewAudioSlots = [];
  let previewSelection = { ids: [], merge: false };
  let lastPreviewKey = null;
  let previewResizeObserver = null;
  let previewRenderRaf = 0;
  let previewResizeRaf = 0;
  let previewGeneration = 0;
  let previewNeedsRebuild = true;

  // Screen resize.
  let screenResizeObserver = null;
  let screenResizeRaf = 0;

  // Audio broadcast loop.
  let audioBroadcastRaf = 0;
  let lastAnalysisAt = 0;
  let lastSpectrumAt = 0;
  let audioFrameSequence = 0;
  let noiseCaptureActive = false;
  let lastNoiseProgressAt = 0;

  let singletonBlocked = false;

  // Imperative EQ sink (spectrum stays OUT of React state).
  const eqSink = {
    split: { low: BAND_SPLIT_DEFAULTS.low, high: BAND_SPLIT_DEFAULTS.high },
    spectrum: null,
    lastSpectrumAt: 0,
    drawn: 0,
    listeners: new Set(),
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit() { this.listeners.forEach((fn) => { try { fn(this); } catch { /* noop */ } }); },
    handleSpectrum(msg) {
      if (!msg || !msg.freqs || !msg.dbs || msg.freqs.length !== msg.dbs.length || !msg.freqs.length) return;
      this.spectrum = msg;
      this.lastSpectrumAt = performance.now();
      this.emit();
    },
    setSplit(values = {}) {
      for (const key of ['low', 'high']) {
        const v = Math.round(Number(values[key]));
        if (Number.isFinite(v) && v !== this.split[key]) this.split[key] = v;
      }
      this.emit();
    },
  };

  // ---------------------------------------------------------------------------
  // Broadcast + singleton + lifecycle
  // ---------------------------------------------------------------------------
  let singleton = null;
  let bus = null;

  const lifecycle = createWindowLifecycle({ onDispose: disposeViz });

  // ---------------------------------------------------------------------------
  // Param bank helpers
  // ---------------------------------------------------------------------------
  function getCueParams(id) {
    if (!cueSession) return getParams(id);
    if (id === BANDS_ID) return getParams(BANDS_ID);
    if (!cueSession.params[id]) cueSession.params[id] = { ...defaultParamValues(id) };
    return cueSession.params[id];
  }

  function getEditingParams(id) {
    return cueSession ? getCueParams(id) : getParams(id);
  }

  function cloneCueBank(selection) {
    const bank = {};
    for (const [id, values] of Object.entries(params.getRawBank())) {
      if (visualParamId(id) && values && typeof values === 'object') bank[id] = { ...values };
    }
    const ids = Array.isArray(selection?.ids) ? selection.ids : [];
    ids.forEach((id) => {
      if (!bank[id]) bank[id] = { ...defaultParamValues(id) };
    });
    if (!bank[BLEND_ID]) bank[BLEND_ID] = { ...defaultParamValues(BLEND_ID) };
    if (!bank[POSTFX_ID]) bank[POSTFX_ID] = { ...defaultParamValues(POSTFX_ID) };
    return bank;
  }

  function adoptVisualParamBank(bank, { preserveReferences = false, persist = true } = {}) {
    if (!bank) return;
    const bands = getParams(BANDS_ID);
    const adopted = preserveReferences ? bank : copyVisualParamBank(bank);
    adopted[BANDS_ID] = bands;
    params.setRawBank(adopted);
    if (persist) params.saveParamValues();
  }

  function adoptCueBank(session) {
    if (!session?.params) return;
    adoptVisualParamBank(session.params, { preserveReferences: true });
  }

  function canonicalLiveParamBank() {
    return copyVisualParamBank(params.getRawBank());
  }

  function canonicalBandValues() {
    return { ...(params.getRawBank()[BANDS_ID] || defaultParamValues(BANDS_ID)) };
  }

  function applyCanonicalBandValues(values) {
    if (role === 'screen' || !values || typeof values !== 'object') return false;
    const current = getParams(BANDS_ID);
    if (paramObjectsEqual(current, values)) return false;
    Object.assign(current, values);
    params.saveParamValues();
    setBandSplit(current);
    eqSink.setSplit(current);
    store.setState({ bandValues: { ...current } });
    return true;
  }

  function applyCanonicalLiveParamBank(bank) {
    if (role === 'screen' || !bank || typeof bank !== 'object') return false;
    if (visualParamBanksEqual(params.getRawBank(), bank)) return false;
    const hadStoredParams = localStorage.getItem(STORAGE.params) !== null;
    adoptVisualParamBank(bank, {
      persist: hadStoredParams || !visualParamBankUsesOnlyDefaults(bank),
    });
    if (role === 'control' && !cueSession) {
      store.setState((s) => ({ paramRevision: s.paramRevision + 1, postFxRevision: s.postFxRevision + 1 }));
    }
    return true;
  }

  function applyAcceptedLiveParamValues(id, values) {
    Object.assign(getParams(id), values);
    params.saveParamValues();
    const editingCue = Boolean(cueSession);
    if (id === BLEND_ID) {
      if (role === 'screen') applyBlendStyles();
      if (role === 'control' && !editingCue) applyPreviewCompositing();
    }
    if (id === BANDS_ID) setBandSplit(getParams(BANDS_ID));
    if (id === POSTFX_ID) {
      applyPostFx();
      if (role === 'control' && !editingCue) applyPreviewCompositing();
    }
    if (role === 'control' && (!editingCue || id === BANDS_ID)) {
      if (id === BANDS_ID) store.setState({ bandValues: { ...getParams(BANDS_ID) } });
      else if (id === POSTFX_ID) store.setState((s) => ({ postFxRevision: s.postFxRevision + 1 }));
      else store.setState((s) => ({ paramRevision: s.paramRevision + 1 }));
    }
    if (id !== BANDS_ID) queuePatternAudioPlanPublish();
  }

  function recordCueTiming(name, detail = {}) {
    const entry = { name, at: performance.now(), ...detail };
    lastCueTimings.push(entry);
    if (lastCueTimings.length > 30) lastCueTimings.shift();
  }

  // ---------------------------------------------------------------------------
  // Selection / legacy projection
  // ---------------------------------------------------------------------------
  function syncLegacyLiveProjection() {
    const selection = liveProgram;
    if (!selection?.ids?.length) return;
    const indices = selectionIndices(selection);
    activeSketchId = selection.ids[0] || null;
    if (selection.merge && indices.length === 2 && indices.every((index) => index >= 0)) {
      currentIndex = indices[0];
      mergeIndices = indices;
      mergeIds = [...selection.ids];
    } else {
      currentIndex = indices[0] ?? -1;
      mergeIndices = null;
      mergeIds = null;
    }
    currentP5 = liveRuntime?.primary || null;
    mergeP5 = liveRuntime?.merge ? [...liveRuntime.instances] : [];
  }

  function currentLiveSelection() {
    if (liveProgram?.ids?.length) return copyProgramSelection(liveProgram);
    return selectionFromIndices(currentIndex, mergeIndices) || singleSelection(activeSketchId || getOrderedSketches()[0]?.id);
  }

  function updateActiveSketchId() {
    const selection = selectionFromIndices(currentIndex, mergeIndices);
    if (!selection) return;
    activeSketchId = selection.ids[0] || null;
    mergeIds = selection.merge ? [...selection.ids] : null;
  }

  // ---------------------------------------------------------------------------
  // Screen stage + resize
  // ---------------------------------------------------------------------------
  function resizeScreenRuntimes() {
    const viewportWidth = Math.max(1, Math.round(window.innerWidth));
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const runtimes = new Set([liveRuntime, cueRuntime, incomingRuntime, retiringRuntime]);
    for (const runtime of runtimes) {
      if (!runtime || runtime.disposed) continue;
      runtime.resize(viewportWidth, viewportHeight);
    }
  }

  function observeScreenResize() {
    if (screenResizeObserver) {
      try { screenResizeObserver.disconnect(); } catch { /* noop */ }
    }
    const target = screenStage || document.getElementById('screen-wrap');
    if (!target) return;
    const queueResize = () => {
      if (screenResizeRaf) return;
      screenResizeRaf = requestAnimationFrame(() => {
        screenResizeRaf = 0;
        resizeScreenRuntimes();
      });
    };
    screenResizeObserver = new ResizeObserver(queueResize);
    try { screenResizeObserver.observe(target); } catch { /* noop */ }
    lifecycle.trackListener(window, 'resize', queueResize);
  }

  function ensureScreenStage() {
    if (screenStage && stageLiveLayer && stageCueLayer) return screenStage;
    // React renders #screen-wrap + the two program layers. This function only
    // looks them up; it must never create a duplicate (a premature call during
    // the pre-React hello/state echo would otherwise append a second stage).
    const wrap = document.getElementById('screen-wrap');
    if (!wrap) return null;
    wrap.classList.add('program-stage');

    const liveLayer = wrap.querySelector('[data-program-slot="live"]');
    const cueLayer = wrap.querySelector('[data-program-slot="cue"]');
    if (!liveLayer || !cueLayer) return null;
    liveLayer.className = 'program-layer program-layer-live';
    cueLayer.className = 'program-layer program-layer-cue';
    screenStage = wrap;
    stageLiveLayer = liveLayer;
    stageCueLayer = cueLayer;
    observeScreenResize();
    return wrap;
  }

  function setLayerRoles(liveLayer, cueLayer) {
    if (liveLayer) {
      liveLayer.classList.remove('program-layer-cue', 'program-layer-retiring');
      liveLayer.classList.add('program-layer-live');
      liveLayer.dataset.programRole = 'live';
    }
    if (cueLayer) {
      cueLayer.classList.remove('program-layer-live', 'program-layer-retiring');
      cueLayer.classList.add('program-layer-cue');
      cueLayer.dataset.programRole = 'cue';
    }
  }

  // ---------------------------------------------------------------------------
  // Program runtime
  // ---------------------------------------------------------------------------
  function createRuntime(selection, getBankParams, layer, reason = 'cue') {
    return new ProgramRuntime({
      p5Constructor: p5,
      selection,
      sketches: SKETCHES,
      audio: screenAudio,
      videoDeviceId: currentVideoDeviceId,
      getParams: getBankParams,
      layer,
      cameraSource,
      generation: ++runtimeGeneration,
      warmTimeoutMs: CUE_WARM_TIMEOUT_MS,
      onTiming: (name, detail) => recordCueTiming(name, { reason, ...detail }),
      audioControlStore: patternAudioStore,
      consumerSessionId: windowId,
      audioRole: reason === 'cue' ? 'cue' : (reason === 'direct-live' ? 'incoming' : 'live'),
      onAudioSlotsChanged: () => queuePatternAudioPlanPublish(),
    });
  }

  function disposeRuntime(runtime) {
    if (!runtime) return;
    runtime.dispose();
    queuePatternAudioPlanPublish();
  }

  function removeCurrentP5() {
    if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
    cueStageRaf = 0;
    disposeRuntime(incomingRuntime);
    disposeRuntime(cueRuntime);
    disposeRuntime(retiringRuntime);
    disposeRuntime(liveRuntime);
    incomingRuntime = null;
    cueRuntime = null;
    retiringRuntime = null;
    liveRuntime = null;
    currentP5 = null;
    mergeP5 = [];
    cameraSource.dispose();
  }

  function applyBlendStyles(runtime = liveRuntime) {
    runtime?.applyBlendStyles();
  }

  function postFxFilterString(resolve = getParams) {
    const p = resolve(POSTFX_ID) || {};
    const b = Number(p.brightness) || 0;
    const c = Number(p.contrast) || 0;
    const s = Number(p.saturation) || 0;
    if (!b && !c && !s) return 'none';
    return `brightness(${(100 + b) / 100}) contrast(${(100 + c) / 100}) saturate(${(100 + s) / 100})`;
  }

  function applyPostFx() {
    if (role !== 'screen') return;
    const wrap = ensureScreenStage();
    if (!wrap) return; // React stage host not mounted yet
    if (cueSession) {
      wrap.style.filter = 'none';
      liveRuntime?.setFilter(postFxFilterString(getParams));
      cueRuntime?.setFilter(postFxFilterString(getCueParams));
      incomingRuntime?.setFilter(postFxFilterString(getParams));
    } else {
      wrap.style.filter = postFxFilterString(getParams);
      liveRuntime?.setFilter('none');
      incomingRuntime?.setFilter('none');
    }
  }

  function initialLiveRuntime(selection) {
    ensureScreenStage();
    if (!stageLiveLayer || !stageCueLayer) return; // React hosts not mounted yet
    liveProgram = copyProgramSelection(selection);
    setLayerRoles(stageLiveLayer, stageCueLayer);
    const runtime = createRuntime(selection, getParams, stageLiveLayer, 'initial-live');
    liveRuntime = runtime;
    syncLegacyLiveProjection();
    applyPostFx();
    runtime.prepare()
      .then(() => {
        if (runtime !== liveRuntime) return;
        applyPostFx();
        broadcastLiveState();
      })
      .catch((error) => {
        console.error('Unable to start live program:', error);
      });
  }

  function promotePreparedRuntime(runtime, { directToken = null, cue = null, onPromoted = null } = {}) {
    return runtime.requestFreshFrame().then(() => new Promise((resolve, reject) => {
      requestAnimationFrame(() => {
        if (runtime.disposed) {
          reject(new Error('Prepared program was disposed before promotion.'));
          return;
        }
        if (directToken !== null && directToken !== directGeneration) {
          reject(new Error('Prepared program was superseded.'));
          return;
        }
        if (cue && (cueSession !== cue
          || cueRuntime !== runtime
          || cue.revision !== cue.pendingRevision
          || cue.renderedRevision !== cue.pendingRevision
          || cue.selectionGeneration !== cue.pendingSelectionGeneration
          || !selectionsEqual(cue.selection, runtime.selection))) {
          reject(new Error('Cue promotion was superseded.'));
          return;
        }

        const oldLive = liveRuntime;
        const oldLiveLayer = stageLiveLayer;
        const promotedLayer = runtime.layer;
        liveRuntime = runtime;
        incomingRuntime = incomingRuntime === runtime ? null : incomingRuntime;
        cueRuntime = cueRuntime === runtime ? null : cueRuntime;
        stageLiveLayer = promotedLayer;
        stageCueLayer = oldLiveLayer;
        setLayerRoles(stageLiveLayer, stageCueLayer);
        liveProgram = copyProgramSelection(runtime.selection);
        syncLegacyLiveProjection();
        recordCueTiming('role-visibility-swap', { ids: runtime.selection.ids });
        onPromoted?.();
        applyPostFx();
        queuePatternAudioPlanPublish();

        retiringRuntime = oldLive && oldLive !== runtime ? oldLive : null;
        requestAnimationFrame(() => {
          if (retiringRuntime === oldLive) {
            disposeRuntime(oldLive);
            retiringRuntime = null;
          }
        });
        resolve(runtime);
      });
    }));
  }

  function prepareThenPromoteLive(selection, { force = false } = {}) {
    if (role !== 'screen' || !selection?.ids?.length) return;
    if (!liveRuntime) {
      initialLiveRuntime(selection);
      return;
    }
    if (!force && selectionsEqual(selection, liveProgram) && !incomingRuntime) return;

    ensureScreenStage();
    const token = ++directGeneration;
    disposeRuntime(incomingRuntime);
    disposeRuntime(retiringRuntime);
    retiringRuntime = null;
    incomingRuntime = createRuntime(selection, getParams, stageCueLayer, 'direct-live');
    applyPostFx();
    const runtime = incomingRuntime;
    runtime.prepare()
      .then(() => promotePreparedRuntime(runtime, { directToken: token }))
      .then(() => {
        if (token !== directGeneration) return;
        broadcastLiveState();
      })
      .catch((error) => {
        if (runtime.disposed || token !== directGeneration) return;
        console.error('Unable to prepare requested live program:', error);
        disposeRuntime(runtime);
        if (incomingRuntime === runtime) incomingRuntime = null;
        applyPostFx();
        broadcastLiveState();
      });
  }

  function loadSketch(index, merge = null) {
    const selection = selectionFromIndices(index, merge);
    if (!selection) return;
    prepareThenPromoteLive(selection);
  }

  function loadSketchById(id) {
    const selection = selectionFromId(id);
    if (!selection) return;
    prepareThenPromoteLive(selection);
  }

  // ---------------------------------------------------------------------------
  // CUE state payload + screen authority
  // ---------------------------------------------------------------------------
  function cueStatePayload() {
    if (!cueSession) return null;
    const paramsOut = {};
    for (const [id, values] of Object.entries(cueSession.params || {})) {
      if (id !== BANDS_ID) paramsOut[id] = { ...values };
    }
    return {
      sessionId: cueSession.sessionId,
      entryRequestId: cueSession.entryRequestId || null,
      revision: cueSession.revision,
      selection: copyProgramSelection(cueSession.selection),
      phase: cueSession.phase,
      takePending: Boolean(cueSession.takePending),
      takeRequestId: cueSession.takeRequestId || null,
      renderedRevision: cueSession.renderedRevision ?? null,
      pendingRevision: cueSession.pendingRevision ?? null,
      selectionGeneration: cueSession.selectionGeneration || 0,
      pendingSelectionGeneration: cueSession.pendingSelectionGeneration ?? null,
      error: cueSession.error || null,
      params: paramsOut,
    };
  }

  function broadcastLiveState() {
    const selection = currentLiveSelection();
    const indices = selectionIndices(selection);
    lastAudioOwnerBroadcast = isAudioOwner;
    lastAudioStatusBroadcast = { ...lastAudioStatus };
    bus.broadcast({
      type: 'state',
      pattern: selection.merge ? indices[0] : (indices[0] ?? -1),
      merge: selection.merge ? indices : null,
      patternId: selection.ids[0] || null,
      live: copyProgramSelection(selection),
      liveParams: canonicalLiveParamBank(),
      bands: canonicalBandValues(),
      cue: cueStatePayload(),
      audioOwner: isAudioOwner,
      audioStatus: { ...lastAudioStatus },
    });
  }

  function broadcastCueState(notice = '', committedParams = null, acknowledgement = {}) {
    lastAudioOwnerBroadcast = isAudioOwner;
    lastAudioStatusBroadcast = { ...lastAudioStatus };
    bus.broadcast({
      type: 'cue-state',
      cue: cueStatePayload(),
      notice,
      live: currentLiveSelection(),
      liveParams: canonicalLiveParamBank(),
      bands: canonicalBandValues(),
      committedParams: committedParams ? copyVisualParamBank(committedParams) : null,
      takeRequestId: acknowledgement.takeRequestId || cueSession?.takeRequestId || null,
      rejectedTakeRequestId: acknowledgement.rejectedTakeRequestId || null,
      audioOwner: isAudioOwner,
      audioStatus: { ...lastAudioStatus },
    });
  }

  function mergeCueParamsInPlace(target, source) {
    const incoming = source || {};
    Object.keys(target).forEach((id) => {
      if (id !== BANDS_ID && !(id in incoming)) delete target[id];
    });
    for (const [id, values] of Object.entries(incoming)) {
      if (id === BANDS_ID) continue;
      if (!target[id]) target[id] = {};
      for (const key of Object.keys(target[id])) {
        if (!(key in values)) delete target[id][key];
      }
      Object.assign(target[id], values);
    }
  }

  function cueEditsLocked() {
    return Boolean(
      cueSession?.takePending
      || (role === 'control'
        && cueTakeIntent
        && cueTakeIntent.sessionId === cueSession?.sessionId),
    );
  }

  function panelCueState() {
    const payload = cueStatePayload();
    if (!payload || !cueTakeIntent || cueTakeIntent.sessionId !== payload.sessionId || payload.takePending) return payload;
    return { ...payload, takePending: true, phase: 'take-pending' };
  }

  function settleCueTakeIntent(payload, acknowledgement = {}) {
    if (role !== 'control' || !cueTakeIntent) return;
    const requestId = cueTakeIntent.requestId;
    if (!payload || payload.sessionId !== cueTakeIntent.sessionId) {
      cueTakeIntent = null;
      return;
    }
    if (payload.takeRequestId === requestId
      || acknowledgement.takeRequestId === requestId
      || acknowledgement.rejectedTakeRequestId === requestId
      || payload.phase === 'error') {
      cueTakeIntent = null;
    }
  }

  function applyReceivedCueState(payload, notice = '', acknowledgement = {}) {
    if (!payload) {
      cueSession = null;
      clearCueMutationQueue();
      if (role === 'control') {
        queuePreviewRender();
        queuePatternAudioPlanPublish();
        syncUI(notice);
      }
      applyPostFx();
      return;
    }

    if (cueSession?.sessionId === payload.sessionId) {
      cueSession.entryRequestId = payload.entryRequestId || cueSession.entryRequestId || null;
      cueSession.revision = payload.revision;
      cueSession.selection = copyProgramSelection(payload.selection);
      cueSession.phase = payload.phase;
      cueSession.takePending = Boolean(payload.takePending);
      cueSession.takeRequestId = payload.takeRequestId || null;
      cueSession.renderedRevision = payload.renderedRevision ?? cueSession.renderedRevision ?? null;
      cueSession.pendingRevision = payload.pendingRevision;
      cueSession.selectionGeneration = payload.selectionGeneration ?? cueSession.selectionGeneration ?? 0;
      cueSession.pendingSelectionGeneration = payload.pendingSelectionGeneration ?? null;
      cueSession.error = payload.error || null;
      mergeCueParamsInPlace(cueSession.params, payload.params);
    } else {
      cueSession = {
        sessionId: payload.sessionId,
        entryRequestId: payload.entryRequestId || null,
        revision: payload.revision,
        selection: copyProgramSelection(payload.selection),
        params: cloneCueBank(payload.selection),
        phase: payload.phase,
        takePending: Boolean(payload.takePending),
        takeRequestId: payload.takeRequestId || null,
        renderedRevision: payload.renderedRevision ?? null,
        pendingRevision: payload.pendingRevision,
        selectionGeneration: payload.selectionGeneration || 0,
        pendingSelectionGeneration: payload.pendingSelectionGeneration ?? null,
        error: payload.error || null,
        runtimeRequired: !selectionsEqual(payload.selection, currentLiveSelection()),
      };
      mergeCueParamsInPlace(cueSession.params, payload.params);
    }

    if (role === 'control' && cueEntryPending) {
      const pending = cueEntryPending;
      if (payload.entryRequestId === pending.requestId) {
        cueEntryPending = null;
        if (!selectionsEqual(payload.selection, pending.selection)) {
          queueCueSelectionChange(pending.selection);
        }
      } else if (payload.entryRequestId) {
        cueEntryPending = null;
      }
    }

    settleCueTakeIntent(payload, acknowledgement);
    acknowledgeCueMutation(payload);
    applyPostFx();
    if (role === 'control') {
      queuePreviewRender();
      queuePatternAudioPlanPublish();
      syncUI(notice);
    }
  }

  function enterCueSession(initiatorId, requestedSelection = null, entryRequestId = null) {
    if (role !== 'screen' || cueSession || !liveRuntime) return;
    if (entryRequestId && canceledCueEntryRequests.delete(entryRequestId)) return;

    directGeneration += 1;
    disposeRuntime(incomingRuntime);
    disposeRuntime(retiringRuntime);
    incomingRuntime = null;
    retiringRuntime = null;
    const selection = validCueSelection(requestedSelection) || currentLiveSelection();
    cueSession = {
      sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      entryRequestId,
      revision: 0,
      initiatorId,
      selection,
      params: cloneCueBank(selection),
      phase: 'same',
      takePending: false,
      takeRequestId: null,
      renderedRevision: 0,
      pendingRevision: null,
      selectionGeneration: 0,
      pendingSelectionGeneration: null,
      error: null,
      runtimeRequired: false,
    };
    cueSession.runtimeRequired = cueRequiresRuntime(cueSession, { getParams, currentLiveSelection });
    if (cueSession.runtimeRequired) {
      cueSession.phase = 'warming';
      cueSession.renderedRevision = null;
    }
    recordCueTiming('cue-entered', { sessionId: cueSession.sessionId, ids: selection.ids });
    applyPostFx();
    broadcastCueState();
    if (cueSession.runtimeRequired) queueCueRuntime();
  }

  function isAcceptedCueRequest(msg) {
    return role === 'screen'
      && cueSession
      && msg.sessionId === cueSession.sessionId
      && (msg.baseRevision === undefined || msg.baseRevision === cueSession.revision)
      && !cueSession.takePending;
  }

  function isCueVisualParamId(session, id) {
    if (!session || typeof id !== 'string' || id === BANDS_ID) return false;
    if (id === POSTFX_ID) return true;
    if (id === BLEND_ID) return Boolean(session.selection?.merge);
    return Boolean(session.selection?.ids?.includes(id));
  }

  function queueCueRuntime() {
    if (role !== 'screen' || !cueSession) return;
    if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
    cueStageRaf = requestAnimationFrame(() => {
      cueStageRaf = 0;
      stageCueRuntime();
    });
  }

  function isCurrentCueRuntime(session, runtime, selectionGeneration, revision = null) {
    return cueSession === session
      && cueRuntime === runtime
      && !runtime.disposed
      && session.selectionGeneration === selectionGeneration
      && selectionsEqual(session.selection, runtime.selection)
      && (revision === null || session.revision === revision);
  }

  function failCueRuntime(session, runtime, selectionGeneration, revision, error) {
    if (!isCurrentCueRuntime(session, runtime, selectionGeneration, revision)) return;
    disposeRuntime(runtime);
    if (cueRuntime === runtime) cueRuntime = null;
    session.takePending = false;
    session.takeRequestId = null;
    session.pendingRevision = null;
    session.pendingSelectionGeneration = null;
    session.promoting = false;
    session.phase = 'error';
    session.error = error?.message || 'Cue warm-up failed.';
    recordCueTiming('cue-error', { sessionId: session.sessionId, revision: session.revision, message: session.error });
    applyPostFx();
    broadcastCueState('CUE ERROR');
  }

  function settleCueRuntimeRevision(session, runtime, selectionGeneration) {
    if (!isCurrentCueRuntime(session, runtime, selectionGeneration)) return;
    if (!runtime.ready || session.renderedRevision !== session.revision) {
      session.phase = session.takePending ? 'take-pending' : 'warming';
      broadcastCueState();
      return;
    }

    if (!runtime.hasPendingFreshFrame) runtime.pause();

    if (session.takePending) {
      session.phase = 'take-pending';
      broadcastCueState('TAKE PENDING — WARMING');
      if (session.pendingRevision === session.revision
        && session.pendingSelectionGeneration === selectionGeneration) {
        takeCueSession(session, session.takeRequestId);
      }
      return;
    }

    session.phase = 'ready';
    recordCueTiming('cue-ready', { sessionId: session.sessionId, revision: session.revision });
    broadcastCueState('CUE READY');
  }

  function requestCueRevisionFrame(session, runtime, selectionGeneration, revision) {
    runtime.applyBlendStyles();
    applyPostFx();
    runtime.requestFreshFrame(4_000, { parkAfter: true })
      .then(() => {
        if (!isCurrentCueRuntime(session, runtime, selectionGeneration, revision)) return;
        session.renderedRevision = revision;
        settleCueRuntimeRevision(session, runtime, selectionGeneration);
      })
      .catch((error) => failCueRuntime(session, runtime, selectionGeneration, revision, error));
  }

  function stageCueRuntime() {
    if (role !== 'screen' || !cueSession) return;
    const session = cueSession;
    const revision = session.revision;
    const selectionGeneration = session.selectionGeneration || 0;
    const sameAsLive = selectionsEqual(session.selection, currentLiveSelection()) && !session.runtimeRequired;

    disposeRuntime(cueRuntime);
    cueRuntime = null;
    if (sameAsLive) {
      session.phase = 'same';
      session.renderedRevision = session.revision;
      session.error = null;
      applyPostFx();
      broadcastCueState();
      return;
    }

    ensureScreenStage();
    session.phase = session.takePending ? 'take-pending' : 'warming';
    session.renderedRevision = null;
    session.error = null;
    const runtime = createRuntime(session.selection, getCueParams, stageCueLayer, 'cue');
    cueRuntime = runtime;
    applyPostFx();
    broadcastCueState();
    recordCueTiming('cue-runtime-requested', { sessionId: session.sessionId, revision });

    runtime.prepare()
      .then(() => {
        if (!isCurrentCueRuntime(session, runtime, selectionGeneration)) return;
        if (session.revision === revision) {
          requestCueRevisionFrame(session, runtime, selectionGeneration, revision);
        }
      })
      .catch((error) => failCueRuntime(session, runtime, selectionGeneration, revision, error));
  }

  function resyncRejectedCueRequest(msg) {
    if (role === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) broadcastCueState();
  }

  function updateCueSelection(msg) {
    if (!isAcceptedCueRequest(msg)) {
      resyncRejectedCueRequest(msg);
      return;
    }
    const nextSelection = validCueSelection(msg.selection);
    if (!nextSelection) {
      broadcastCueState();
      return;
    }
    if (selectionsEqual(nextSelection, cueSession.selection)) {
      cueSession.revision += 1;
      const session = cueSession;
      const revision = session.revision;
      const selectionGeneration = session.selectionGeneration || 0;
      if (session.runtimeRequired && cueRuntime) {
        session.renderedRevision = null;
        session.phase = 'warming';
        requestCueRevisionFrame(session, cueRuntime, selectionGeneration, revision);
      } else {
        session.renderedRevision = revision;
      }
      broadcastCueState();
      return;
    }
    if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
    cueStageRaf = 0;
    disposeRuntime(cueRuntime);
    cueRuntime = null;
    cueSession.selection = nextSelection;
    cueSession.selectionGeneration = (cueSession.selectionGeneration || 0) + 1;
    cueSession.revision += 1;
    cueSession.renderedRevision = null;
    cueSession.error = null;
    cueSession.runtimeRequired = cueRequiresRuntime(cueSession, { getParams, currentLiveSelection });
    cueSession.phase = cueSession.runtimeRequired ? 'warming' : 'same';
    queueCueRuntime();
    broadcastCueState();
  }

  function updateCueParams(msg) {
    if (!isAcceptedCueRequest(msg)) {
      resyncRejectedCueRequest(msg);
      return;
    }
    const changes = Array.isArray(msg.changes)
      ? msg.changes
      : [{ id: msg.id, values: msg.values }];
    const valid = changes.filter((change) =>
      typeof change?.id === 'string'
        && isCueVisualParamId(cueSession, change.id)
        && change.values
        && typeof change.values === 'object',
    );
    if (!valid.length) {
      broadcastCueState();
      return;
    }

    for (const { id, values } of valid) {
      const target = getCueParams(id);
      for (const [key, value] of Object.entries(values)) {
        if (target[key] !== value) target[key] = value;
      }
    }
    queuePatternAudioPlanPublish();
    cueSession.revision += 1;
    const session = cueSession;
    const revision = session.revision;
    const selectionGeneration = session.selectionGeneration || 0;
    session.error = null;
    session.runtimeRequired = cueRequiresRuntime(session, { getParams, currentLiveSelection });
    if (!session.runtimeRequired) {
      if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
      cueStageRaf = 0;
      disposeRuntime(cueRuntime);
      cueRuntime = null;
      session.renderedRevision = revision;
      session.phase = 'same';
      applyPostFx();
      broadcastCueState();
      return;
    }

    session.renderedRevision = null;
    session.phase = 'warming';
    if (cueRuntime) {
      requestCueRevisionFrame(session, cueRuntime, selectionGeneration, revision);
    } else {
      queueCueRuntime();
    }
    broadcastCueState();
  }

  function cancelCueSession(notice = 'CUE CANCELED') {
    if (role !== 'screen' || !cueSession) return;
    if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
    cueStageRaf = 0;
    disposeRuntime(cueRuntime);
    cueRuntime = null;
    cueSession = null;
    applyPostFx();
    recordCueTiming('cue-canceled');
    broadcastCueState(notice);
    broadcastLiveState();
  }

  function cancelCueEntryRequest(entryRequestId) {
    if (role !== 'screen' || !entryRequestId) return;
    if (cueSession?.entryRequestId === entryRequestId) {
      cancelCueSession();
      return;
    }
    canceledCueEntryRequests.add(entryRequestId);
    while (canceledCueEntryRequests.size > 32) {
      canceledCueEntryRequests.delete(canceledCueEntryRequests.values().next().value);
    }
  }

  async function takeCueSession(session = cueSession, takeRequestId = null) {
    if (role !== 'screen' || !session || session !== cueSession || session.promoting) return;
    if (session.phase === 'error') {
      session.takePending = false;
      session.takeRequestId = null;
      session.pendingRevision = null;
      session.pendingSelectionGeneration = null;
      session.renderedRevision = null;
      session.phase = 'warming';
      session.error = null;
      queueCueRuntime();
      broadcastCueState();
      return;
    }

    const wasPending = session.takePending;
    const requestId = wasPending
      ? (session.takeRequestId || takeRequestId || null)
      : (takeRequestId || session.takeRequestId || null);
    if (session.phase === 'same' && !cueRuntime) {
      cueSession = null;
      applyPostFx();
      broadcastCueState('CUE TAKEN LIVE', null, { takeRequestId: requestId });
      broadcastLiveState();
      return;
    }

    session.takePending = true;
    session.takeRequestId = requestId;
    session.pendingRevision = session.revision;
    session.pendingSelectionGeneration = session.selectionGeneration || 0;
    session.phase = 'take-pending';
    if (!wasPending) {
      recordCueTiming('take-requested', { sessionId: session.sessionId, revision: session.revision });
    }
    broadcastCueState('TAKE PENDING — WARMING');

    if (!cueRuntime
      || !cueRuntime.ready
      || session.renderedRevision !== session.pendingRevision
      || cueRuntime.hasPendingFreshFrame) return;

    const runtime = cueRuntime;
    session.promoting = true;
    try {
      await promotePreparedRuntime(runtime, { cue: session, onPromoted: () => adoptCueBank(session) });
    } catch (error) {
      if (cueSession !== session || runtime.disposed) return;
      session.promoting = false;
      session.takePending = false;
      session.pendingRevision = null;
      session.pendingSelectionGeneration = null;
      session.phase = 'error';
      session.error = error?.message || 'Unable to take cue live.';
      broadcastCueState('CUE ERROR', null, { takeRequestId: requestId });
      return;
    }

    if (cueSession !== session) return;
    const committedParams = session.params;
    cueSession = null;
    applyPostFx();
    recordCueTiming('cue-taken-live', { ids: liveProgram?.ids || [] });
    broadcastCueState('CUE TAKEN LIVE', committedParams, { takeRequestId: requestId });
    broadcastLiveState();
  }

  function clearCueMutationQueue() {
    if (cueMutationRaf) cancelAnimationFrame(cueMutationRaf);
    cueMutationRaf = 0;
    cueMutationInFlight = null;
    queuedCueSelection = null;
    queuedCueParams.clear();
    queuedCueTake = false;
    cueTakeIntent = null;
  }

  function scheduleCueMutationFlush() {
    if (cueMutationRaf || cueMutationInFlight || !cueSession || cueSession.takePending) return;
    cueMutationRaf = requestAnimationFrame(() => {
      cueMutationRaf = 0;
      flushCueMutationQueue();
    });
  }

  function flushCueMutationQueue() {
    if (!cueSession || cueSession.takePending || cueMutationInFlight) return;
    const sessionId = cueSession.sessionId;
    const baseRevision = cueSession.revision;

    if (queuedCueSelection) {
      const selection = queuedCueSelection;
      queuedCueSelection = null;
      cueMutationInFlight = { sessionId, baseRevision, type: 'selection' };
      bus.broadcast({ type: 'cue-selection', sessionId, baseRevision, selection });
      return;
    }

    if (queuedCueParams.size) {
      const changes = [...queuedCueParams.entries()].map(([id, values]) => ({ id, values }));
      queuedCueParams.clear();
      cueMutationInFlight = { sessionId, baseRevision, type: 'params' };
      bus.broadcast({ type: 'cue-params', sessionId, baseRevision, changes });
      return;
    }

    if (queuedCueTake) {
      queuedCueTake = false;
      sendCueTakeRequest(sessionId, baseRevision);
    }
  }

  function acknowledgeCueMutation(payload) {
    if (!cueMutationInFlight) return;
    if (!payload || payload.sessionId !== cueMutationInFlight.sessionId) {
      clearCueMutationQueue();
      return;
    }
    if (payload.revision > cueMutationInFlight.baseRevision) {
      cueMutationInFlight = null;
      scheduleCueMutationFlush();
    }
  }

  function beginCueTakeIntent() {
    if (role !== 'control' || !cueSession || cueSession.phase === 'error') return null;
    if (cueTakeIntent?.sessionId === cueSession.sessionId) return cueTakeIntent;
    cueTakeIntent = {
      sessionId: cueSession.sessionId,
      requestId: `${windowId}-take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      sent: false,
      baseRevision: null,
    };
    syncUI('TAKE PENDING — WARMING');
    return cueTakeIntent;
  }

  function sendCueTakeRequest(sessionId, baseRevision) {
    const intent = cueTakeIntent?.sessionId === sessionId ? cueTakeIntent : null;
    if (intent) {
      intent.sent = true;
      intent.baseRevision = baseRevision;
    }
    bus.broadcast({
      type: 'cue-take',
      sessionId,
      baseRevision,
      takeRequestId: intent?.requestId || null,
    });
  }

  function queueCueSelectionChange(selection) {
    if (!cueSession || cueEditsLocked()) return;
    queuedCueSelection = copyProgramSelection(selection);
    scheduleCueMutationFlush();
  }

  function queueCueParamChange(id, values) {
    if (!cueSession || cueEditsLocked()) return;
    const existing = queuedCueParams.get(id) || {};
    queuedCueParams.set(id, { ...existing, ...values });
    scheduleCueMutationFlush();
  }

  function requestCueSelection(selection) {
    const candidate = validCueSelection(selection);
    if (!candidate || cueEditsLocked()) return;
    if (cueSession) {
      queueCueSelectionChange(candidate);
      return;
    }
    if (!screenOnline) return;

    if (cueEntryPending) {
      cueEntryPending.selection = candidate;
      return;
    }

    keyboard.clearLiveHeldKeys();
    cueEntryPending = {
      requestId: `${windowId}-cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      selection: candidate,
    };
    bus.broadcast({
      type: 'cue-enter',
      initiatorId: windowId,
      entryRequestId: cueEntryPending.requestId,
      selection: candidate,
    });
  }

  function requestCuePrimary() {
    if (!cueSession || cueEditsLocked()) return;
    const isRetry = cueSession.phase === 'error';
    if (!isRetry) beginCueTakeIntent();
    if (cueMutationInFlight || queuedCueSelection || queuedCueParams.size) {
      queuedCueTake = true;
      scheduleCueMutationFlush();
      return;
    }
    sendCueTakeRequest(cueSession.sessionId, cueSession.revision);
  }

  function requestCueCancel() {
    keyboard.clearCueHeldKeys();
    if (!cueSession) {
      if (!cueEntryPending) return;
      const entryRequestId = cueEntryPending.requestId;
      cueEntryPending = null;
      bus.broadcast({ type: 'cue-cancel-entry', entryRequestId });
      return;
    }
    clearCueMutationQueue();
    bus.broadcast({ type: 'cue-cancel', sessionId: cueSession.sessionId });
  }

  function requestSelection(selection) {
    if (!selection?.ids?.length) return;
    if (cueSession) {
      queueCueSelectionChange(selection);
      return;
    }
    if (cueEntryPending) {
      cueEntryPending.selection = copyProgramSelection(selection);
      return;
    }

    const indices = selectionIndices(selection);
    if (selection.merge) bus.broadcast({ type: 'merge', a: indices[0], b: indices[1] });
    else if (indices[0] >= 0) bus.broadcast({ type: 'pattern', index: indices[0] });
    else bus.broadcast({ type: 'pattern-id', id: selection.ids[0] });
  }

  function requestParamChange(id, values) {
    if (id === BANDS_ID) {
      bus.broadcast({ type: 'params', id, values });
      return;
    }
    if (cueSession) {
      queueCueParamChange(id, values);
      return;
    }
    if (cueEntryPending) return;
    bus.broadcast({ type: 'params', id, values });
  }

  // ---------------------------------------------------------------------------
  // Pattern-audio plan publishing
  // ---------------------------------------------------------------------------
  function collectPatternAudioSlots() {
    const slots = [];
    const seenRuntimeIds = new Set();
    const appendRuntime = (runtime, rrole) => {
      if (!runtime || runtime.disposed || seenRuntimeIds.has(runtime)) return;
      seenRuntimeIds.add(runtime);
      slots.push(...runtime.getAudioSlotDescriptors(rrole));
    };

    if (role === 'screen') {
      appendRuntime(liveRuntime, 'live');
      appendRuntime(cueRuntime, 'cue');
      appendRuntime(incomingRuntime, 'incoming');
      appendRuntime(retiringRuntime, 'retiring');
    } else {
      for (const descriptor of previewAudioSlots || []) {
        refreshPreviewAudioSlot(descriptor);
        slots.push({ ...descriptor, params: { ...descriptor.params } });
      }
    }
    return slots;
  }

  function publishPatternAudioPlan({ force = false } = {}) {
    const slots = collectPatternAudioSlots();
    const topology = slots
      .map((slot) => `${slot.runtimeId}:${slot.patternId}:${slot.role}:${slot.childIndex}:${slot.audioTransport}`)
      .sort()
      .join('|');
    if (topology !== patternAudioTopologyFingerprint) {
      patternAudioTopologyFingerprint = topology;
      patternAudioPlanRevision += 1;
    }
    if (!patternAudioPlanRevision) patternAudioPlanRevision = 1;

    const payloadFingerprint = slots
      .map((slot) => `${slot.runtimeId}:${slot.paramsRevision}:${paramsFingerprint(slot.params)}:${slot.role}`)
      .sort()
      .join('|');
    const changed = payloadFingerprint !== patternAudioPlanPayloadFingerprint;
    const localPlan = {
      consumerSessionId: windowId,
      planRevision: patternAudioPlanRevision,
      complete: true,
      slots,
    };
    patternAudioStore.setPlan(localPlan);
    if (!force && !changed) return;
    patternAudioPlanPayloadFingerprint = payloadFingerprint;
    bus.broadcast({
      type: PATTERN_AUDIO_PLAN_TYPE,
      version: PATTERN_AUDIO_PROTOCOL_VERSION,
      consumerSessionId: windowId,
      planRevision: patternAudioPlanRevision,
      sentAt: performance.now(),
      complete: true,
      slots: slots.map(toPublicPlanSlot),
    });
  }

  function queuePatternAudioPlanPublish({ force = false } = {}) {
    if (patternAudioPlanRaf) {
      if (force) patternAudioPlanForce = true;
      return;
    }
    patternAudioPlanForce = Boolean(force);
    patternAudioPlanRaf = requestAnimationFrame(() => {
      const publishForce = patternAudioPlanForce;
      patternAudioPlanForce = false;
      patternAudioPlanRaf = 0;
      publishPatternAudioPlan({ force: publishForce });
    });
  }

  function startPatternAudioPlanHeartbeat() {
    if (patternAudioPlanHeartbeat) clearInterval(patternAudioPlanHeartbeat);
    patternAudioPlanHeartbeat = window.setInterval(() => {
      queuePatternAudioPlanPublish({ force: true });
    }, 1_000);
    queuePatternAudioPlanPublish({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Preview runtime
  // ---------------------------------------------------------------------------
  function getPreviewSize() {
    if (!previewStage) return [1, 1];
    return [
      Math.max(1, Math.round(previewStage.clientWidth)),
      Math.max(1, Math.round(previewStage.clientHeight)),
    ];
  }

  function applyPreviewCompositing() {
    if (!previewStage) return;
    previewStage.style.filter = postFxFilterString(getEditingParams);

    previewP5.forEach((inst, index) => {
      const canvas = inst && inst.canvas;
      if (!canvas) return;
      canvas.style.zIndex = String(index);
      if (previewP5.length === 2 && index === 1) {
        const blendParams = getEditingParams(BLEND_ID);
        const additive = blendParams.mode === 1;
        canvas.style.mixBlendMode = additive ? 'screen' : 'normal';
        canvas.style.opacity = String(additive ? (blendParams.add ?? 0.5) : (blendParams.mix ?? 0.5));
      } else {
        canvas.style.mixBlendMode = 'normal';
        canvas.style.opacity = '1';
      }
    });
  }

  function attachPreviewCanvas(inst, sketch, layer, generation) {
    const attach = () => {
      if (generation !== previewGeneration || !previewStage || inst._removed) return;
      if (!inst.canvas) {
        requestAnimationFrame(attach);
        return;
      }

      const canvas = inst.canvas;
      if (canvas.parentElement !== previewStage) previewStage.appendChild(canvas);
      canvas.classList.add('preview-canvas');
      canvas.dataset.previewSketch = sketch.id;
      canvas.style.zIndex = String(layer);
      canvas.style.pointerEvents = 'none';
      applyPreviewCompositing();
    };
    attach();
  }

  function createPreviewAudioSlot(sketch, layer, generation) {
    const p = snapshotPatternParams(sketch, getEditingParams(sketch.id));
    const descriptor = {
      runtimeId: `${windowId}:preview-${generation}:${layer}`,
      patternId: sketch.id,
      role: 'preview',
      childIndex: layer,
      paramsRevision: 1,
      params: p,
      paramsFingerprint: paramsFingerprint(p),
      audioTransport: 'pattern-controls',
      audioControlSchema: sketch.audioControlSchema || {},
      binding: null,
    };
    patternAudioStore.upsertSlot(descriptor);
    descriptor.binding = patternAudioStore.createBinding(descriptor.runtimeId);
    previewAudioSlots.push(descriptor);
    return descriptor;
  }

  function refreshPreviewAudioSlot(descriptor) {
    const sketch = SKETCHES.find((entry) => entry.id === descriptor.patternId);
    const p = snapshotPatternParams(sketch, getEditingParams(descriptor.patternId));
    const fingerprint = paramsFingerprint(p);
    if (fingerprint !== descriptor.paramsFingerprint) {
      descriptor.params = p;
      descriptor.paramsFingerprint = fingerprint;
      descriptor.paramsRevision += 1;
    }
    patternAudioStore.upsertSlot(descriptor);
  }

  function createPreviewInstance(sketch, layer, generation) {
    if (!previewStage) return null;

    const audioSlot = createPreviewAudioSlot(sketch, layer, generation);
    const factory = sketch.factory(
      previewAudio,
      null,
      getEditingParams(sketch.id),
      {
        audioControls: audioSlot.binding,
        audioSlot: {
          runtimeId: audioSlot.runtimeId,
          patternId: audioSlot.patternId,
          childIndex: audioSlot.childIndex,
        },
      },
    );
    const wrappedSketch = (p) => {
      const createPreviewCanvas = p.createCanvas.bind(p);
      const resizePreviewCanvas = p.resizeCanvas.bind(p);
      p.createCanvas = (_requestedWidth, _requestedHeight, ...rest) => {
        const [previewWidth, previewHeight] = getPreviewSize();
        return createPreviewCanvas(previewWidth, previewHeight, ...rest);
      };
      p.resizeCanvas = (_requestedWidth, _requestedHeight, ...rest) => {
        const [previewWidth, previewHeight] = getPreviewSize();
        return resizePreviewCanvas(previewWidth, previewHeight, ...rest);
      };
      factory(p);
    };

    const inst = new p5(wrappedSketch, previewStage);
    previewP5.push(inst);
    attachPreviewCanvas(inst, sketch, layer, generation);
    return inst;
  }

  function clearPreview() {
    previewGeneration += 1;
    patternAudioStore.retireSlots(previewAudioSlots.map((slot) => slot.runtimeId));
    previewAudioSlots = [];
    previewP5.forEach((inst) => disposeP5Instance(inst));
    previewP5 = [];
    if (previewStage) {
      previewStage.replaceChildren();
      previewStage.style.filter = 'none';
      delete previewStage.dataset.previewSketches;
    }
    queuePatternAudioPlanPublish();
  }

  function renderPreview() {
    if (!previewStage) return;
    if (!previewNeedsRebuild) {
      applyPreviewCompositing();
      queuePatternAudioPlanPublish();
      return;
    }
    previewNeedsRebuild = false;
    clearPreview();

    const ids = [...new Set((previewSelection.ids || []).filter(Boolean))];
    const sketches = ids.map((id) => SKETCHES.find((sketch) => sketch.id === id)).filter(Boolean);
    previewStage.dataset.previewSketches = sketches.map((sketch) => sketch.id).join(',');

    if (!sketches.length) {
      previewStage.innerHTML = '<div class="preview-empty">Select a pattern to start the preview.</div>';
      return;
    }

    const cameraSketches = sketches.filter((sketch) => sketch.camera);
    const renderable = sketches.filter((sketch) => !sketch.camera);
    if (!renderable.length) {
      previewStage.innerHTML = `<div class="preview-empty">${cueSession ? 'CAMERA CUE STAGED ON OUTPUT' : 'Camera effect — live video remains on the output screen.'}</div>`;
      return;
    }

    const active = previewSelection.merge ? renderable.slice(0, 2) : renderable.slice(0, 1);
    const generation = previewGeneration;
    active.forEach((sketch, layer) => createPreviewInstance(sketch, layer, generation));

    if (cameraSketches.length) {
      const note = document.createElement('div');
      note.className = 'preview-camera-note';
      note.textContent = cueSession ? 'CAMERA CUE STAGED ON OUTPUT' : 'Camera layer stays on the output screen.';
      previewStage.appendChild(note);
    }
    applyPreviewCompositing();
    queuePatternAudioPlanPublish();
  }

  function queuePreviewRender() {
    if (previewRenderRaf) cancelAnimationFrame(previewRenderRaf);
    previewRenderRaf = requestAnimationFrame(() => {
      previewRenderRaf = 0;
      renderPreview();
    });
  }

  function resizePreview() {
    if (previewResizeRaf) return;
    previewResizeRaf = requestAnimationFrame(() => {
      previewResizeRaf = 0;
      const [width, height] = getPreviewSize();
      previewP5.forEach((inst) => {
        if (inst && !inst._removed && (inst.width !== width || inst.height !== height)) {
          inst.resizeCanvas(width, height);
        }
      });
    });
  }

  function initPreviewStage(stage) {
    if (previewResizeObserver) previewResizeObserver.disconnect();
    clearPreview();
    previewNeedsRebuild = true;
    previewStage = stage;
    previewResizeObserver = new ResizeObserver(resizePreview);
    previewResizeObserver.observe(stage);
    queuePreviewRender();
  }

  function setPreviewSelection(selection = {}) {
    previewSelection = {
      ids: Array.isArray(selection.ids) ? selection.ids : [],
      merge: Boolean(selection.merge),
    };
    previewNeedsRebuild = true;
    queuePreviewRender();
  }

  // ---------------------------------------------------------------------------
  // Audio ownership + loop
  // ---------------------------------------------------------------------------
  function handleAudioManagerStatus(status) {
    lastAudioStatus = { ...status };
    if (isAudioOwner) bus.broadcast({ type: 'audio-status', ...lastAudioStatus });

    if (isAudioOwner && status?.error?.name === 'DeviceEndedError') {
      scheduleAudioRecovery();
    }
  }
  audio.setStatusListener(handleAudioManagerStatus);

  function startAudio(deviceId = localStorage.getItem(STORAGE.audio)) {
    if (!isAudioOwner) return Promise.resolve(false);
    if (!deviceId) {
      currentAudioDeviceId = null;
      audio.reportStatus('unselected');
      return Promise.resolve(false);
    }

    currentAudioDeviceId = deviceId;
    patternAudioEngine.beginStream();
    return audio.startStream(deviceId);
  }

  function applyDevices(selection = {}) {
    const explicitAudioId = typeof selection.audioDeviceId === 'string' ? selection.audioDeviceId : null;
    const explicitVideoId = typeof selection.videoDeviceId === 'string' ? selection.videoDeviceId : null;
    const videoLocked = Boolean(cueSession && explicitVideoId);
    if (explicitAudioId) localStorage.setItem(STORAGE.audio, explicitAudioId);
    if (explicitVideoId && !videoLocked) localStorage.setItem(STORAGE.video, explicitVideoId);

    const savedAudioId = explicitAudioId || localStorage.getItem(STORAGE.audio);
    const savedVideoId = videoLocked ? localStorage.getItem(STORAGE.video) : (explicitVideoId || localStorage.getItem(STORAGE.video));
    currentAudioDeviceId = savedAudioId || null;

    if (isAudioOwner) {
      if (savedAudioId && (savedAudioId !== audio.requestedDeviceId || !audio.isStarted)) {
        startAudio(savedAudioId);
      } else if (!savedAudioId) {
        audio.reportStatus('unselected');
      }
    }

    if (role === 'screen' && savedVideoId && savedVideoId !== currentVideoDeviceId) {
      if (cueSession) return;
      currentVideoDeviceId = savedVideoId;
      const selection = currentLiveSelection();
      const usesCamera = selection.ids.some((id) => SKETCHES.find((sketch) => sketch.id === id)?.camera);
      if (usesCamera) prepareThenPromoteLive(selection, { force: true });
    }
  }

  function scheduleAudioRecovery() {
    if (audioRestartTimer || !isAudioOwner || !currentAudioDeviceId) return;
    audioRestartTimer = window.setTimeout(async () => {
      audioRestartTimer = 0;
      if (!isAudioOwner || !currentAudioDeviceId) return;

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((device) => device.kind === 'audioinput');
        const preferredAvailable = inputs.some((device) => device.deviceId === currentAudioDeviceId);
        const activeTrack = audio.stream?.getAudioTracks?.()[0];
        const shouldRestorePreferred = preferredAvailable
          && audio.usedFallback
          && audio.activeDeviceId !== currentAudioDeviceId;
        if (!preferredAvailable || !activeTrack || activeTrack.readyState === 'ended' || shouldRestorePreferred) {
          startAudio(currentAudioDeviceId);
        }
      } catch (err) {
        console.error('Unable to refresh audio devices:', err);
      }
    }, 250);
  }

  function takeAudioOwnership() {
    if (isAudioOwner || !wantsAudioOwnership || role !== 'control') return;
    isAudioOwner = true;
    patternAudioEngine.expectConsumer(windowId);
    knownAudioConsumers.forEach((consumerSessionId) => patternAudioEngine.expectConsumer(consumerSessionId));
    patternAudioEngine.beginStream();
    publishPatternAudioPlan({ force: true });
    bus.broadcast({ type: PATTERN_AUDIO_PLAN_REQUEST_TYPE, audioOwnerId: windowId });
    currentAudioDeviceId = localStorage.getItem(STORAGE.audio) || null;
    startAudioBroadcast();
    startAudio(currentAudioDeviceId);
    bus.broadcast({ type: 'audio-status', ...audio.getStatus() });
  }

  function relinquishAudioOwnership() {
    if (!isAudioOwner) return;
    isAudioOwner = false;
    if (audioRestartTimer) clearTimeout(audioRestartTimer);
    audioRestartTimer = 0;
    stopAudioBroadcast();
    patternAudioEngine.disposeControllers();
    if (noiseCaptureActive) {
      cancelNoiseCapture();
      noiseCaptureActive = false;
      bus.broadcast({ type: 'noise-floor', status: 'cancelled' });
    }
    audio.stop();
  }

  function beginAudioOwnership() {
    wantsAudioOwnership = true;
    if (role !== 'control' || audioOwnershipTask || fallbackLeaseTimer) return;

    if (navigator.locks?.request) {
      audioOwnershipAbort = new AbortController();
      audioOwnershipTask = navigator.locks.request(
        AUDIO_LOCK_NAME,
        { mode: 'exclusive', signal: audioOwnershipAbort.signal },
        async () => {
          audioLockHeld = true;
          if (!wantsAudioOwnership || role !== 'control') {
            audioLockHeld = false;
            return;
          }
          takeAudioOwnership();
          await new Promise((resolve) => { releaseAudioOwnershipLock = resolve; });
          releaseAudioOwnershipLock = null;
          relinquishAudioOwnership();
          audioLockHeld = false;
        },
      ).catch((err) => {
        if (err?.name !== 'AbortError') console.error('Audio ownership lock failed:', err);
      }).finally(() => {
        audioOwnershipTask = null;
        audioOwnershipAbort = null;
        audioLockHeld = false;
        if (wantsAudioOwnership && role === 'control') beginAudioOwnership();
      });
      return;
    }

    refreshFallbackAudioLease();
  }

  function readFallbackAudioLease() {
    try {
      const lease = JSON.parse(localStorage.getItem(AUDIO_LEASE_KEY) || 'null');
      return lease && typeof lease.id === 'string' && Number.isFinite(lease.expires) ? lease : null;
    } catch {
      return null;
    }
  }

  function refreshFallbackAudioLease() {
    if (fallbackLeaseTimer) clearTimeout(fallbackLeaseTimer);
    fallbackLeaseTimer = 0;
    if (!wantsAudioOwnership || role !== 'control' || navigator.locks?.request) return;

    const now = Date.now();
    const lease = readFallbackAudioLease();
    if (!lease || lease.id === windowId || lease.expires <= now) {
      localStorage.setItem(AUDIO_LEASE_KEY, JSON.stringify({ id: windowId, expires: now + AUDIO_LEASE_MS }));
    }

    const confirmed = readFallbackAudioLease();
    if (confirmed?.id === windowId) takeAudioOwnership();
    else relinquishAudioOwnership();
    fallbackLeaseTimer = window.setTimeout(refreshFallbackAudioLease, AUDIO_LEASE_MS / 3);
  }

  function endAudioOwnership() {
    wantsAudioOwnership = false;
    if (fallbackLeaseTimer) clearTimeout(fallbackLeaseTimer);
    fallbackLeaseTimer = 0;

    const lease = readFallbackAudioLease();
    if (lease?.id === windowId) localStorage.removeItem(AUDIO_LEASE_KEY);

    if (audioLockHeld && releaseAudioOwnershipLock) releaseAudioOwnershipLock();
    else if (audioOwnershipAbort) audioOwnershipAbort.abort();
    relinquishAudioOwnership();
  }

  function resumeAudioFromControlGesture() {
    if (role === 'control' && isAudioOwner && audio.isStarted) audio.resume(true);
  }

  function audioBroadcastLoop(now) {
    audioBroadcastRaf = 0;
    if (!isAudioOwner) return;

    if (now - lastAnalysisAt >= 33) {
      lastAnalysisAt = now;
      const frame = audio.isStarted ? audio.getAnalysisFrame() : null;
      audioFrameSequence += 1;
      const controlDeltaSeconds = lastPatternControlAt
        ? Math.max(1 / 240, Math.min(0.1, (now - lastPatternControlAt) / 1000))
        : 1 / 30;
      lastPatternControlAt = now;
      const controlTick = patternAudioEngine.update({
        frame,
        deltaSeconds: controlDeltaSeconds,
        captureTime: frame?.time ?? now,
        sequence: audioFrameSequence,
        now,
      });
      controlTick.packets.forEach((packet) => bus.broadcast(packet));

      if (frame && now - lastSpectrumAt >= 66) {
        lastSpectrumAt = now;
        const spec = computeLogSpectrum(frame);
        if (spec) {
          const freqs = spec.freqs instanceof Float32Array ? new Float32Array(spec.freqs) : spec.freqs;
          const dbs = spec.dbs instanceof Float32Array ? new Float32Array(spec.dbs) : spec.dbs;
          bus.broadcast({ type: 'spectrum', freqs, dbs, minHz: spec.minHz, maxHz: spec.maxHz });
        }
      }
    }

    if (noiseCaptureActive) {
      const cap = getNoiseCaptureState();
      if (!cap.capturing) {
        noiseCaptureActive = false;
        bus.broadcast({ type: 'noise-floor', status: 'ready', meta: getNoiseFloorMeta() });
      } else if (cap.frames === 0 && cap.elapsed > cap.seconds + 2) {
        cancelNoiseCapture();
        noiseCaptureActive = false;
        bus.broadcast({ type: 'noise-floor', status: 'failed', reason: 'no-audio' });
      } else if (now - lastNoiseProgressAt > 250) {
        lastNoiseProgressAt = now;
        bus.broadcast({
          type: 'noise-floor',
          status: 'capturing',
          progress: cap.progress,
          elapsed: cap.elapsed,
          seconds: cap.seconds,
        });
      }
    }

    audioBroadcastRaf = requestAnimationFrame(audioBroadcastLoop);
  }

  function startAudioBroadcast() {
    if (!audioBroadcastRaf) audioBroadcastRaf = requestAnimationFrame(audioBroadcastLoop);
  }

  function stopAudioBroadcast() {
    if (audioBroadcastRaf) cancelAnimationFrame(audioBroadcastRaf);
    audioBroadcastRaf = 0;
    lastAnalysisAt = 0;
    lastSpectrumAt = 0;
    lastPatternControlAt = 0;
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  const keyboard = createKeyboardController({
    getRole: () => role,
    hasCueSession: () => Boolean(cueSession),
    hasCueEntryPending: () => Boolean(cueEntryPending),
    cueEditsLocked,
    getEditingSelection: () => cueSession?.selection || currentLiveSelection(),
    getEditingParams,
    requestParamChange,
    requestSelection,
    requestCueSelection,
    requestCuePrimary,
    requestCueCancel,
    selectionFromIndices,
  });

  // ---------------------------------------------------------------------------
  // Message router
  // ---------------------------------------------------------------------------
  function isFiniteNumber(n) { return typeof n === 'number' && Number.isFinite(n); }
  function clampInt(n, lo, hi) { return Math.max(lo, Math.min(hi, n | 0)); }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (typeof msg.type !== 'string') return;
    if (msg.type.length > 32) return;

    if (msg.type === 'singleton-claim' || msg.type === 'singleton-alive') {
      if (singleton.isOwner && msg.role === role && msg.tabId !== tabId && msg.windowId !== windowId) {
        try {
          bus.channel.postMessage({ type: 'singleton-alive', role, windowId, tabId, bootTime });
        } catch { /* noop */ }
      }
      return;
    }
    if (singletonBlocked) return;

    switch (msg.type) {
      case 'hello':
        if (typeof msg.windowId === 'string' && msg.windowId.length <= 160) {
          knownAudioConsumers.add(msg.windowId);
          if (isAudioOwner) patternAudioEngine.expectConsumer(msg.windowId);
        }
        if (msg.role === 'screen') {
          screenOnline = true;
        }
        if (role === 'screen') broadcastLiveState();
        if (isAudioOwner && msg.windowId !== windowId) {
          patternAudioEngine.expectConsumer(msg.windowId);
          bus.broadcast({ type: 'audio-status', ...lastAudioStatus });
        }
        break;

      case PATTERN_AUDIO_PLAN_REQUEST_TYPE:
        if (msg.windowId && msg.audioOwnerId && msg.windowId !== msg.audioOwnerId) return;
        queuePatternAudioPlanPublish({ force: true });
        return;

      case PATTERN_AUDIO_PLAN_TYPE: {
        if (msg.windowId && msg.windowId !== msg.consumerSessionId) return;
        if (msg.consumerSessionId === windowId) patternAudioStore.setPlan(msg);
        if (isAudioOwner) patternAudioEngine.receivePlan(msg);
        return;
      }

      case PATTERN_AUDIO_CONTROLS_TYPE:
        if (msg.windowId && msg.windowId !== msg.audioOwnerId) return;
        if (msg.consumerSessionId === windowId) {
          const receipt = patternAudioStore.acceptPacket(msg);
          if (receipt.accepted && receipt.slots > 0 && msg.audioActive && role === 'screen') screenAudio.setControlActive();
        }
        return;

      case 'state': {
        let selection = null;
        if (msg.live && typeof msg.live === 'object' && !Array.isArray(msg.live)) {
          const ids = Array.isArray(msg.live.ids) ? msg.live.ids.slice(0, 2) : [];
          if (ids.length && ids.length <= 2 && ids.every((id) => typeof id === 'string' && id.length <= 64)) {
            selection = copyProgramSelection(msg.live);
            if (!selection.ids.every((id) => SKETCHES.some((s) => s.id === id))) selection = null;
          }
        }
        if (!selection) {
          if (typeof msg.patternId === 'string' && msg.patternId.length <= 64 && isFiniteNumber(msg.pattern) && msg.pattern < 0) {
            selection = selectionFromId(msg.patternId);
          } else if (isFiniteNumber(msg.pattern)) {
            const p = clampInt(msg.pattern, -1, 100);
            let merge = null;
            if (Array.isArray(msg.merge) && msg.merge.length === 2 && msg.merge.every(isFiniteNumber)) merge = msg.merge.map((n) => clampInt(n, 0, 100));
            selection = selectionFromIndices(p, merge);
          }
        }
        if (selection?.ids?.length) {
          liveProgram = copyProgramSelection(selection);
          syncLegacyLiveProjection();
        } else if (isFiniteNumber(msg.pattern)) {
          currentIndex = clampInt(msg.pattern, -1, 100);
          mergeIndices = Array.isArray(msg.merge) && msg.merge.length === 2 && msg.merge.every(isFiniteNumber) ? msg.merge.map((n) => clampInt(n, 0, 100)) : null;
          if (msg.pattern < 0 && typeof msg.patternId === 'string' && msg.patternId.length <= 64) activeSketchId = msg.patternId;
          else updateActiveSketchId();
        }
        screenOnline = true;
        if (typeof msg.audioOwner === 'boolean') {
          lastAudioOwnerBroadcast = msg.audioOwner;
          lastAudioStatusBroadcast = msg.audioStatus && typeof msg.audioStatus === 'object' ? msg.audioStatus : lastAudioStatusBroadcast;
        }
        if (msg.bands && typeof msg.bands === 'object' && !Array.isArray(msg.bands)) {
          const keys = Object.keys(msg.bands);
          if (keys.length <= 16) applyCanonicalBandValues(msg.bands);
        }
        if (msg.liveParams && typeof msg.liveParams === 'object' && !Array.isArray(msg.liveParams)) {
          if (Object.keys(msg.liveParams).length <= 80) applyCanonicalLiveParamBank(msg.liveParams);
        }
        if ('cue' in msg) {
          const cue = msg.cue;
          if (cue === null || (cue && typeof cue === 'object' && !Array.isArray(cue))) applyReceivedCueState(cue);
        }
        break;
      }

      case 'pattern': {
        if (cueSession) break;
        if (!isFiniteNumber(msg.index)) break;
        const idx = clampInt(msg.index, 0, 100);
        const selection = selectionFromIndices(idx);
        if (!selection) break;
        if (role === 'screen') {
          if (!cueSession) prepareThenPromoteLive(selection);
        } else {
          liveProgram = copyProgramSelection(selection);
          syncLegacyLiveProjection();
        }
        break;
      }

      case 'pattern-id': {
        if (cueSession) break;
        if (typeof msg.id !== 'string' || msg.id.length > 64) break;
        const selection = selectionFromId(msg.id);
        if (!selection) break;
        if (role === 'screen') {
          if (!cueSession) prepareThenPromoteLive(selection);
        } else {
          liveProgram = copyProgramSelection(selection);
          syncLegacyLiveProjection();
        }
        break;
      }

      case 'merge': {
        if (cueSession) break;
        if (!isFiniteNumber(msg.a) || !isFiniteNumber(msg.b)) break;
        const a = clampInt(msg.a, 0, 100), b = clampInt(msg.b, 0, 100);
        const selection = selectionFromIndices(a, [a, b]);
        if (!selection) break;
        if (role === 'screen') {
          if (!cueSession) prepareThenPromoteLive(selection);
        } else {
          liveProgram = copyProgramSelection(selection);
          syncLegacyLiveProjection();
        }
        break;
      }

      case 'cue-enter':
        if (role === 'screen') {
          enterCueSession(msg.initiatorId || msg.windowId, msg.selection, msg.entryRequestId || null);
        }
        return;

      case 'cue-cancel-entry':
        if (role === 'screen') cancelCueEntryRequest(msg.entryRequestId || null);
        return;

      case 'cue-selection':
        updateCueSelection(msg);
        return;

      case 'cue-params':
        updateCueParams(msg);
        return;

      case 'cue-take':
        if (role === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) {
          if (msg.baseRevision !== undefined && msg.baseRevision !== cueSession.revision) {
            broadcastCueState('', null, { rejectedTakeRequestId: msg.takeRequestId || null });
          } else if (cueSession.takePending
            && msg.takeRequestId
            && cueSession.takeRequestId
            && msg.takeRequestId !== cueSession.takeRequestId) {
            broadcastCueState('', null, { rejectedTakeRequestId: msg.takeRequestId });
          } else {
            takeCueSession(cueSession, msg.takeRequestId || null);
          }
        }
        return;

      case 'cue-cancel':
        if (role === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) cancelCueSession();
        return;

      case 'cue-state': {
        if (msg.live && typeof msg.live === 'object' && Array.isArray(msg.live.ids) && msg.live.ids.length && msg.live.ids.length <= 2 && msg.live.ids.every((id) => typeof id === 'string' && id.length <= 64)) {
          const sel = copyProgramSelection(msg.live);
          if (sel.ids.every((id) => SKETCHES.some((s) => s.id === id))) {
            liveProgram = sel;
            syncLegacyLiveProjection();
          }
        }
        if (msg.bands && typeof msg.bands === 'object' && !Array.isArray(msg.bands) && Object.keys(msg.bands).length <= 16) applyCanonicalBandValues(msg.bands);
        if (msg.liveParams && typeof msg.liveParams === 'object' && !Array.isArray(msg.liveParams) && Object.keys(msg.liveParams).length <= 80) applyCanonicalLiveParamBank(msg.liveParams);
        if (msg.committedParams && typeof msg.committedParams === 'object' && !Array.isArray(msg.committedParams) && Object.keys(msg.committedParams).length <= 80 && !(role === 'screen' && msg.windowId === windowId)) {
          adoptVisualParamBank(msg.committedParams);
        }
        const notice = typeof msg.notice === 'string' ? msg.notice.slice(0, 200) : '';
        const cuePayload = msg.cue === null || (msg.cue && typeof msg.cue === 'object' && !Array.isArray(msg.cue)) ? msg.cue : null;
        if (typeof msg.audioOwner === 'boolean') { lastAudioOwnerBroadcast = msg.audioOwner; lastAudioStatusBroadcast = msg.audioStatus && typeof msg.audioStatus === 'object' ? msg.audioStatus : lastAudioStatusBroadcast; }
        applyReceivedCueState(cuePayload, notice, {
          takeRequestId: typeof msg.takeRequestId === 'string' ? msg.takeRequestId.slice(0, 128) : null,
          rejectedTakeRequestId: typeof msg.rejectedTakeRequestId === 'string' ? msg.rejectedTakeRequestId.slice(0, 128) : null,
        });
        return;
      }

      case 'devices':
        applyDevices(msg);
        break;

      case 'audio-status':
        lastAudioStatus = {
          status: msg.status,
          state: msg.state,
          deviceId: msg.deviceId,
          activeDeviceId: msg.activeDeviceId,
          fallback: Boolean(msg.fallback),
          error: msg.error || null,
        };
        if (msg.status !== 'running') {
          if (role === 'screen') screenAudio.clearFrame();
          else previewAudio.clearFrame();
          patternAudioStore.clearForOwnerLoss();
        }
        if (role === 'control') store.setState({ audioStatus: { ...lastAudioStatus } });
        return;

      case 'params': {
        if (role !== 'screen' || typeof msg.id !== 'string' || msg.id.length > 64 || !msg.values || typeof msg.values !== 'object' || Array.isArray(msg.values) || Object.keys(msg.values).length > 16) return;
        if (!isKnownLiveParamId(msg.id)) return;
        const cleanParams = {};
        for (const [k, v] of Object.entries(msg.values)) {
          if (typeof k !== 'string' || k.length > 64) continue;
          if (!Number.isFinite(v)) continue;
          if (Math.abs(v) > 1e6) continue;
          cleanParams[k] = v;
        }
        if (!Object.keys(cleanParams).length) return;
        if (cueSession && msg.id !== BANDS_ID) {
          broadcastCueState('LIVE PARAMETER IGNORED — CUE ACTIVE');
          return;
        }
        applyAcceptedLiveParamValues(msg.id, cleanParams);
        bus.broadcast({ type: 'live-params', id: msg.id, values: cleanParams });
        return;
      }

      case 'live-params': {
        if (role !== 'screen' && typeof msg.id === 'string' && msg.id.length <= 64 && isKnownLiveParamId(msg.id) && msg.values && typeof msg.values === 'object' && !Array.isArray(msg.values) && Object.keys(msg.values).length <= 16) {
          const clean = {};
          for (const [k, v] of Object.entries(msg.values)) { if (typeof k === 'string' && k.length <= 64 && Number.isFinite(v) && Math.abs(v) <= 1e6) clean[k] = v; }
          if (Object.keys(clean).length) applyAcceptedLiveParamValues(msg.id, clean);
        }
        break;
      }

      case 'spectrum': {
        if (role === 'control') {
          if (msg.freqs && msg.dbs && msg.freqs.length <= 1024 && msg.dbs.length <= 1024) eqSink.handleSpectrum(msg);
        }
        return;
      }

      case 'noise-capture': {
        if (typeof msg.action !== 'string') return;
        if (isAudioOwner) {
          if (msg.action === 'start') {
            if (!audio.isStarted) {
              bus.broadcast({ type: 'noise-floor', status: 'failed', reason: 'no-audio' });
            } else {
              const seconds = clampInt(typeof msg.seconds === 'number' && Number.isFinite(msg.seconds) ? msg.seconds : NOISE_CAPTURE_DEFAULT_SECONDS, 1, 10);
              startNoiseCapture(seconds);
              noiseCaptureActive = true;
              lastNoiseProgressAt = 0;
              bus.broadcast({ type: 'noise-floor', status: 'capturing', progress: 0, elapsed: 0, seconds });
            }
          } else if (msg.action === 'cancel') {
            cancelNoiseCapture();
            noiseCaptureActive = false;
            bus.broadcast({ type: 'noise-floor', status: 'cancelled' });
          }
        }
        return;
      }

      case 'noise-floor': {
        if (typeof msg.status !== 'string') return;
        if (msg.status === 'ready' || msg.status === 'cleared' || msg.status === 'cancelled') {
          loadNoiseFloor();
        }
        if (role === 'control') store.setState({ noiseState: msg });
        return;
      }

      case 'reorder': {
        if (!Array.isArray(msg.order) || !msg.order.length || msg.order.length > 80) break;
        const cleanOrder = msg.order.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 10);
        if (!cleanOrder.length) break;
        const unique = [...new Set(cleanOrder)];
        if (unique.length !== cleanOrder.length) break;
        if (!unique.every((id) => SKETCHES.some((s) => s.id === id))) break;
        const idx = unique.indexOf(activeSketchId);
        currentIndex = idx >= 0 ? idx : -1;
        if (mergeIndices && mergeIds) {
          const a = unique.indexOf(mergeIds[0]);
          const b = unique.indexOf(mergeIds[1]);
          if (a >= 0 && b >= 0) mergeIndices = [a, b];
          else {
            mergeIndices = null;
            mergeIds = null;
          }
        }
        if (liveProgram?.ids?.length) syncLegacyLiveProjection();
        if (role === 'control') store.setState({ padOrder: [...unique] });
        break;
      }

      case 'screen-closed':
        screenOnline = false;
        if (role === 'control') cueEntryPending = null;
        if (role === 'control' && cueSession) applyReceivedCueState(null, 'CUE CANCELED — OUTPUT OFFLINE');
        if (role === 'control') store.setState({ screenOnline: false });
        break;
    }

    syncUI();
  }

  // ---------------------------------------------------------------------------
  // Store sync (replaces the imperative ConfigPanel surface)
  // ---------------------------------------------------------------------------
  function syncUI(notice = '') {
    if (role !== 'control') return;
    const liveSelection = currentLiveSelection();
    const cue = panelCueState();
    const editingSelection = cue?.selection || liveSelection;
    // Rebuild the embedded preview only when the editing scope/selection actually
    // changes (mirrors the legacy refreshSelection/onPreviewChange gate).
    const previewKey = `${cue ? 'cue' : 'live'}:${editingSelection.merge ? 'merge' : 'single'}:${editingSelection.ids.join(',')}`;
    if (previewKey !== lastPreviewKey) {
      lastPreviewKey = previewKey;
      setPreviewSelection(editingSelection);
    }
    store.setState((s) => ({
      screenOnline,
      liveSelection: copyProgramSelection(liveSelection),
      cue: cue ? { ...cue } : null,
      editingScope: cue ? 'cue' : 'live',
      editingSelection: copyProgramSelection(editingSelection),
      paramRevision: s.paramRevision + 1,
      postFxRevision: s.postFxRevision + 1,
      transportNotice: notice || '',
    }));
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------
  function disposeViz() {
    try { if (audioBroadcastRaf) cancelAnimationFrame(audioBroadcastRaf); } catch { /* noop */ }
    try { if (cueStageRaf) cancelAnimationFrame(cueStageRaf); } catch { /* noop */ }
    try { if (cueMutationRaf) cancelAnimationFrame(cueMutationRaf); } catch { /* noop */ }
    try { if (previewRenderRaf) cancelAnimationFrame(previewRenderRaf); } catch { /* noop */ }
    try { if (previewResizeRaf) cancelAnimationFrame(previewResizeRaf); } catch { /* noop */ }
    try { if (patternAudioPlanRaf) cancelAnimationFrame(patternAudioPlanRaf); } catch { /* noop */ }
    try { if (patternAudioPlanHeartbeat) clearInterval(patternAudioPlanHeartbeat); } catch { /* noop */ }
    try { if (audioRestartTimer) clearTimeout(audioRestartTimer); } catch { /* noop */ }
    try { if (fallbackLeaseTimer) clearTimeout(fallbackLeaseTimer); } catch { /* noop */ }
    try { if (screenResizeObserver) screenResizeObserver.disconnect(); } catch { /* noop */ }
    try { if (previewResizeObserver) previewResizeObserver.disconnect(); } catch { /* noop */ }
    try { if (singleton && singleton.stopHeartbeat) singleton.stopHeartbeat(); } catch { /* noop */ }
    try { removeCurrentP5(); } catch { /* noop */ }
    try { clearPreview(); } catch { /* noop */ }
    try { if (bus) bus.close(); } catch { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function claim() {
    // Create the bus + singleton coordinator.
    const channel = new BroadcastChannel(CHANNEL_NAME);
    bus = createBroadcastBus(CHANNEL_NAME, { windowId, handleMessage });
    singleton = createSingletonCoordinator({ role, windowId, tabId, bootTime, channel: bus.channel });

    const allowed = await singleton.enforce();
    if (!allowed) {
      singletonBlocked = true;
      store.setState({ bootStatus: 'blocked', singletonBlocked: true });
      markVizBlocked(role);
      return false;
    }
    singleton.startHeartbeat();

    const bootBands = getParams(BANDS_ID);
    setBandSplit(bootBands);
    eqSink.split = {
      low: Number.isFinite(Number(bootBands?.low)) ? Number(bootBands.low) : BAND_SPLIT_DEFAULTS.low,
      high: Number.isFinite(Number(bootBands?.high)) ? Number(bootBands.high) : BAND_SPLIT_DEFAULTS.high,
    };
    store.setState({ bandValues: { ...eqSink.split } });
    loadNoiseFloor();
    currentAudioDeviceId = localStorage.getItem(STORAGE.audio) || null;
    currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;

    if (role === 'screen') {
      document.title = 'ahLOOKah — Output';
      document.body.classList.add('is-screen');
    } else {
      document.title = 'ahLOOKah — Realtime Audio-Reactive Visuals';
      document.body.classList.add('is-control');
      store.setState({ padOrder: getOrderedSketches().map((s) => s.id) });
    }

    startPatternAudioPlanHeartbeat();

    try {
      bus.channel.postMessage({ type: 'hello', role, windowId, bootTime, tabId });
    } catch { /* noop */ }
    try { handleMessage({ type: 'hello', role, windowId, bootTime, tabId }); } catch { /* noop */ }

    installDebugBridge(buildDebugGetters(), {
      captureAudio: audio,
      readLog: () => params.getReadLog(),
    });
    store.setState({ bootStatus: 'ready' });
    return true;
  }

  // Role-specific boot runs AFTER React has rendered the stable host elements.
  function bootScreen() {
    loadSketch(currentIndex);
  }

  function bootControl() {
    updateActiveSketchId();
    store.setState({ padOrder: getOrderedSketches().map((s) => s.id) });
    syncUI();
    beginAudioOwnership();
    // First-run device setup gate (mirrors the legacy ConfigPanel.maybeShowSetupModal).
    if (localStorage.getItem(STORAGE.deviceSetupDone) !== '1') {
      const hasAudio = !!localStorage.getItem(STORAGE.audio);
      const hasVideo = !!localStorage.getItem(STORAGE.video);
      if (hasAudio && hasVideo) {
        localStorage.setItem(STORAGE.deviceSetupDone, '1');
      } else {
        store.setState({ setupModalOpen: true });
      }
    }
  }

  function buildDebugGetters() {
    return {
      role: () => role,
      singletonBlocked: () => singletonBlocked,
      singletonError: () => singletonBlocked,
      pattern: () => currentIndex,
      patternId: () => activeSketchId,
      merge: () => (mergeIndices ? [...mergeIndices] : null),
      screenOnline: () => screenOnline,
      params: () => getParams(activeSketchId || getOrderedSketches()[0].id),
      cue: () => cueStatePayload(),
      cueParams: () => (cueSession ? cueSession.params : null),
      cueRuntime: () => (cueRuntime ? {
        ids: [...cueRuntime.selection.ids],
        count: cueRuntime.count,
        ready: cueRuntime.ready,
        generation: cueRuntime.generation,
      } : null),
      runtimeCounts: () => ({
        live: liveRuntime?.count || 0,
        cue: cueRuntime?.count || 0,
        incoming: incomingRuntime?.count || 0,
        retiring: retiringRuntime?.count || 0,
        total: (liveRuntime?.count || 0) + (cueRuntime?.count || 0) + (incomingRuntime?.count || 0) + (retiringRuntime?.count || 0),
        camera: cameraSource.diagnostics(),
      }),
      cueTimings: () => lastCueTimings.map((entry) => ({ ...entry })),
      blend: () => getParams(BLEND_ID),
      audioFeatures: () => currentP5?.__audioFeatures || null,
      bands: () => getParams(BANDS_ID),
      postfx: () => getParams(POSTFX_ID),
      eq: () => ({
        split: { ...eqSink.split },
        drawn: eqSink.drawn,
        spectrumAt: eqSink.lastSpectrumAt,
        lastSpectrum: eqSink.spectrum,
      }),
      noise: () => ({
        capturing: isNoiseCapturing(),
        capture: getNoiseCaptureState(),
        profile: getNoiseFloorMeta(),
        sampleDb: (hz) => sampleNoiseFloorDb(hz),
      }),
      audio: () => (role === 'screen' ? screenAudio : audio),
      audioOwner: () => isAudioOwner,
      audioStatus: () => ({ ...lastAudioStatus }),
      audioDeviceId: () => currentAudioDeviceId,
      patternAudio: () => ({
        planRevision: patternAudioPlanRevision,
        store: patternAudioStore.getDiagnostics(),
        engine: isAudioOwner ? patternAudioEngine.getDiagnostics() : null,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Command API + preview host registration
  // ---------------------------------------------------------------------------
  const commands = {
    select(index) { requestSelection(selectionFromIndices(index)); },
    selectById(id) { requestSelection(selectionFromId(id)); },
    cueSelect(index) { requestCueSelection(selectionFromIndices(index)); },
    cueSelectById(id) { requestCueSelection(selectionFromId(id)); },
    changeParam(id, key, value) { requestParamChange(id, { [key]: value }); },
    changeParams(id, values) { requestParamChange(id, values); },
    setDevices(selection) { bus.broadcast({ type: 'devices', ...(selection || {}) }); },
    openScreen() { openScreenWindow(); },
    openControl() { openControlWindow(); },
    cuePrimary() { requestCuePrimary(); },
    cueCancel() { requestCueCancel(); },
    reorder(order) {
      saveSlotOrder(order);
      bus.broadcast({ type: 'reorder', order });
    },
    noiseStart(seconds) { bus.broadcast({ type: 'noise-capture', action: 'start', seconds }); },
    noiseCancel() { bus.broadcast({ type: 'noise-capture', action: 'cancel' }); },
    noiseClear() {
      clearNoiseFloor();
      bus.broadcast({ type: 'noise-floor', status: 'cleared' });
    },
    resumeAudio() { resumeAudioFromControlGesture(); },
  };

  function registerPreviewHost(stage) { initPreviewStage(stage); }

  function setAudioStatusToStore() {
    store.setState({ audioStatus: { ...lastAudioStatus } });
  }

  // Install the early stub before the async singleton wait.
  installEarlyVizStub({
    role: () => role,
    singletonBlocked: () => singletonBlocked,
    singletonError: () => singletonBlocked,
    audioOwner: () => isAudioOwner,
    audioStatus: () => ({ ...lastAudioStatus }),
    pattern: () => currentIndex,
    patternId: () => activeSketchId,
    noise: () => {
      try {
        let profile = null;
        try { profile = getNoiseFloorMeta(); } catch { /* noop */ }
        if (!profile) {
          try {
            const raw = localStorage.getItem(STORAGE.noiseFloor);
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.v === 1 && Array.isArray(j.dbs)) {
                profile = { binCount: j.dbs.length, sampleRate: j.sampleRate, fftSize: j.fftSize, capturedAt: j.capturedAt, seconds: j.seconds, frames: j.frames };
              } else if (j && typeof j.sampleRate === 'number') {
                profile = j;
              }
            }
          } catch { /* noop */ }
        }
        return { capturing: isNoiseCapturing(), capture: getNoiseCaptureState(), profile, sampleDb: (hz) => sampleNoiseFloorDb(hz) };
      } catch { return { capturing: false, profile: null }; }
    },
    eq: () => ({ split: { ...eqSink.split }, drawn: eqSink.drawn, spectrumAt: eqSink.lastSpectrumAt, lastSpectrum: eqSink.spectrum }),
    cue: () => cueStatePayload(),
  });

  // Wire keyboard + global listeners.
  lifecycle.trackListener(window, 'keydown', keyboard.onKeydown);
  lifecycle.trackListener(window, 'keyup', keyboard.onKeyup);
  lifecycle.trackListener(window, 'blur', keyboard.onBlur);
  lifecycle.trackListener(window, 'pointerdown', resumeAudioFromControlGesture, { capture: true, passive: true });
  lifecycle.trackListener(window, 'keydown', resumeAudioFromControlGesture, { capture: true });
  lifecycle.trackListener(window, 'beforeunload', () => {
    if (singletonBlocked) return;
    if (role === 'screen') try { bus.channel.postMessage({ type: 'screen-closed' }); } catch { /* noop */ }
    if (role === 'control') endAudioOwnership();
    singleton.clearLease();
    singleton.stopHeartbeat();
  });
  lifecycle.trackListener(window, 'pagehide', () => {
    if (singletonBlocked) { disposeViz(); return; }
    singleton.clearLease();
    singleton.stopHeartbeat();
    disposeViz();
  });
  lifecycle.trackListener(window, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !singletonBlocked && singleton.isOwner) {
      singleton.writeLease();
    }
  });
  lifecycle.trackListener(window, 'storage', (e) => {
    if (singletonBlocked) return;
    if (singleton.isOwner && e.key === singleton.key && e.newValue) {
      try {
        const lease = JSON.parse(e.newValue);
        if (lease && lease.tabId !== tabId) singleton.writeLease();
      } catch { /* noop */ }
    }
    if (e.key === AUDIO_LEASE_KEY && wantsAudioOwnership && !navigator.locks?.request) {
      refreshFallbackAudioLease();
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', scheduleAudioRecovery);

  return {
    claim,
    bootScreen,
    bootControl,
    dispose: disposeViz,
    commands,
    eqSink,
    registerPreviewHost,
    getEditingParams,
    getParams,
    getCueParams,
    setAudioStatusToStore,
    isOwner: () => isAudioOwner,
    getCurrentSelection: currentLiveSelection,
  };
}
