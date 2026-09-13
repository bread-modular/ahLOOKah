// Optional review audit; p5 is NEVER a production/test dependency.
// P5_BASELINE_LIB=/absolute/path/to/main-install/node_modules/p5/lib/p5.min.js
// BASE_URL=http://localhost:5310 node tests/fixtures/core-baseline.mjs
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (!process.env.P5_BASELINE_LIB) throw new Error('Set P5_BASELINE_LIB to the separately installed main baseline');
const out = process.env.BASELINE_OUTPUT || 'test-results/core-baseline';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
await page.goto(`${process.env.BASE_URL || 'http://localhost:5310'}/tests/fixtures/render.html`);
await page.waitForLoadState('networkidle');
await page.addScriptTag({ path: process.env.P5_BASELINE_LIB });
const results = await page.evaluate(async () => {
  const { default: Core } = await import('/src/core/index.js');
  const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
  p5.disableFriendlyErrors = true;
  const cases = [
    ['canvas2d', false, p => { p.background(12); p.noStroke(); p.fill(220,40,90); p.circle(85,80,70); p.push(); p.translate(190,90); p.rotate(.3); p.fill(30,180,220,180); p.rect(-30,-30,60,60); p.pop(); }],
    ['shader', true, p => { const s = p._auditShader ||= p.createShader('attribute vec3 aPosition; varying vec2 uv; void main(){uv=aPosition.xy;gl_Position=vec4(aPosition.xy*2.-1.,0.,1.);}', 'precision highp float; varying vec2 uv; void main(){gl_FragColor=vec4(uv,0.25,1.);}'); p.shader(s); p.rect(-160,-90,320,180); }],
    ['lit-sphere', true, p => { p.background(0); p.noStroke(); p.fill(200); p.ambientLight(20); p.pointLight(255,255,255,0,-300,300); p.sphere(65,16,12); }],
    ['ambient-only', true, p => { p.background(0); p.noStroke(); p.fill(200); p.ambientLight(64); p.box(80); }],
    ['thick-line', true, p => { p.background(0); p.stroke(255); p.strokeWeight(8); p.line(-100,0,0,100,0,0); }],
    ['wire-box', true, p => { p.background(0); p.noFill(); p.stroke(255); p.strokeWeight(6); p.rotateX(.3); p.rotateY(.5); p.box(100); }],
    ['wire-sphere', true, p => { p.background(0); p.noFill(); p.stroke(255); p.strokeWeight(3); p.sphere(65,12,12); }],
    ...['pendulum-wave','gradient-wash','event-horizon','techno3d','character3d'].map(id => [id, null, null]),
  ];
  async function render(Renderer, [id, gl, draw]) {
    let seed = 12345;
    const random = Math.random;
    Math.random = () => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed/4294967296; };
    let p, armed = false, first = true;
    const ready = new Promise(resolve => {
      p = new Renderer(p => {
        if (gl === null) {
          const entry = SKETCHES.find(s => s.id === id);
          // Real factory/controller, deterministic neutral audio and elapsed time.
          const controller = entry.createAudioController?.({ rng: Math.random });
          const params = defaultParamValues(id);
          const runtime = { audioControls: { consumeEvents: () => [], read: () => controller.update({ frame: {}, shared: { getFeatures: () => ({}), getByteFrequencies: () => ({ left: null, right: null }) }, params, deltaSeconds: 1/30 }) } };
          entry.factory(null,null,params,runtime)(p);
          const setup = p.setup, original = p.draw;
          p.setup = async () => { await setup(); p.pixelDensity(1); p.resizeCanvas(320,180,true); p.noLoop(); };
          p.draw = () => { if (armed) { p.deltaTime = 1000/30; return original(); } };
        } else {
          p.setup = () => { p.pixelDensity(1); p.createCanvas(320,180,gl ? p.WEBGL : p.P2D); p.noLoop(); };
          p.draw = () => { if (armed) draw(p); };
        }
        p.noiseSeed(1234);
        const redraw = p.redraw.bind(p);
        p.redraw = async (...args) => { await redraw(...args); if (first) { first=false; resolve(); } };
      });
    });
    try {
      await ready;
      armed = true;
      for (let frame=0; frame<8; frame++) await p.redraw();
      const c = document.createElement('canvas'); c.width=320; c.height=180;
      c.getContext('2d').drawImage(p.canvas,0,0);
      return { pixels: Array.from(c.getContext('2d').getImageData(0,0,320,180).data), png: c.toDataURL() };
    } finally {
      Math.random = random;
      const gl = p?._renderer?.GL;
      await p?.remove();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  const rows=[];
  for (const c of cases) {
    try {
      const before = await render(p5,c), after = await render(Core,c);
      let sum=0, changed=0, max=0;
      for (let i=0;i<before.pixels.length;i+=4) {
        let delta=0;
        for(let j=0;j<3;j++){const d=Math.abs(before.pixels[i+j]-after.pixels[i+j]);sum+=d;delta=Math.max(delta,d);max=Math.max(max,d);}
        if(delta>16)changed++;
      }
      rows.push({ id:c[0], meanRGB:sum/(320*180*3), changedFraction:changed/(320*180), maxDelta:max, before:before.png, after:after.png });
    } catch(error) { rows.push({id:c[0],error:String(error)}); }
  }
  const seed=1234, coords=[[0,0,0],[.1,0,0],[.5,.25,0],[1.1,2.2,3.3],[-.1,-2.3,-4.5],[4096.2,3,4]];
  const old = new p5(p=>{p.setup=()=>p.noLoop();});
  const core = new Core(p=>{p.setup=()=>p.noLoop();});
  old.noiseSeed(seed); core.noiseSeed(seed);
  const noise = coords.map(c=>({coords:c,p5:old.noise(...c),core:core.noise(...c)}));
  await old.remove(); await core.remove();
  const circleProbe = await new Promise(resolve => new p5(p => {
    p.setup = () => { p.pixelDensity(1); p.createCanvas(8,8); p.noLoop(); };
    p.draw = () => { p.clear(); p.noStroke(); p.fill(255); p.circle(4,4,6); const value = Array.from(p.drawingContext.getImageData(1,1,1,1).data); resolve(value); p.remove(); };
  }));
  return { rows, noise, circleProbe };
});
for (const row of results.rows) {
  for (const key of ['before','after']) if(row[key]) {
    await writeFile(path.join(out,`${row.id}-${key}.png`),Buffer.from(row[key].split(',')[1],'base64'));
    delete row[key];
  }
}
await writeFile(path.join(out,'metrics.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
await browser.close();
