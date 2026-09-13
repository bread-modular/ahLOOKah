import { test, expect } from '@playwright/test';

// WebGL mesh contract for the replacement core (techno-3d + character-3d). Pins
// the measured p5 2.3.x defaults: eye (0,0,800), near 80, far 8000, a focal
// scale derived from the canvas height (1 world unit == 1 px at z = 0) and a
// Y-flipped projection, so +Y is DOWN the screen. Cone geometry spans the base
// ring at -height/2 and the apex at +height/2.

const W = 320;
const H = 180;

async function withInstance(page, drawBody) {
  await page.goto('/tests/fixtures/render.html');
  return page.evaluate(async ({ source, W: width, H: height }) => {
    const { default: VizCore } = await import('/src/core/index.js');
    // eslint-disable-next-line no-new-func
    const run = new Function('p', 'VizCore', `${source}`);
    const instance = new VizCore((p) => {
      p.setup = () => {
        p.pixelDensity(1);
        p.createCanvas(width, height, p.WEBGL);
        p.noLoop();
      };
      p.draw = () => {
        p.resetMatrix();
        p.background(0);
        run(p, VizCore);
      };
    });
    await instance.whenReady();
    await instance.redraw();
    const gl = instance._renderer.GL;
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Report in top-origin rows.
    const rows = [];
    for (let topY = 0; topY < height; topY += 1) {
      let lit = 0;
      let minX = width;
      let maxX = -1;
      for (let x = 0; x < width; x += 1) {
        const i = ((height - 1 - topY) * width + x) * 4;
        if (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24) {
          lit += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      rows.push({ topY, lit, minX, maxX, width: maxX >= minX ? maxX - minX + 1 : 0 });
    }
    const litRows = rows.filter((row) => row.lit > 0);
    const summary = {
      totalLit: rows.reduce((sum, row) => sum + row.lit, 0),
      topRow: litRows[0] || null,
      bottomRow: litRows[litRows.length - 1] || null,
      widest: rows.reduce((a, b) => (b.width > a.width ? b : a), rows[0]),
      widestTop: litRows.length ? litRows.reduce((a, b) => (b.width > a.width ? b : a), litRows[0]) : null,
      widestBottom: litRows.length ? litRows.reduce((a, b) => (b.width >= a.width ? b : a), litRows[0]) : null,
      firstRows: litRows.slice(0, 4),
      lastRows: litRows.slice(-4),
    };
    await instance.remove();
    return summary;
  }, { source: drawBody, W, H });
}

test('core WebGL: default camera scale, screen Y direction and depth', { tag: '@core' }, async ({ page }) => {
  // A 100-unit cube at the origin: 1 world unit == 1 px at z = 0, so the front
  // face (z = +50) projects to ~107 px, centred on the canvas.
  const box = await withInstance(page, 'p.noStroke(); p.fill(255); p.box(100);');
  expect(box.totalLit).toBeGreaterThan(8000);
  expect(box.widest.width).toBeGreaterThanOrEqual(104);
  expect(box.widest.width).toBeLessThanOrEqual(112);
  expect(box.topRow.topY).toBeGreaterThan(28);
  expect(box.topRow.topY).toBeLessThan(44);
  expect(box.bottomRow.topY).toBeLessThan(152);
  expect(box.bottomRow.topY).toBeGreaterThan(136);
  expect(box.widest.minX).toBeGreaterThan(100);
  expect(box.widest.minX).toBeLessThan(116);

  // +Y moves DOWN the screen (the projection flips Y).
  const below = await withInstance(page, 'p.noStroke(); p.fill(255); p.translate(0, 60, 0); p.box(40);');
  expect(below.topRow.topY).toBeGreaterThan(90);
  const above = await withInstance(page, 'p.noStroke(); p.fill(255); p.translate(0, -60, 0); p.box(40);');
  expect(above.bottomRow.topY).toBeLessThan(90);

  // A 100-radius sphere spans ~200 px and is opaque (depth-tested fill).
  const sphere = await withInstance(page, 'p.noStroke(); p.fill(255); p.sphere(100, 12, 12);');
  expect(sphere.widest.width).toBeGreaterThanOrEqual(195);
  expect(sphere.widest.width).toBeLessThanOrEqual(205);
  expect(sphere.totalLit).toBeGreaterThan(20000);
});

test('core WebGL: cone orientation and wireframe strokes', { tag: '@core' }, async ({ page }) => {
  // Cone radius 50, height 200: the base ring is at y = -h/2 (screen top) and
  // the apex at y = +h/2 (screen bottom), so the widest visible row is at the
  // top edge of the viewport and the narrowest at the bottom.
  const cone = await withInstance(page, 'p.noStroke(); p.fill(255); p.cone(50, 200, 4);');
  expect(cone.totalLit).toBeGreaterThan(4000);
  expect(cone.firstRows[0].width).toBeGreaterThan(60);
  expect(cone.lastRows[cone.lastRows.length - 1].width).toBeLessThan(20);

  // noFill() + stroke() renders the mesh edges (wireframe), far fewer pixels
  // than the filled solid.
  const wire = await withInstance(page, 'p.noFill(); p.stroke(255); p.strokeWeight(1); p.box(200);');
  const solid = await withInstance(page, 'p.noStroke(); p.fill(255); p.box(200);');
  expect(wire.totalLit).toBeGreaterThan(200);
  expect(wire.totalLit).toBeLessThan(solid.totalLit / 4);

  // Wireframe sphere with grid subdivision.
  const wireSphere = await withInstance(page, 'p.noFill(); p.stroke(255); p.strokeWeight(1); p.sphere(100, 12, 12);');
  expect(wireSphere.totalLit).toBeGreaterThan(2000);

  // plane() lies in the XY plane, centred on the origin.
  const plane = await withInstance(page, 'p.noFill(); p.stroke(255); p.strokeWeight(1); p.plane(200, 100, 8, 8);');
  // Verified against main: p5 does NOT generate stroke edges for detail > 1.
  expect(plane.totalLit).toBe(0);
  const simplePlane = await withInstance(page, 'p.noFill(); p.stroke(255); p.plane(200, 100);');
  expect(simplePlane.totalLit).toBeGreaterThan(500);
  expect(simplePlane.widest.width).toBeGreaterThan(190);
  expect(simplePlane.widest.width).toBeLessThan(210);

  // 3D lines and per-vertex stroke colour.
  const lines = await withInstance(page, 'p.stroke(255, 128); p.strokeWeight(2); p.line(-100, 0, 0, 100, 0, 0);');
  expect(lines.totalLit).toBeGreaterThan(50);

  // Rotation direction: rotateZ(+90°) maps world +X onto +Y, which is DOWN the
  // screen (the projection flips Y). A sign-reversed rotation would move the
  // same quad above the centre instead.
  const rotated = await withInstance(page, 'p.noStroke(); p.fill(255); p.rotateZ(p.PI / 2); p.rect(40, -10, 60, 20);');
  expect(rotated.topRow.topY).toBeGreaterThan(120);
  expect(rotated.widest.minX).toBeGreaterThan(140);
  expect(rotated.widest.minX).toBeLessThan(180);

  // translate() before rotate() positions the rotated frame (post-multiplied
  // matrix stack, p5 order).
  const translatedRotated = await withInstance(page, 'p.noStroke(); p.fill(255); p.translate(0, 80, 0); p.rotateZ(p.PI / 2); p.rect(0, -10, 60, 20);');
  expect(translatedRotated.topRow.topY).toBeGreaterThan(160);

  // rotateX(+90°) maps world -Z onto +Y (down the screen); a box 60 units behind
  // the origin must therefore land below the centre.
  const pitched = await withInstance(page, 'p.noStroke(); p.fill(255); p.rotateX(p.PI / 2); p.translate(0, 0, -60); p.box(40);');
  expect(pitched.topRow.topY).toBeGreaterThan(120);

  // Right-handed rotations in p5's Y-down world: rotateY(+90°) maps world -Z
  // onto -X, so the same box lands LEFT of centre (a sign flip would put it on
  // the right). Together with the rotateZ/rotateX cases this pins the hand.
  const yawed = await withInstance(page, 'p.noStroke(); p.fill(255); p.rotateY(p.PI / 2); p.translate(0, 0, -60); p.box(40);');
  expect(yawed.widest.minX).toBeLessThan(150);
});

test('core WebGL: ambient and point lights shade filled meshes', { tag: '@core' }, async ({ page }) => {
  const lit = await withInstance(page, 'p.noStroke(); p.fill(255); p.ambientLight(60); p.pointLight(255, 255, 255, 0, 0, 400); p.sphere(80, 16, 12);');
  expect(lit.totalLit).toBeGreaterThan(5000);
  // pointLight(v1, v2, v3, x, y, z) with an explicit position lights the mesh.
  const pointOnly = await withInstance(page, 'p.noStroke(); p.fill(255); p.ambientLight(0); p.pointLight(255, 255, 255, 0, 0, 400); p.sphere(80, 16, 12);');
  expect(pointOnly.totalLit).toBeGreaterThan(5000);
  // p5 semantics: missing light coordinates are 0, so the light sits inside the
  // mesh and its outward normals receive no diffuse contribution.
  const insideLight = await withInstance(page, 'p.noStroke(); p.fill(255); p.ambientLight(0); p.pointLight(255); p.sphere(80, 16, 12);');
  expect(insideLight.totalLit).toBeLessThan(200);
  // Without lights the fill color is used unmodified.
  const unlit = await withInstance(page, 'p.noStroke(); p.fill(128); p.sphere(60, 12, 12);');
  expect(unlit.totalLit).toBeGreaterThan(4000);
});
