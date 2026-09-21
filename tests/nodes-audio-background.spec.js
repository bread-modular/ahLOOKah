import { test, expect } from '@playwright/test';
import { mapSignal } from '../src/nodes/model.js';
const graph = () => ({ version: 1, name: 'Audio ranges', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 50, y: 50 },
  { id: 'mix', type: 'blend', mode: 'Normal', opacity: .3, x: 330, y: 50 },
  { id: 'audio', type: 'audio', band: 'bass', x: 50, y: 310 },
  { id: 'audio2', type: 'audio', band: 'high', x: 330, y: 310 },
  { id: 'output', type: 'output', x: 600, y: 50 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });
async function openFixture(page, data = graph()) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async g => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-tests', { create: true });
    const f = await dir.getFileHandle('audio.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir; await nodePatterns.link(); return (await nodePatterns.open('audio.nodes.json')).id;
  }, data);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { if (!globalThis.FileSystemHandle) return; FileSystemHandle.prototype.queryPermission = async () => 'granted'; FileSystemHandle.prototype.requestPermission = async () => 'granted'; });
});

const previewRed = page => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
async function forbidEditorCapture(page) {
  await page.addInitScript(() => {
    window.editorCaptureCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.editorCaptureCalls++; throw new Error('Editor must not capture'); };
  });
}

// Real owner + worker + Web Audio analyser + bus + editor rendering. Only the
// physical input is replaced with a controllable tone in the SAME AudioContext.
test.use({ launchOptions: {
  ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
} });
for (const mode of ['native tab visibility', 'main visual rAF paused']) {
  test(`${mode}: fresh analysed audio reaches preview/marker, foreground and cleanup`, async ({ page, context }, testInfo) => {
    test.setTimeout(60000);
    await forbidEditorCapture(page);
    const main = await context.newPage();
    await main.addInitScript(() => {
      localStorage.setItem('viz2_audio_device_id', 'default');
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.captureCalls = 0;
      navigator.mediaDevices.getUserMedia = (...args) => { window.captureCalls++; return acquire(...args); };
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const held = new Map();
      window.pauseVisuals = false; window.visualTicks = 0;
      window.requestAnimationFrame = cb => {
        let id = raf(t => {
          if (window.pauseVisuals) held.set(id, cb);
          else { window.visualTicks++; cb(t); }
        });
        return id;
      };
      window.cancelAnimationFrame = id => { held.delete(id); cancel(id); };
      window.resumeVisuals = () => {
        window.pauseVisuals = false;
        for (const [id, cb] of held) { held.delete(id); raf(cb); }
      };
    });
    await main.goto('/');
    await main.bringToFront();
    await main.waitForFunction(() => window.__viz?.audioOwner, null, { timeout: 10000 });
    await main.waitForFunction(() => window.__viz?.captureAudio?.isStarted, null, { timeout: 10000 });
    await main.locator('body').click({ position: { x: 5, y: 5 } }); // genuine resume gesture
    await main.waitForFunction(() => window.__viz.captureAudio.audioContext.state === 'running');
    await main.evaluate(() => {
      const audio = window.__viz.captureAudio;
      audio.source.disconnect();
      const ctx = audio.audioContext, tone = ctx.createOscillator(), gain = ctx.createGain();
      tone.frequency.value = 94; gain.gain.value = 0;
      tone.connect(gain); gain.connect(audio.splitter); tone.start();
      window.toneGain = gain; window.originalContext = ctx; window.originalStream = audio.stream;
      window.analysisTicks = 0;
      const read = audio.getAnalysisFrame.bind(audio);
      audio.getAnalysisFrame = () => { window.analysisTicks++; return read(); };
    });
    const g = graph(); g.nodes = g.nodes.filter(n => !['mix', 'audio2'].includes(n.id));
    await openFixture(page, mapSignal(g, 'audio', 'color', 'brightness', .2, .8));
    await page.locator('[data-node-id=color] .nodes-node-title').click();
    await page.bringToFront();
    const visibility = { main: await main.evaluate(() => document.visibilityState), editor: await page.evaluate(() => document.visibilityState) };
    testInfo.annotations.push({ type: 'visibility', description: JSON.stringify(visibility) });
    if (mode === 'native tab visibility') {
      test.skip(visibility.main !== 'hidden', 'This browser keeps both tabs visible; deterministic rAF-paused integration runs separately.');
      expect(visibility).toEqual({ main: 'hidden', editor: 'visible' });
    } else {
      expect(visibility.editor).toBe('visible');
      await main.evaluate(() => { window.pauseVisuals = true; });
    }
    const marker = page.getByTestId('mapping-live-brightness');
    await expect.poll(() => previewRed(page)).toBe(51);
    const ticks = await main.evaluate(() => ({ audio: window.analysisTicks, visual: window.visualTicks, time: window.originalContext.currentTime }));
    await main.evaluate(() => { window.toneGain.gain.value = .3; });
    await expect.poll(() => previewRed(page)).toBeGreaterThan(65);
    await expect.poll(() => marker.evaluate(el => parseFloat(el.style.left))).toBeGreaterThan(25);
    await expect.poll(() => main.evaluate(() => window.analysisTicks)).toBeGreaterThan(ticks.audio + 5);
    const after = await main.evaluate(() => ({ audio: window.analysisTicks, visual: window.visualTicks, time: window.originalContext.currentTime }));
    expect(after.visual).toBe(ticks.visual);
    expect(after.time).toBeGreaterThan(ticks.time);
    await main.evaluate(() => { window.toneGain.gain.value = 0; });
    await expect.poll(() => previewRed(page)).toBe(51);
    await expect(page.getByLabel('Brightness LIVE mapped value')).toHaveText('LIVE 0.2');
    await main.bringToFront();
    await main.evaluate(() => window.resumeVisuals());
    await expect.poll(() => main.evaluate(() => window.visualTicks)).toBeGreaterThan(after.visual);
    expect(await main.evaluate(() => document.visibilityState)).toBe('visible');
    await main.evaluate(() => { window.toneGain.gain.value = .3; });
    await page.bringToFront();
    await expect.poll(() => previewRed(page)).toBeGreaterThan(65);
    expect(await main.evaluate(() => ({ calls: window.captureCalls, sameContext: window.__viz.captureAudio.audioContext === window.originalContext, sameStream: window.__viz.captureAudio.stream === window.originalStream }))).toEqual({ calls: 1, sameContext: true, sameStream: true });
    expect(await page.evaluate(() => window.editorCaptureCalls)).toBe(0);
    // Remove the graph's consumers through the real editor; owner must retire
    // controllers, not retain them until the plan lease eventually expires.
    for (const id of ['color', 'audio']) {
      await page.locator(`[data-node-id=${id}] .nodes-node-title`).click();
      await page.getByRole('button', { name: 'Delete node', exact: true }).click();
    }
    await expect.poll(() => main.evaluate(() => window.__viz.patternAudio.engine.activeControllers.filter(c => c.key.includes('nodes-editor-')).length)).toBe(0);
    // Exercise actual runtime teardown while keeping the document inspectable.
    await main.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const stopped = await main.evaluate(() => window.analysisTicks);
    await page.waitForTimeout(200);
    expect(await main.evaluate(() => window.analysisTicks)).toBe(stopped);
  });
}


for (const fallback of [false, true]) {
  test(`audio clock ${fallback ? 'timer fallback' : 'real worker'} is single, bounded, stoppable and restartable`, async ({ page }) => {
    await page.goto('/?role=nodes');
    const result = await page.evaluate(async fallback => {
      const { createAudioClock } = await import('/src/platform/audio-clock.js');
      const NativeWorker = window.Worker;
      let created = 0, terminated = 0, delivered = 0;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          if (fallback) throw new Error('Worker blocked');
          super(...args); created++;
          this.addEventListener('message', () => { delivered++; });
        }
        terminate() { terminated++; super.terminate(); }
      };
      const times = [], wait = ms => new Promise(r => setTimeout(r, ms));
      const clock = createAudioClock(t => times.push(t));
      try {
        clock.start(); clock.start();
        for (let i = 0; i < 100 && times.length < 3; i++) await wait(20);
        const first = times.length;
        // Starve the main thread, then ensure wakeups don't replay in a burst.
        const until = performance.now() + 200;
        while (performance.now() < until) { /* deliberate browser integration stall */ }
        await wait(160);
        clock.stop(); clock.stop();
        const stopped = times.length;
        await wait(120);
        const afterStop = times.length;
        clock.start(); clock.start();
        for (let i = 0; i < 100 && times.length === stopped; i++) await wait(20);
        clock.stop();
        return { first, stopped, afterStop, restarted: times.length, created, terminated, delivered, gaps: times.slice(1).map((t, i) => t - times[i]) };
      } finally { clock.stop(); window.Worker = NativeWorker; }
    }, fallback);
    expect(result.first).toBeGreaterThanOrEqual(3);
    expect(result.afterStop).toBe(result.stopped);
    expect(result.restarted).toBeGreaterThan(result.stopped);
    expect(result.created).toBe(fallback ? 0 : 2);
    expect(result.terminated).toBe(result.created);
    expect(result.delivered).toBe(fallback ? 0 : result.restarted);
    expect(Math.min(...result.gaps)).toBeGreaterThan(25);
  });
}
