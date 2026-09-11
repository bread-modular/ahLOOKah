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

for(const deviceScaleFactor of [1,2]) test.describe(`composited canvas DPR ${deviceScaleFactor}`,()=>{
  test.use({deviceScaleFactor,viewport:{width:1440,height:800}});
  for(const mode of ['merge','projection']) test(`${mode}: no transparent quarter or previous-layer ghost`,{tag:'@patterns'},async({page,context},testInfo)=>{
    test.setTimeout(60000);
    await context.addInitScript(({projectionId})=>{
      if(localStorage.getItem('density-compositing-seeded'))return;
      localStorage.setItem('density-compositing-seeded','1');
      localStorage.setItem('viz2_slot_order',JSON.stringify(['solid-color','pendulum-wave',projectionId]));
      localStorage.setItem('viz2_projection_patterns',JSON.stringify([{id:projectionId,name:'Density projection',surfaces:[
        {id:'sbase',name:'Red base',patternId:'solid-color'},
        {id:'stop',name:'Pendulum',patternId:'pendulum-wave'},
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
    if(mode==='merge'){
      await page.keyboard.down('1');await page.keyboard.down('2');await page.keyboard.up('2');await page.keyboard.up('1');
      await expect(screen.locator('.program-layer-live canvas.merge-canvas')).toHaveCount(2);
      await expect(page.locator('#preview-stage canvas')).toHaveCount(2);
    }else{
      await page.locator(`#pattern-library [data-id="${projectionId}"]`).click();
      await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids',projectionId);
      await expect(page.locator('#preview-stage .projection-output')).toBeVisible();
    }
    const expected=mode==='merge'?[130,4,9]:[5,8,17];
    for(const [name,size] of [['landscape',{width:640,height:360}],['portrait',{width:360,height:640}]]){
      await screen.setViewportSize(size);
      for(const [role,target,selector] of [['output',screen,null],['control',page,'#preview-stage']]){
        await expect.poll(async()=>{
          const values=await lowerPixels(target,selector);
          // The browser's compositing/color conversion can round a 50% blend
          // differently. Require a uniform blended field, never the uncovered
          // red base (255,0,0), rather than hard-coding that conversion.
          if (mode === 'merge') return values.every(rgb => rgb[0] > 100 && rgb[0] < 160 && rgb[1] > 0 && rgb[2] > 0)
            && values.every(rgb => rgb.every((v,i) => Math.abs(v-values[0][i]) <= 2));
          return values.every(rgb=>rgb.every((v,i)=>Math.abs(v-expected[i])<=2));
        }).toBe(true);
        await target.screenshot({path:testInfo.outputPath(`${mode}-${role}-${name}-dpr${deviceScaleFactor}.png`)});
      }
    }
    expect(errors).toEqual([]);await screen.close();
  });
});
