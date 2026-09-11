import { test, expect } from '@playwright/test';
import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';

const wave = [...REPLACEMENT_PATTERNS, ...EXPANSION_PATTERNS];
expect(wave).toHaveLength(39);
const cases = [...wave, ...RESTORED_CAMERA_PATTERNS, { id: 'circles' }, { id: 'glitch-slices' }];
const output = '.program-layer-live canvas.program-canvas';
const preview = '#preview-stage canvas.preview-canvas';

async function checkCanvas(page, selector) {
  const stats = await page.locator(selector).evaluate(c => {
    const rect = c.getBoundingClientRect(), ctx = c.getContext('2d');
    const s = { width: c.width, height: c.height, cssWidth: rect.width, cssHeight: rect.height, is2D: !!ctx };
    if (ctx) {
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let missing = 0; for (let i=3; i<data.length; i+=4) if(data[i]!==255) missing++;
      s.missing = missing;
      s.transform = [ctx.getTransform().a, ctx.getTransform().d];
    }
    return s;
  });
  expect(stats.width).toBeGreaterThan(0); expect(stats.height).toBeGreaterThan(0);
  expect(stats.width / stats.height).toBeCloseTo(stats.cssWidth / stats.cssHeight, 2);
  if (stats.is2D) {
    expect(stats.missing, 'every backing pixel must be painted, not only the top-left quarter').toBe(0);
    expect(Math.abs(stats.width / stats.transform[0] - stats.cssWidth)).toBeLessThan(1);
    expect(Math.abs(stats.height / stats.transform[1] - stats.cssHeight)).toBeLessThan(1);
  }
  // Read the browser-composited screenshot, not an already-cleared WebGL buffer.
  const screenshot = await page.locator(selector).screenshot({ scale: 'css' });
  const visible = await page.evaluate(async data => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    const rgba=ctx.getImageData(0,0,c.width,c.height).data; let lit=0;
    for(let i=0;i<rgba.length;i+=4) if(Math.max(rgba[i],rgba[i+1],rgba[i+2])>24) lit++;
    return lit;
  }, screenshot.toString('base64'));
  expect(visible, 'the real presented canvas must contain a visible scene').toBeGreaterThan(20);
  return { stats, screenshot };
}

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
for (const deviceScaleFactor of [1, 2]) test.describe(`wave production DPR ${deviceScaleFactor}`, () => {
  test.use({ deviceScaleFactor, viewport: { width: 1280, height: 800 } });
  for (const pattern of cases) test(`${pattern.id} control → output, landscape → portrait → resize`, { tag: '@patterns' }, async ({ page, context }, testInfo) => {
    test.setTimeout(60_000);
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto('/?role=control');
    const screen=await context.newPage(); screen.on('pageerror', e=>errors.push(e.message));
    await screen.setViewportSize({width:480,height:270}); await screen.goto('/?role=screen');
    await expect(screen.locator(output)).toBeVisible();
    await expect(page.getByText('SCREEN ONLINE', { exact: true })).toBeVisible();
    await page.locator(`#pattern-library [data-id="${pattern.id}"]`).click();
    await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids',pattern.id,{timeout:15000});
    if(pattern.camera) {
      await expect(page.locator('#preview-stage .preview-empty')).toContainText('live video remains on the output screen');
      await expect(page.locator(preview)).toHaveCount(0);
    } else await expect(page.locator(preview)).toHaveAttribute('data-preview-sketch',pattern.id);
    const reports=[];
    for(const [name,size] of [['landscape',{width:480,height:270}],['portrait',{width:270,height:480}],['resized',{width:640,height:360}]]) {
      await screen.setViewportSize(size);
      await expect.poll(()=>screen.locator(output).evaluate(c=>[Math.round(c.getBoundingClientRect().width),Math.round(c.getBoundingClientRect().height)])).toEqual([size.width,size.height]);
      const result=await checkCanvas(screen,output); reports.push({name,role:'output',...result.stats});
      await testInfo.attach(`${pattern.id}-output-${name}-dpr${deviceScaleFactor}`,{body:result.screenshot,contentType:'image/png'});
      if(!pattern.camera) {
        await page.setViewportSize(name==='portrait'?{width:1100,height:1000}:{width:1440,height:720});
        await expect.poll(()=>page.locator(preview).evaluate(c=>Math.abs(c.width/c.height-c.clientWidth/c.clientHeight))).toBeLessThan(.01);
        const r=await checkCanvas(page,preview); reports.push({name,role:'preview',...r.stats});
        await testInfo.attach(`${pattern.id}-preview-${name}-dpr${deviceScaleFactor}`,{body:r.screenshot,contentType:'image/png'});
      }
    }
    await testInfo.attach('sizing',{body:JSON.stringify(reports,null,2),contentType:'application/json'});
    expect(errors).toEqual([]); await screen.close();
  });
});
