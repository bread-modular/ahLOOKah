import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const density of [1, 2]) test(`background alpha and clear preserve blend/transform at density ${density}`, { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async density => {
    const { default: Core } = await import('/src/core/index.js');
    const p = new Core(p => { p.setup = () => { p.createCanvas(16,16); p.pixelDensity(density); p.noLoop(); }; });
    await p.whenReady();
    const ctx = p.drawingContext;
    const pixel = () => Array.from(ctx.getImageData(0,0,1,1).data);
    p.background(200); p.blendMode(p.ADD); p.noStroke(); p.fill(10); p.rect(0,0,16,16);
    p.blendMode(p.BLEND);
    const immediate = ctx.globalCompositeOperation;
    p.translate(4,5); p.background(0,128);
    const faded = pixel(), transform = [ctx.getTransform().e,ctx.getTransform().f];
    for (let i=0;i<20;i++) p.background(0,128);
    const decayed = pixel();
    p.background(80); const opaque = pixel();
    p.push(); p.blendMode(p.ADD); p.background(20);
    const added = pixel(); p.pop();
    const restored = ctx.globalCompositeOperation;
    p.background(30); const afterPop = pixel();
    p.blendMode(p.ADD); p.clear();
    const cleared = pixel(), afterClear = ctx.globalCompositeOperation;
    await p.remove();
    return { immediate,faded,transform,decayed,opaque,added,restored,afterPop,cleared,afterClear };
  }, density);
  expect(result).toEqual({ immediate:'source-over', faded:[105,105,105,255], transform:[4*density,5*density], decayed:[0,0,0,255], opaque:[80,80,80,255], added:[100,100,100,255], restored:'source-over', afterPop:[30,30,30,255], cleared:[0,0,0,0], afterClear:'lighter' });
});

for (const id of ['chroma-mandala','echo-ripples']) {
  for (const transport of ['controls','legacy']) test(`${id} ${transport} clears across 1200 active frames then 200 quiet frames`, { tag: ['@core','@patterns'] }, async ({ page }, testInfo) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async ({ id,transport }) => {
      const { default: Core } = await import('/src/core/index.js');
      const { SKETCHES,defaultParamValues } = await import('/src/sketch-registry.js');
      const entry = SKETCHES.find(s=>s.id===id);
      let frame=0, active=true;
      const bins = new Uint8Array(1024);
      const controller = entry.createAudioController();
      const params = defaultParamValues(id);
      let controls;
      const audio = { isStarted:true, getFrequencies:()=>({left:bins,right:bins}) };
      const runtime = transport==='controls' ? { audioControls: { read:()=>controls, consumeEvents:()=>controls.events } } : {};
      const p = new Core(p=>{
        entry.factory(audio,null,params,runtime)(p);
        p.setup=()=>{p.createCanvas(480,320);p.pixelDensity(1);p.colorMode(p.HSB,360,100,100,255);p.noLoop();};
        const draw=p.draw;
        p.draw=()=>{if(frame) draw();};
      });
      await p.whenReady();
      // Let the initial noLoop boot draw finish before explicit redraws.
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const pixels=()=>p.drawingContext.getImageData(0,0,480,320).data;
      async function step() {
        frame++; bins.fill(active ? (frame%30<4 ? 160 : 35) : 0);
        controls=controller.update({shared:{getByteFrequencies:()=>({left:bins,right:bins})},params,deltaSeconds:1/30});
        await p.redraw();
      }
      for(let i=0;i<1200;i++) await step();
      const png=p.canvas.toDataURL();
      const activePixels=pixels();
      let white=0,lit=0;
      for(let i=0;i<activePixels.length;i+=4){if(Math.min(...activePixels.slice(i,i+3))>245)white++;if(Math.max(...activePixels.slice(i,i+3))>20)lit++;}
      active=false;
      for(let i=0;i<200;i++) await step();
      const quiet=pixels();
      // Inject a remote mark after ADD drawing. The pattern's very next opaque
      // BLEND background must erase it, without changing the factory itself.
      p.noStroke();p.fill(0,0,100,255);p.rect(0,0,8,8);
      await step();
      const corner=Array.from(p.drawingContext.getImageData(2,2,1,1).data);
      let outside=0;
      for(let y=0;y<320;y++)for(let x=0;x<480;x++)if(Math.hypot(x-240,y-160)>100){const i=(y*480+x)*4;outside=Math.max(outside,quiet[i],quiet[i+1],quiet[i+2]);}
      const mode=p.drawingContext.globalCompositeOperation;
      await p.remove(); controller.dispose();
      return {png,white,lit,outside,corner,mode,frame};
    }, {id,transport});
    const screenshot=testInfo.outputPath(`${id}-${transport}-1200.png`);
    await writeFile(screenshot,Buffer.from(result.png.split(',')[1],'base64'));
    await testInfo.attach('1200 frames',{path:screenshot,contentType:'image/png'});
    expect(result.frame).toBe(1401);
    expect(result.white).toBeLessThan(480*320*0.01);
    expect(result.lit).toBeGreaterThan(100);
    expect(result.outside).toBe(0);
    expect(result.corner).toEqual([0,0,0,255]);
    expect(result.mode).toBe('lighter');
  });
}
