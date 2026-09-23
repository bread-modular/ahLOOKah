import { test, expect } from '@playwright/test';
import { stageSources } from '../src/custom-scripts/compiler.js';
import { adaptPattern } from '../src/custom-scripts/adapter.js';

const source = (extra = '') => `api.requireVersion(1); api.create({id:'custom-fx-test',name:'FX test',draw(){},${extra}});`;
const entry = (definition) => ({ file: 'fx.viz.js', definition: { id: 'custom-fx-test', name: 'FX test', draw() {}, ...definition } });

test.describe('Custom script image-input FX @core', () => {
  test('only the exact optional image capability validates and reaches the registry descriptor', () => {
    const [staged] = stageSources([{ name: 'fx.viz.js', text: source("camera:true,fx:{input:'image'}") }]);
    expect(staged.definition.fx).toEqual({ input: 'image' });
    expect(Object.isFrozen(staged.definition.fx)).toBe(true);
    const sketch = adaptPattern(staged, () => {});
    expect(sketch.fx).toEqual({ input: 'image' });
    expect(Object.isFrozen(sketch.fx)).toBe(true);
    expect(sketch.camera).toBe(true); // Source-mode camera metadata is not erased.
    const legacy = adaptPattern(stageSources([{ name: 'old.viz.js', text: source('camera:true') }])[0], () => {});
    expect(legacy).not.toHaveProperty('fx');
    expect(legacy.camera).toBe(true);

    for (const bad of [
      'undefined', 'null', '[]', "'image'", '{}', "{input:'video'}", "{input:'IMAGE'}",
      "{input:'image',outputs:2}", 'new Date()',
      "Object.defineProperty({input:'image'},'extra',{value:1})",
      "Object.defineProperty({},'input',{value:'image'})",
      "Object.defineProperty({},'input',{enumerable:true,get(){return 'image'}})",
      "{input:'image',[Symbol('extra')]:1}",
    ]) {
      expect(() => stageSources([{ name: 'fx.viz.js', text: source(`fx:${bad}`) }]), bad).toThrow(/fx.*(plain object|unknown field|contain only input|input must be image)/);
    }
    expect(() => stageSources([{ name: 'fx.viz.js', text: `${source("fx:{input:'image'}")} api.update('custom-fx-test',{fx:{input:'video'}});` }])).toThrow(/fx\.input must be image/);
    expect(() => stageSources([{ name: 'fx.viz.js', text: "api.requireVersion(1);api.create({id:'custom-fx-test',name:'FX',fx:{input:'image'},async draw(){}});" }])).toThrow(/synchronous function/);
  });

  test('FX draw borrows only the current image, separates audio, blocks both capture paths, clears on error/dispose', () => {
    const image = { source: {}, width: 10, height: 8, frameId: 3, timestampMs: 123, generation: 2 };
    const audio = { frame: { left: new Float32Array([42]) } };
    let current = image, reads = 0, rawCalls = 0, sharedCalls = 0, stops = 0, removals = 0, fail = false;
    const observed = [], errors = [];
    let context;
    const sketch = adaptPattern(entry({ fx: { input: 'image' }, camera: true,
      preload(ctx) {
        expect(ctx.inputMode).toBe('fx'); expect(ctx.imageInput).toBeNull();
        expect(() => ctx.p.createCapture()).toThrow(/camera capture is unavailable in FX mode/);
      },
      setup(ctx) {
        context = ctx;
        expect(ctx.imageInput).toBeNull();
        expect(Object.getOwnPropertyDescriptor(ctx, 'inputMode').writable).toBe(false);
        expect(Object.getOwnPropertyDescriptor(ctx, 'imageInput').set).toBeUndefined();
        for (const capture of [() => ctx.createCapture({ video: true }), () => ctx.p.createCapture({ video: true })]) {
          expect(capture).toThrow(/camera capture is unavailable in FX mode/);
        }
      },
      draw(ctx) {
        expect(ctx.audio).toBe(audio);
        expect(ctx.inputMode).toBe('fx');
        observed.push(ctx.imageInput);
        if (fail) throw new Error('broken effect');
      },
      dispose(ctx) { expect(ctx.imageInput).toBeNull(); },
    }), message => errors.push(message));
    const rawCapture = () => { rawCalls++; return {}; };
    const p = { createCapture: rawCapture, remove() { removals++; }, createCanvas() {}, noLoop() { stops++; } };
    sketch.factory(audio, null, {}, { inputMode: 'fx', getImageInput: () => { reads++; return current; }, createCapture() { sharedCalls++; return {}; } })(p);
    expect(p.createCapture).not.toBe(rawCapture);
    p.preload(); p.setup();
    expect(reads).toBe(0); // Neither preload nor setup can borrow a frame.
    p.draw(); expect(observed).toEqual([image]); expect(context.imageInput).toBeNull();
    current = null; p.draw(); expect(observed).toEqual([image, null]); expect(context.imageInput).toBeNull();
    current = image; fail = true;
    expect(() => p.draw()).toThrow('broken effect');
    expect(context.imageInput).toBeNull();
    expect(stops).toBe(1);
    expect(errors).toEqual(['fx.viz.js: custom-fx-test.draw: broken effect']);
    p.remove(); p.remove();
    expect(context.imageInput).toBeNull();
    expect(context.signal.aborted).toBe(true);
    expect(p.createCapture).toBe(rawCapture);
    expect({ reads, rawCalls, sharedCalls, removals }).toEqual({ reads: 3, rawCalls: 0, sharedCalls: 0, removals: 2 });
  });

  test('unsupported FX/invalid modes fail before capture; source defaults and capture paths remain unchanged', () => {
    let rawCalls = 0, sharedCalls = 0, providerCalls = 0, observed;
    const rawCapture = () => { rawCalls++; return 'raw'; };
    const p = () => ({ createCapture: rawCapture, createCanvas() {}, remove() {}, noLoop() {} });
    const definition = { camera: true, setup(ctx) { observed = [ctx.inputMode, ctx.imageInput, ctx.createCapture()]; }, draw(ctx) { observed.push(ctx.imageInput); } };
    const sourceOnly = adaptPattern(entry(definition), () => {});
    const capable = adaptPattern(entry({ ...definition, fx: { input: 'image' } }), () => {});
    const plain = p();
    sourceOnly.factory({}, null, {}, {})(plain);
    plain.setup(); plain.draw();
    expect(observed).toEqual(['source', null, 'raw', null]);
    expect(plain.createCapture).toBe(rawCapture);
    const bound = p();
    capable.factory({}, null, {}, { inputMode: 'source', getImageInput() { providerCalls++; }, createCapture() { sharedCalls++; return 'shared'; } })(bound);
    bound.setup(); bound.draw();
    expect(observed).toEqual(['source', null, 'shared', null]);
    expect(bound.createCapture).toBe(rawCapture);
    expect({ rawCalls, sharedCalls, providerCalls }).toEqual({ rawCalls: 1, sharedCalls: 1, providerCalls: 0 });
    expect(() => sourceOnly.factory({}, null, {}, { inputMode: 'fx' })(p())).toThrow(/FX mode requires fx/);
    expect(() => capable.factory({}, null, {}, { inputMode: 'camera' })(p())).toThrow(/invalid inputMode/);
    let unboundInput = 'not drawn';
    const unbound = adaptPattern(entry({ fx: { input: 'image' }, draw(ctx) { unboundInput = ctx.imageInput; } }), () => {});
    const fx = p(); unbound.factory({}, null, {}, { inputMode: 'fx' })(fx); fx.draw(); fx.remove();
    expect(unboundInput).toBeNull(); // No provider is an unavailable input, not a camera fallback.
    expect({ rawCalls, sharedCalls }).toEqual({ rawCalls: 1, sharedCalls: 1 });
  });

  test('a failed FX reload retains last-good definitions; valid capability removal changes registry explicitly', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { CustomScripts } = await import('/src/custom-scripts/service.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const memory = new Map(), changes = [];
      const storage = async function (key, value) { if (arguments.length === 1) return memory.get(key); memory.set(key, value); };
      const scripts = new CustomScripts({ storage, onChange: ids => changes.push([...ids]) });
      const make = fx => `api.requireVersion(1);api.create({id:'custom-reload-fx',name:'Reload FX',${fx}draw(){}});`;
      const good = make("fx:{input:'image'},");
      await scripts.commit([{ name: 'reload.viz.js', text: good }]);
      const receiverChanges = [];
      const receiver = new CustomScripts({ role: 'screen', storage, onChange: ids => receiverChanges.push([...ids]) });
      await receiver.restore(); // A receiving window revalidates the stored source independently.
      const recipientHasFx = receiver.entries[0].definition.fx.input === 'image';
      const previous = SKETCHES.find(s => s.id === 'custom-reload-fx');
      let error;
      try { await scripts.commit([{ name: 'reload.viz.js', text: make("fx:{input:'video'},") }]); }
      catch (e) { error = e.message; }
      const retained = previous === SKETCHES.find(s => s.id === 'custom-reload-fx')
        && scripts.entries[0].definition.fx.input === 'image'
        && (await storage('active')).sources[0].text === good;
      await scripts.commit([{ name: 'reload.viz.js', text: make('') }]);
      await receiver.restore();
      const removed = SKETCHES.find(s => s.id === 'custom-reload-fx');
      const recipientRemovedFx = !receiver.entries[0].definition.fx;
      scripts.close(); receiver.close();
      return { error, retained, recipientHasFx, recipientRemovedFx, before: previous.fx, after: removed.fx || null, camera: removed.camera, changes, receiverChanges };
    });
    expect(result.error).toContain('fx.input must be image');
    expect(result).toMatchObject({ retained: true, recipientHasFx: true, recipientRemovedFx: true, before: { input: 'image' }, after: null, camera: false });
    expect(result.changes).toEqual([['custom-reload-fx'], ['custom-reload-fx']]);
    expect(result.receiverChanges).toEqual([['custom-reload-fx'], ['custom-reload-fx']]);
  });

  test('actual Canvas2D and WebGL consumers read a reused graph canvas and clear missing input', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const results = await page.evaluate(async () => {
      const { adaptPattern } = await import('/src/custom-scripts/adapter.js');
      const { default: VizCore } = await import('/src/core/index.js');
      const out = [];
      for (const renderer of ['2d', 'webgl']) {
        const source = document.createElement('canvas'); source.width = source.height = 8;
        const paint = color => { const c = source.getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, 8, 8); };
        paint('#ff0000');
        let input = { source, width: 8, height: 8, frameId: 1, timestampMs: 5, generation: 1 };
        let doneFirst;
        const first = new Promise(resolve => { doneFirst = resolve; });
        const frames = [], errors = [];
        const sketch = adaptPattern({ file: 'render.viz.js', definition: {
          id: 'custom-render-fx', name: 'Render FX', fx: { input: 'image' }, renderer,
          setup({ p, state, inputMode, imageInput }) {
            if (inputMode !== 'fx' || imageInput !== null) throw Error('unexpected setup input');
            p.pixelDensity(1); p.resizeCanvas(8, 8, true); p.noLoop();
            if (renderer === 'webgl') state.shader = p.createShader(`
              precision highp float; attribute vec3 aPosition; attribute vec2 aTexCoord; varying vec2 uv;
              void main(){ uv=aTexCoord; gl_Position=vec4(aPosition.xy*2.0-1.0,0.0,1.0); }
            `, `
              precision highp float; varying vec2 uv; uniform sampler2D uImage;
              void main(){ gl_FragColor=texture2D(uImage,uv); }
            `);
          },
          draw({ p, state, imageInput, inputMode }) {
            if (inputMode !== 'fx') throw Error('unexpected source mode');
            frames.push(imageInput?.frameId ?? null);
            p.clear();
            if (imageInput) {
              if (renderer === 'webgl') {
                p.shader(state.shader); state.shader.setUniform('uImage', imageInput.source);
                p.rect(0, 0, p.width, p.height);
              } else p.image(imageInput.source, 0, 0, p.width, p.height);
            }
            doneFirst();
          },
        } }, message => errors.push(message));
        const inst = new VizCore(sketch.factory({}, null, {}, { inputMode: 'fx', getImageInput: () => input }));
        await inst.whenReady(); await first;
        const idle = async () => { while (inst._redrawing) await new Promise(resolve => requestAnimationFrame(resolve)); };
        const pixel = () => {
          if (renderer === '2d') return [...inst.drawingContext.getImageData(4, 4, 1, 1).data];
          const gl = inst.drawingContext, rgba = new Uint8Array(4);
          gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
          return [...rgba];
        };
        await idle();
        const red = pixel();
        paint('#0000ff');
        input = { ...input, frameId: 2, timestampMs: 10 };
        await inst.redraw(); const blue = pixel();
        input = null; await inst.redraw(); const empty = pixel();
        out.push({ renderer, frames, red, blue, empty, errors });
        await inst.remove();
      }
      return out;
    });
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.frames).toEqual([1, 2, null]);
      expect(result.red[0]).toBeGreaterThan(220);
      expect(result.red[2]).toBeLessThan(30);
      expect(result.blue[2]).toBeGreaterThan(220);
      expect(result.blue[0]).toBeLessThan(30);
      expect(result.empty[3]).toBe(0);
    }
  });
});
