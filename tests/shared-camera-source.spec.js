import { test, expect } from '@playwright/test';
import { SharedCameraSource } from '../src/shared-camera-source.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { stops: 0, stop() { this.stops++; } };
  return { track, getTracks: () => [track] };
}

async function flushMediaPromises() {
  await new Promise(resolve => setImmediate(resolve));
}

async function withCameraSource(run) {
  const names = ['window', 'navigator', 'HTMLMediaElement'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests = [];
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { location: { search: '?role=screen' } } },
    navigator: { configurable: true, value: { mediaDevices: {
      getUserMedia(constraints) {
        const pending = deferred();
        requests.push({ constraints, ...pending });
        return pending.promise;
      },
    } } },
    HTMLMediaElement: { configurable: true, value: { HAVE_CURRENT_DATA: 2 } },
  });
  const source = new SharedCameraSource();
  const makeP = () => ({
    _elements: [],
    createVideo() {
      const video = {
        videoWidth: 640, videoHeight: 480, readyState: 2, srcObject: null,
        addEventListener() {}, play() { return Promise.resolve(); }, pause() {},
      };
      const capture = { elt: video, hide() {}, stop() { throw new Error('p5 must not stop a shared track'); } };
      this._elements.push(capture);
      return capture;
    },
  });
  try {
    await run({ source, requests, makeP });
  } finally {
    source.dispose();
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('concurrent pinned cameras resolve independently and release only their own tracks', async () => {
  await withCameraSource(async ({ source, requests, makeP }) => {
    const ready = [], errors = [];
    const acquire = id => source.acquire({ p: makeP(), deviceId: id, constraints: { video: { width: 640 } },
      onReady: () => ready.push(id), onError: error => errors.push([id, error.message]) });
    const a = acquire('camA');
    const b = acquire('camB');
    expect(requests.map(r => r.constraints)).toEqual([
      { video: { width: 640, deviceId: { exact: 'camA' } }, audio: false },
      { video: { width: 640, deviceId: { exact: 'camB' } }, audio: false },
    ]);
    const streamA = fakeStream(), streamB = fakeStream();
    requests[1].resolve(streamB);
    await flushMediaPromises();
    expect(ready).toEqual(['camB']);
    expect(b.capture.elt.srcObject).toBe(streamB);
    expect(a.capture.elt.srcObject).toBeNull();
    requests[0].resolve(streamA);
    await flushMediaPromises();
    expect(ready).toEqual(['camB', 'camA']);
    expect(errors).toEqual([]);
    expect(a.capture.elt.srcObject).toBe(streamA);
    expect(source.diagnostics()).toEqual({ streams: 2, consumers: 2, devices: ['camA', 'camB'] });
    a.release();
    expect(streamA.track.stops).toBe(1);
    expect(streamB.track.stops).toBe(0);
    expect(b.capture.elt.srcObject).toBe(streamB);
    expect(source.diagnostics()).toEqual({ streams: 1, consumers: 1, devices: ['camB'] });
    b.release();
    b.release();
    expect(streamB.track.stops).toBe(1);
    expect(source.diagnostics()).toEqual({ streams: 0, consumers: 0, devices: [] });
  });
});

test('same-device fanout retains the pending and active stream until the last lease releases', async () => {
  await withCameraSource(async ({ source, requests, makeP }) => {
    const ready = [];
    const first = source.acquire({ p: makeP(), deviceId: 'camA', onReady: () => ready.push('first') });
    const second = source.acquire({ p: makeP(), deviceId: 'camA', onReady: () => ready.push('second') });
    expect(requests).toHaveLength(1);
    expect(source.diagnostics().consumers).toBe(2);
    first.release();
    const stream = fakeStream();
    requests[0].resolve(stream);
    await flushMediaPromises();
    expect(ready).toEqual(['second']);
    expect(first.capture.elt.srcObject).toBeNull();
    expect(second.capture.elt.srcObject).toBe(stream);
    expect(stream.track.stops).toBe(0);
    const third = source.acquire({ p: makeP(), deviceId: 'camA', onReady: () => ready.push('third') });
    await flushMediaPromises();
    expect(requests).toHaveLength(1);
    expect(ready).toEqual(['second', 'third']);
    second.release();
    expect(stream.track.stops).toBe(0);
    expect(third.capture.elt.srcObject).toBe(stream);
    third.release();
    expect(stream.track.stops).toBe(1);
    expect(source.diagnostics().streams).toBe(0);
  });
});

test('permission failure reports to each lease without breaking another camera or a retry', async () => {
  await withCameraSource(async ({ source, requests, makeP }) => {
    const errors = [], ready = [];
    const acquire = id => source.acquire({ p: makeP(), deviceId: id,
      onReady: () => ready.push(id), onError: error => errors.push([id, error.name]) });
    const firstA = acquire('camA'), secondA = acquire('camA'), b = acquire('camB');
    expect(requests).toHaveLength(2);
    requests[0].reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await flushMediaPromises();
    expect(errors).toEqual([['camA', 'NotAllowedError'], ['camA', 'NotAllowedError']]);
    expect(source.diagnostics()).toEqual({ streams: 1, consumers: 1, devices: ['camB'] });
    const retryA = acquire('camA');
    expect(requests).toHaveLength(3);
    firstA.release(); secondA.release(); // Old failed leases cannot remove the new A source.
    const streamB = fakeStream(), streamA = fakeStream();
    requests[1].resolve(streamB);
    requests[2].resolve(streamA);
    await flushMediaPromises();
    expect(ready).toEqual(['camB', 'camA']);
    expect(errors).toHaveLength(2);
    expect(source.diagnostics()).toEqual({ streams: 2, consumers: 2, devices: ['camB', 'camA'] });
    b.release(); retryA.release();
    expect(streamA.track.stops).toBe(1);
    expect(streamB.track.stops).toBe(1);
  });
});

test('a released or disposed pending capture stops late tracks without reviving stale consumers', async () => {
  await withCameraSource(async ({ source, requests, makeP }) => {
    const ready = [], errors = [];
    const acquire = id => source.acquire({ p: makeP(), deviceId: id,
      onReady: () => ready.push(id), onError: error => errors.push([id, error.message]) });
    const oldA = acquire('camA');
    oldA.release();
    const newA = acquire('camA');
    const b = acquire('camB');
    expect(requests).toHaveLength(3);
    const live = fakeStream(), stale = fakeStream(), disposed = fakeStream();
    requests[1].resolve(live);
    requests[0].resolve(stale);
    await flushMediaPromises();
    expect(ready).toEqual(['camA']);
    expect(errors).toEqual([]);
    expect(stale.track.stops).toBe(1);
    expect(live.track.stops).toBe(0);
    expect(newA.capture.elt.srcObject).toBe(live);
    source.dispose();
    expect(live.track.stops).toBe(1);
    expect(source.diagnostics()).toEqual({ streams: 0, consumers: 0, devices: [] });
    requests[2].resolve(disposed);
    await flushMediaPromises();
    expect(disposed.track.stops).toBe(1);
    expect(b.capture.elt.srcObject).toBeNull();
    expect(ready).toEqual(['camA']);
    expect(errors).toEqual([]);
    oldA.release(); newA.release(); b.release();
    expect([stale.track.stops, live.track.stops, disposed.track.stops]).toEqual([1, 1, 1]);
  });
});
