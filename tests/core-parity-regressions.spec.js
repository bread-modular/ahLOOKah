import { test, expect } from '@playwright/test';
import { noiseValue, noiseSeedValue, noiseDetailValue } from '../src/core/math.js';
import { planeGeometry, sphereGeometry } from '../src/core/geometry.js';

test('noise matches pinned main p5 seeded samples including negative coordinates', { tag: '@core' }, () => {
  // Captured using main's lockfile p5 2.3.2; see fixtures/core-baseline.mjs.
  noiseDetailValue(4, 0.5);
  noiseSeedValue(1234);
  const samples = [
    [[0,0,0],0.6696634386753431], [[.1,0,0],0.6007591595809778],
    [[.5,.25,0],0.4027165684127683], [[1.1,2.2,3.3],0.3923356040639182],
    [[-.1,-2.3,-4.5],0.5407485038755303], [[4096.2,3,4],0.3798187473360332],
  ];
  for (const [coords, expected] of samples) expect(noiseValue(...coords)).toBeCloseTo(expected, 14);
  noiseSeedValue(1234);
  expect(noiseValue(.1)).toBeCloseTo(samples[1][1], 14);
  noiseSeedValue(5678);
  expect(noiseValue(.1)).not.toBe(samples[1][1]);
});

test('wire grids include the triangle diagonals, not just latitude and longitude', { tag: '@core' }, () => {
  const sphere = sphereGeometry(20,4,4);
  expect(sphere.edges.length).toBe(sphere.indices.length * 2); // shared-edge overdraw is intentional
  expect(sphereGeometry(20,25,4).edges.length).toBe(0);
  for (const geometry of [planeGeometry(20,20,2,2), sphereGeometry(20,4,4)]) {
    const edges = new Set();
    for(let i=0;i<geometry.edges.length;i+=2) edges.add([geometry.edges[i],geometry.edges[i+1]].sort((a,b)=>a-b).join(','));
    for(let i=0;i<geometry.indices.length;i+=3) {
      const face=Array.from(geometry.indices.slice(i,i+3));
      for(let j=0;j<3;j++) expect(edges.has([face[j],face[(j+1)%3]].sort((a,b)=>a-b).join(','))).toBe(true);
    }
  }
});

test('removal before boot and during async setup cannot recreate resources or hang readiness', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: Core } = await import('/src/core/index.js');
    let earlySetup=0;
    const early=new Core(p=>{p.setup=()=>earlySetup++;});
    await early.remove(); await early.whenReady();
    let resume, entered;
    const gate=new Promise(resolve=>resume=resolve), started=new Promise(resolve=>entered=resolve);
    let draws=0;
    const p=new Core(p=>{
      p.setup=async()=>{entered(); await gate; p.createCanvas(40,40,p.WEBGL); p.createVideo([]); p.loop();};
      p.draw=()=>draws++;
    });
    await started;
    await p.remove(); await p.whenReady(); resume();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {earlySetup,draws,canvases:document.querySelectorAll('canvas').length,videos:document.querySelectorAll('video').length,setupDone:p._setupDone,loop:p.isLooping(),renderer:p._renderer};
  });
  expect(result).toEqual({earlySetup:0,draws:0,canvases:0,videos:0,setupDone:false,loop:false,renderer:null});
});

test('redraw awaits async user callback then finishDraw and excludes overlapping frames', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: Core } = await import('/src/core/index.js');
    const p=new Core(p=>{p.setup=()=>p.noLoop();});
    await p.whenReady();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    let drawDone, finishDone;
    const drawGate=new Promise(resolve=>drawDone=resolve), finishGate=new Promise(resolve=>finishDone=resolve);
    const log=[];
    p.draw=async()=>{log.push('draw');await drawGate;log.push('post-callback');};
    p._renderer.finishDraw=async()=>{log.push('finish');await finishGate;log.push('finished');};
    let resolved=false;
    const drawing=p.redraw().then(()=>{resolved=true;log.push('resolved');});
    await p.redraw();
    const duringDraw={log:[...log],resolved};
    drawDone(); await new Promise(resolve=>setTimeout(resolve,0));
    await p.redraw();
    const duringFinish={log:[...log],resolved};
    finishDone(); await drawing; await p.remove();
    return {duringDraw,duringFinish,log};
  });
  expect(result.duringDraw).toEqual({log:['draw'],resolved:false});
  expect(result.duringFinish).toEqual({log:['draw','post-callback','finish'],resolved:false});
  expect(result.log).toEqual(['draw','post-callback','finish','finished','resolved']);
});

test('ProgramRuntime publishes async callback pixels only after completion', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: Core }=await import('/src/core/index.js');
    const { ProgramRuntime }=await import('/src/program-runtime.js');
    let release, entered;
    const gate=new Promise(resolve=>release=resolve), started=new Promise(resolve=>entered=resolve);
    const log=[];
    const host=document.createElement('div');document.body.appendChild(host);
    const runtime=new ProgramRuntime({coreConstructor:Core,selection:{ids:['async'],merge:false},sketches:[{id:'async',factory:()=>p=>{
      p.setup=()=>{p.createCanvas(32,32);p.noLoop();};
      p.draw=async()=>{log.push('draw');entered();await gate;p.background(123);log.push('post-callback');};
    }}],layer:host,getSize:()=>[32,32],getParams:()=>({}),onDraw:canvas=>{log.push(`capture:${canvas.getContext('2d').getImageData(0,0,1,1).data[0]}`);}});
    const ready = runtime.prepare();
    await started;
    const before=[...log];release();
    await ready;
    const counts=[...runtime.drawCounts];runtime.dispose();
    return {before,log,counts};
  });
  expect(result.before).toEqual(['draw']);
  expect(result.log).toEqual(['draw','post-callback','capture:123']);
  expect(result.counts).toEqual([1]);
});

test('circle diameter, GL thickness/density/depth, ambient lighting and push/pop styles', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const {default:Core}=await import('/src/core/index.js');
    const rows=[];
    for(const mode of ['2d','gl']) for(const density of [1,2]) {
      const p=new Core(p=>{p.setup=()=>{p.pixelDensity(density);p.createCanvas(100,100,mode==='gl'?p.WEBGL:p.P2D);p.noLoop();};});
      await p.whenReady();await new Promise(resolve=>requestAnimationFrame(resolve));
      const snapshot=()=>{const c=document.createElement('canvas');c.width=p.canvas.width;c.height=p.canvas.height;c.getContext('2d').drawImage(p.canvas,0,0);return c.getContext('2d');};
      p.draw=()=>{p.background(0);p.noStroke();p.fill(255);p.circle(mode==='gl'?0:50,mode==='gl'?0:50,40);};
      await p.redraw();
      const ctx=snapshot();
      rows.push({mode,density,circle:ctx.getImageData(66*density,50*density,1,1).data[0]});
      if(mode==='gl') {
        for(const depth of [0,-800]) for(const width of [1,8]) {
          p.draw=()=>{p.background(0);p.stroke(255);p.strokeWeight(width);p.line(-40,0,depth,40,0,depth);};
          await p.redraw();const data=snapshot().getImageData(50*density,0,1,100*density).data;
          let lit=0;for(let i=0;i<data.length;i+=4)if(data[i]>100)lit++;
          rows.push({density,depth,width,lit});
        }
        p.draw=()=>{p.background(0);p.noStroke();p.fill(200);p.ambientLight(64);p.push();p.fill(0);p.stroke(255);p.strokeWeight(9);p.noLights();p.pop();p.box(60);};
        await p.redraw();rows.push({density,ambient:snapshot().getImageData(50*density,50*density,1,1).data[0]});
      }
      await p.remove();
    }
    return rows;
  });
  for(const row of result) {
    if('circle' in row) expect(row.circle).toBe(255);
    if('ambient' in row) expect(row.ambient).toBe(50); // p5 baseline 200 * 64/255
    if('lit' in row) expect(Math.abs(row.lit - row.width*row.density*(row.depth===0?1:.5))).toBeLessThanOrEqual(1);
  }
});
