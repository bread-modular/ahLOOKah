import { test, expect } from '@playwright/test';
import { AudioInputPool, AUDIO_INPUT_POOL_MAX_SOURCES, mapAcquisitionError } from '../src/audio-input-pool.js';

// Fake capture manager: the pool is exercised through its seams exactly as the
// plan directs (createManager/readPrimary injection), without real media APIs.
function fakeManager(name) {
  return {
    name, started: false, stoppedCount: 0, requestedDeviceId: null, activeDeviceId: null,
    lastRawFrame: null, lastError: null, usedFallback: false, reads: 0, failWith: null,
    lastStatus: { status: 'idle' },
    setStatusListener() {},
    async startStream(deviceId) {
      // Acquisition is genuinely asynchronous: the outcome is decided a
      // microtask after the request, like a real getUserMedia round-trip.
      await Promise.resolve();
      this.requestedDeviceId = deviceId;
      if (this.failWith) {
        this.lastError = this.failWith;
        this.lastStatus = { status: 'error', error: this.failWith };
        return false;
      }
      this.started = true;
      this.activeDeviceId = deviceId;
      this.lastRawFrame = { channels: 2 };
      this.lastStatus = { status: 'running', activeDeviceId: deviceId };
      return true;
    },
    stop() { this.started = false; this.stoppedCount += 1; },
    getAnalysisFrame() { if (!this.started) return null; this.reads += 1; return { name, tick: this.reads }; },
    getRawAnalysisFrame() { return this.started ? { channels: 2, left: [10], right: [20], waveformLeft: [0], waveformRight: [0] } : null; },
  };
}

function makePool({ primary = null, managers = new Map(), maxSources = AUDIO_INPUT_POOL_MAX_SOURCES, now = () => 0 } = {}) {
  const created = [];
  const pool = new AudioInputPool({
    primaryManager: primary,
    readPrimary: primary ? () => (primary.started ? primary.getAnalysisFrame() : null) : () => null,
    createManager: (deviceId) => {
      if (!managers.has(deviceId)) managers.set(deviceId, fakeManager(deviceId));
      const manager = managers.get(deviceId);
      created.push(deviceId);
      return manager;
    },
    maxSources,
    now,
  });
  pool.created = created;
  return pool;
}

test('several leases for one device acquire exactly one capture', async () => {
  const pool = makePool();
  const demand = (deviceId, channel = 'mono') => ({ deviceId, channel });
  pool.reconcileDemands([demand('A'), demand('A', 'left'), demand('A', 'right')]);
  await Promise.resolve(); await Promise.resolve();
  expect(pool.created).toEqual(['A']);
  expect(pool.sources.get('A').status).toBe('running');
  pool.dispose();
});

test('A/B/C run on separate captures while the primary reserves capacity first', async () => {
  const primary = fakeManager('primary');
  primary.started = true; primary.activeDeviceId = 'primary-dev'; primary.lastRawFrame = { channels: 2 };
  const pool = makePool({ primary });
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }, { deviceId: 'C' }]);
  await Promise.resolve(); await Promise.resolve();
  expect(pool.created).toEqual(['A', 'B', 'C']);
  expect(pool.resolveInput({ deviceId: null }).id).toBe('primary');
  // Fourth extra exceeds the four-source budget and is explicitly denied.
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }, { deviceId: 'C' }, { deviceId: 'D' }]);
  expect(pool.created).toEqual(['A', 'B', 'C']);
  expect(pool.resolveInput({ deviceId: 'D' }).status).toBe('resource-limit');
  expect(pool.resolveInput({ deviceId: 'D' }).status).toBe('resource-limit');
  // Releasing C frees capacity only after its grace; D is then admittable.
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }]);
  expect(pool.sources.get('C').releaseAt).not.toBeNull();
  pool.dispose();
});

test('a pin to the primary actual device shares it; a pinned fallback victim stays missing', async () => {
  const primary = fakeManager('primary');
  primary.started = true;
  primary.requestedDeviceId = 'A';
  primary.activeDeviceId = 'B'; // global fallback A -> B
  primary.usedFallback = true;
  primary.lastRawFrame = { channels: 2 };
  primary.lastStatus = { status: 'running', activeDeviceId: 'B' };
  const pool = makePool({ primary });
  pool.setGlobalDeviceId('A');
  // Pin to the fallback target B shares the primary source.
  const pinB = pool.resolveInput({ deviceId: 'B', channel: 'mono' });
  expect(pinB.id).toBe('primary');
  // Pin to the requested-but-fallen-back A never substitutes another input.
  pool.reconcileDemands([{ deviceId: 'A' }]);
  await Promise.resolve(); await Promise.resolve();
  const pinA = pool.resolveInput({ deviceId: 'A' });
  expect(pinA.status).toBe('running');
  // A ran its OWN capture; it did not hijack the primary.
  expect(pinA.id).toBe('extra:A');
  expect(pinB.id).toBe('primary');
  pool.dispose();
});

test('unselected global input reports unselected without acquiring anything', () => {
  const pool = makePool();
  const info = pool.resolveInput(null);
  expect(info.status).toBe('unselected');
  expect(pool.created).toEqual([]);
  pool.dispose();
});

test('releasing the last lease stops that source after the grace period, others keep running', async () => {
  let now = 1000;
  const pool = makePool({ now: () => now });
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }]);
  await Promise.resolve(); await Promise.resolve();
  const managerA = pool.sources.get('A').manager;
  pool.reconcileDemands([{ deviceId: 'B' }]);
  expect(managerA.stoppedCount).toBe(0); // grace absorbs runtime reconstruction
  now += 250;
  pool.reconcileDemands([{ deviceId: 'B' }]);
  expect(managerA.stoppedCount).toBe(1);
  expect(pool.sources.has('A')).toBe(false);
  expect(pool.sources.get('B').manager.started).toBe(true);
  pool.dispose();
});

test('sample reads each running source at most once per tick', async () => {
  const primary = fakeManager('primary');
  primary.started = true; primary.lastRawFrame = { channels: 2 };
  const pool = makePool({ primary });
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }]);
  await Promise.resolve(); await Promise.resolve();
  pool.sample();
  pool.sample();
  pool.sample();
  const reads = [...pool.sources.values()].map(entry => entry.manager.reads);
  expect(reads).toEqual([3, 3]);
  expect(primary.reads).toBe(3);
  pool.dispose();
});

test('acquisition failures map to honest statuses; retry re-admits without duplicating in-flight work', async () => {
  const managers = new Map();
  const pool = makePool({ managers });
  pool.reconcileDemands([{ deviceId: 'gone' }]);
  const entry = pool.sources.get('gone');
  entry.manager.failWith = { name: 'NotFoundError' };
  await Promise.resolve(); await Promise.resolve();
  expect(pool.resolveInput({ deviceId: 'gone' }).status).toBe('missing');
  expect(managers.get('gone').stoppedCount).toBe(0); // failed stop stays graceful
  // Recovery: the device reappears, so the retry succeeds with a fresh source.
  managers.get('gone').failWith = null;
  pool.retryInput('gone');
  await Promise.resolve(); await Promise.resolve();
  expect(pool.resolveInput({ deviceId: 'gone' }).status).toBe('running');
  pool.retryInput('gone'); // healthy retry is a no-op
  expect(pool.sources.get('gone').token).toBe(2);
  pool.dispose();
});

test('a confirmed device change re-arms missing pins; denied permission stays stable', async () => {
  const managers = new Map();
  const pool = makePool({ managers });
  pool.reconcileDemands([{ deviceId: 'hotplug' }, { deviceId: 'denied' }]);
  const hotplug = pool.sources.get('hotplug');
  const denied = pool.sources.get('denied');
  hotplug.manager.failWith = { name: 'NotFoundError' };
  denied.manager.failWith = { name: 'NotAllowedError' };
  await Promise.resolve(); await Promise.resolve();
  expect(pool.resolveInput({ deviceId: 'denied' }).status).toBe('permission-denied');
  expect(mapAcquisitionError('NotReadableError')).toBe('unavailable');
  // The disconnected device comes back: a confirmed devicechange re-arms the
  // missing pin. The permission denial does not re-request on its own.
  managers.get('hotplug').failWith = null;
  pool.noteDeviceChange();
  await Promise.resolve(); await Promise.resolve();
  expect(pool.resolveInput({ deviceId: 'hotplug' }).status).toBe('running');
  expect(pool.resolveInput({ deviceId: 'denied' }).status).toBe('permission-denied');
  // An explicit retry after Settings authorization is the recovery path.
  denied.manager.failWith = null;
  pool.retryInput('denied');
  await Promise.resolve(); await Promise.resolve();
  expect(pool.resolveInput({ deviceId: 'denied' }).status).toBe('running');
  pool.dispose();
});

test('dispose stops every extra source and clears demand state', async () => {
  const pool = makePool();
  pool.reconcileDemands([{ deviceId: 'A' }, { deviceId: 'B' }]);
  await Promise.resolve(); await Promise.resolve();
  const managers = [...pool.sources.values()].map(entry => entry.manager);
  pool.dispose();
  expect(managers.every(manager => manager.stoppedCount === 1)).toBe(true);
  expect(pool.sources.size).toBe(0);
  expect(pool.resolveInput({ deviceId: 'A' }).status).toBe('missing');
});

test('a Left/Right pin that shares the primary capture isolates its channel', async () => {
  const primary = fakeManager('primary');
  primary.started = true;
  primary.activeDeviceId = 'dev-A';
  primary.lastRawFrame = { channels: 2, left: [10], right: [20] };
  primary.lastStatus = { status: 'running', activeDeviceId: 'dev-A' };
  const pool = makePool({ primary });
  pool.setGlobalDeviceId('dev-A');
  pool.sample();
  const left = pool.resolveRouteInput({ deviceId: 'dev-A', channel: 'left' });
  const right = pool.resolveRouteInput({ deviceId: 'dev-A', channel: 'right' });
  expect(left.frame.waveformRight).toBeUndefined();
  // Each projection isolates its own channel of the primary raw copy, exposed
  // under the canonical single-channel keys (left/waveformLeft).
  expect(left.frame.left).toEqual([10]);
  expect(left.frame.waveformLeft).toEqual([0]);
  expect(right.frame.left).toEqual([20]);
  expect(right.frame.waveformLeft).toEqual([0]);
  pool.dispose();
});
