// Compose expansion contact sheets + animated previews from the visuals-audit
// artifacts (test-results/expansion-evidence/<id>/{silence,modest,strong,diff}.png
// and pulse-NN.png animation frames). Renders in headless Chromium — no native deps.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const root = 'test-results/expansion-evidence';
const outDir = 'docs/expansion-evidence';
fs.mkdirSync(outDir, { recursive: true });

const ids = fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const groups = {
  'Simple / Rhythmic': ['lissajous-scope', 'pendulum-wave', 'step-sequencer', 'stutter-buffer'],
  '3D (2 + 3 Techno descendants)': ['voxel-cascade', 'gyro-lattice', 'techno-torus', 'techno-helix', 'techno-array'],
  'Cinematic / Neon / Glitch': ['godray-forge', 'feedback-bloom', 'galvo-sweep', 'neon-sign', 'vhs-head-switch', 'dct-blocks'],
  'Video FX / Basics / Alphas': ['video-datamosh', 'video-rolling-shutter', 'waveform-monitor', 'test-card', 'gobo-wheel', 'blinder-matrix'],
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

async function sheet(title, ids2, file, { animated = false } = {}) {
  const cellW = 320, cellH = 180;
  const cols = animated ? 6 : 4;
  const rows = animated ? ids2.length : ids2.length;
  const data = ids2.map((id) => {
    const read = (name) => 'data:image/png;base64,' + fs.readFileSync(`${root}/${id}/${name}.png`).toString('base64');
    if (animated) return { id, imgs: ['pulse-08', 'pulse-12', 'pulse-16', 'pulse-20', 'pulse-23', 'diff-20'].map(read) };
    return { id, imgs: ['silence', 'modest', 'strong', 'diff'].map(read) };
  });
  const result = await page.evaluate(async ({ data, title, cols, cellW, cellH, animated }) => {
    const rows = data.length;
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW + (cols + 1) * 8;
    canvas.height = rows * (cellH + 22) + 34;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0d14'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e8ecf4'; ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(title, 10, 21);
    ctx.font = '11px system-ui, sans-serif';
    const labels = animated
      ? ['pulse f8', 'pulse f12', 'pulse f16', 'pulse f20', 'pulse f23', 'silence-vs-pulse diff']
      : ['silence', 'modest 0.2 all bands', 'strong 0.85', 'silence-vs-modest diff'];
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    for (const [r, row] of data.entries()) {
      ctx.fillStyle = '#9fb2d8';
      ctx.fillText(row.id, 8, 34 + 22 + r * (cellH + 22) - 8);
      for (const [c, src] of row.imgs.entries()) {
        const img = await load(src);
        const x = 8 + c * (cellW + 8), y = 34 + r * (cellH + 22);
        ctx.drawImage(img, x, y, cellW, cellH);
        ctx.strokeStyle = '#2a3348'; ctx.strokeRect(x + .5, y + .5, cellW - 1, cellH - 1);
        ctx.fillStyle = '#7286ad'; ctx.fillText(labels[c], x + 4, y + cellH - 6);
      }
    }
    return canvas.toDataURL('image/png');
  }, { data, title, cols, cellW, cellH, animated });
  fs.writeFileSync(`${outDir}/${file}`, Buffer.from(result.split(',')[1], 'base64'));
  console.log('wrote', `${outDir}/${file}`);
}

for (const [title, ids2] of Object.entries(groups)) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await sheet(`Expansion wave — ${title}`, ids2, `sheet-${slug}.png`);
}
// One animated (pulse-locked) sheet across representative patterns.
await sheet('Expansion wave — pulse-locked animation frames (beat on/off)', [
  'lissajous-scope', 'step-sequencer', 'techno-torus', 'godray-forge', 'video-datamosh', 'gobo-wheel',
], 'sheet-animated-pulse.png', { animated: true });

// Restored camera pair: from the integration/lifecycle run render them now via the audit harness format.
await browser.close();
console.log('done');
