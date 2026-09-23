import { test, expect } from '@playwright/test';

// Persisted settings are ordinary user-importable configurations. Rendering,
// child surfaces, blending, transport and resize use the unmodified app.
const projectionId = 'projection-density';
async function lowerPixels(page, selector) {
  const shot = selector ? await page.locator(selector).screenshot() : await page.screenshot();
  return page.evaluate(async b64 => {
    const img = new Image(); img.src=`data:image/png;base64,${b64}`; await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
    return [[.1,.85],[.5,.85],[.9,.85]].map(([x,y])=>[...ctx.getImageData(Math.floor(c.width*x),Math.floor(c.height*y),1,1).data].slice(0,3));
  },shot.toString('base64'));
}

// The real UI path for making a pattern live is a library click. The control's own
// selection is the authoritative signal that the click was honoured; the screen's
// data-program-ids is the transport result. This fixture deliberately issues ONE
// click: a control that does not take the selection is an app-side defect and must
// stay visible here rather than be retried away, while a slow control→screen
// handshake only needs more time (the cross-page round trip is not the click).
const controlLiveId = page => page.evaluate(() => window.__viz?.liveSelection?.ids?.[0] ?? null);

async function clickLive(page, screen, id) {
  await page.locator(`#pattern-library [data-id="${id}"]`).click();
  await expect.poll(() => controlLiveId(page), { timeout: 10000, message: `the control must take the ${id} library click` }).toBe(id);
  await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids', id, { timeout: 25000 });
}

for(const deviceScaleFactor of [1,2]) test.describe(`composited canvas DPR ${deviceScaleFactor}`,()=>{
  test.use({deviceScaleFactor,viewport:{width:1440,height:800}});
  for(const mode of ['merge','projection']) test(`${mode}: no transparent quarter or previous-layer ghost`,{tag:'@patterns'},async({page,context},testInfo)=>{
    test.setTimeout(90000);
    await context.addInitScript(({projectionId})=>{
      if(localStorage.getItem('density-compositing-seeded'))return;
      localStorage.setItem('density-compositing-seeded','1');
      localStorage.setItem('viz2_slot_order',JSON.stringify(['solid-color','membrane-modes',projectionId]));
      localStorage.setItem('viz2_projection_patterns',JSON.stringify([{id:projectionId,name:'Density projection',surfaces:[
        {id:'sbase',name:'Red base',patternId:'solid-color'},
        {id:'stop',name:'Membrane',patternId:'membrane-modes'},
      ]}]));
      const quad=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],values={alphaBlend:0,'sbase:hue':0,'sbase:saturation':1,'sbase:brightness':1,'sbase:pulse':0};
      for(const s of ['sbase','stop'])quad.forEach((p,i)=>{values[`${s}:${i}x`]=p.x;values[`${s}:${i}y`]=p.y;});
      localStorage.setItem('viz2_params',JSON.stringify({'solid-color':{hue:0,saturation:1,brightness:1,pulse:0},[projectionId]:values}));
    },{projectionId});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/?role=control');
    const screen=await context.newPage();screen.on('pageerror',e=>errors.push(e.message));
    await screen.setViewportSize({width:640,height:360});await screen.goto('/?role=screen');
    await expect(screen.locator('.program-layer-live canvas').first()).toBeVisible();
    await expect(page.getByText('SCREEN ONLINE',{exact:true})).toBeVisible();
    // Boot readiness: the control panel renders its library before its preview
    // runtime exists, and the seeded live slot only proves the handshake once the
    // screen reports it. Drive the UI only after both have settled.
    await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids','solid-color',{timeout:15000});
    await expect(page.locator('#preview-stage canvas[data-preview-sketch]')).toHaveCount(1);
    if(mode==='merge'){
      await page.keyboard.down('1');await page.keyboard.down('2');await page.keyboard.up('2');await page.keyboard.up('1');
      await expect(screen.locator('.program-layer-live canvas.merge-canvas')).toHaveCount(2);
      await expect(page.locator('#preview-stage canvas')).toHaveCount(2);
    }else{
      // Boot readiness is established above: the seeded live slot already reached
      // the screen and the control's preview runtime is running.
      await clickLive(page,screen,projectionId);
      await expect(page.locator('#preview-stage .projection-output')).toBeVisible();
    }
    // Quiet output of the pattern actually projected here. 32e1bfd swapped the
    // retired Pendulum Wave surface for the retained membrane-modes shader but
    // left the old Pendulum Wave baseline [5,8,17] in place. The membrane
    // fragment program writes the base colour vec3(.01,.02,.03) → 8-bit [3,5,8]
    // wherever the nodal lattice is dark, and the projected surface is opaque, so
    // the red sbase below stays fully covered. Anything else — the uncovered
    // (255,0,0) base, a transparent quarter or a previous pattern's ghost — is
    // still outside this ±2 window and fails.
    const projectionQuiet=[3,5,8];
    // Merge mode stacks the same two surfaces as plain layers at 50%: half of the
    // red base (#ff0000) plus half of that same membrane quiet field → [129,2.5,4].
    // Measured 129/2-3/4 at both DPRs, both viewports and both roles.
    const mergeBlend=[129,3,4];
    const expected=mode==='merge'?mergeBlend:projectionQuiet;
    for(const [name,size] of [['landscape',{width:640,height:360}],['portrait',{width:360,height:640}]]){
      await screen.setViewportSize(size);
      for(const [role,target,selector] of [['output',screen,null],['control',page,'#preview-stage']]){
        // Sampling takes a live browser screenshot and the app must re-render
        // after each viewport resize, so allow more than the 5s default for a
        // loaded parallel suite. A genuinely wrong composite (uncovered red
        // base, transparent quarter, ghost) still never satisfies this.
        await expect.poll(async()=>{
          const values=await lowerPixels(target,selector);
          const uniform=values.every(rgb=>rgb.every((v,i)=>Math.abs(v-values[0][i])<=2));
          // A blended field must be uniform; a quarter-frame boundary or a ghost
          // leaves one sample showing the uncovered base or the previous layer.
          if (mode === 'merge') return values.every(rgb=>rgb.every((v,i)=>Math.abs(v-mergeBlend[i])<=2)) && uniform ? null : JSON.stringify(values);
          return values.every(rgb=>rgb.every((v,i)=>Math.abs(v-expected[i])<=2)) ? null : JSON.stringify(values);
        },{message:`${mode} ${role} ${name} lower samples`,timeout:15000}).toBe(null);
        await target.screenshot({path:testInfo.outputPath(`${mode}-${role}-${name}-dpr${deviceScaleFactor}.png`)});
      }
    }
    expect(errors).toEqual([]);await screen.close();
  });
});
