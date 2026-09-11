import { test, expect } from '@playwright/test';

// Supplemental renderer contract. End-to-end coverage lives in
// canvas-density-production.spec.js and wave-production-sizing.spec.js.
// A host may explicitly raise backing density after setup; test resetMatrix
// separately so moving pixelDensity(1) cannot mask a broken draw transform.
test('Canvas2D factories repaint their own surface at backing density 1 and 2, including a later resize', { tag: '@patterns' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const results = await page.evaluate(async () => {
    const { default: p5 } = await import('/node_modules/p5/lib/p5.esm.js');
    const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
    const { disposeP5Instance } = await import('/src/program-runtime.js');
    const rows=[];
    for (const id of ['pendulum-wave','counterweight','video-slit-scan','video-facet-fold','video-datamosh','video-rolling-shutter']) {
      const entry=SKETCHES.find(s=>s.id===id);
      let instance;
      await new Promise(resolve => {
        instance = new p5(p => {
          entry.factory(null, null, defaultParamValues(id), {
            // Not-ready capture covers the early opaque placeholder; the live
            // camera pipeline and populated histories are tested in the UI suite.
            createCapture: () => ({ elt: null, hide() {} }),
            audioControls: { read: () => ({ continuous: {} }) },
          })(p);
          const setup=p.setup, redraw=p.redraw.bind(p); let initial=true;
          p.setup=()=>{ setup(); p.noLoop(); };
          p.redraw=async(...args)=>{await redraw(...args); if(initial){initial=false;resolve();}};
        });
      });
      try {
        for(const density of [1,2,1]) {
          instance.pixelDensity(density);
          for(const [w,h] of [[240,140],[140,240]]) {
            instance.resizeCanvas(w,h,true);
            const ctx=instance.drawingContext;
            ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,instance.canvas.width,instance.canvas.height);ctx.restore();
            await instance.redraw();
            const data=ctx.getImageData(0,0,instance.canvas.width,instance.canvas.height).data;
            let transparent=0,magenta=0;
            for(let i=0;i<data.length;i+=4){if(data[i+3]!==255)transparent++;if(data[i]===255&&data[i+1]===0&&data[i+2]===255)magenta++;}
            rows.push({id,density,w,h,width:instance.width,height:instance.height,backing:[instance.canvas.width,instance.canvas.height],transform:[ctx.getTransform().a,ctx.getTransform().d],transparent,magenta});
          }
        }
      } finally { disposeP5Instance(instance); }
    }
    return rows;
  });
  expect(results).toHaveLength(36);
  for(const row of results) {
    expect(row,`${row.id}: ${row.density}× ${row.w}×${row.h}`).toMatchObject({
      width:row.w,height:row.h,backing:[row.w*row.density,row.h*row.density],
      transform:[row.density,row.density],transparent:0,magenta:0,
    });
  }
});
