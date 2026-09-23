# Blend modes and the Transform image node

The node graph gained TouchDesigner's Composite TOP blend-mode list and a
**Transform** image node (move / scale / rotate in X, Y and Z). This document
records the contracts, the formulas, the failure behavior and how to verify them.

## 1. Compatibility rule

- A graph stores only a mode **name**, so a file never depends on which engine
  rendered it. Modes the graph always supported keep their exact canvas
  operations and their exact pixels (`Normal`, `Multiply`, `Screen`, `Overlay`,
  `Difference`, `Add`).
- Mode names are now the TouchDesigner ones, except `Normal` (TD's *Over*), which
  is kept because graphs saved before this table contain it. An unknown or
  mis-cased mode is still rejected at load.
- The Transform node is additive: no existing node type, port, parameter or file
  version changes. It has no version gate because it introduces no new wire
  semantics (unlike the Camera node and pattern image inputs, which need v2).
- TouchDesigner operations with no published formula are **not** offered instead
  of being guessed: `inverse`, `subtractive`, `chromadifference`,
  `luminancedifference`, `inside/outside/stencil luminance`, `yfilm`, `zfilm`.

## 2. Blend modes

| Class | Count | Implementation |
| --- | --- | --- |
| Canvas | 21 | `globalCompositeOperation` in `src/nodes/runtime.js#composite` — Chrome's own compositor, no extra cost |
| WebGL2 | 15 | one shared context in `src/nodes/gl-compositor.js`, shader assembled from the table in `src/nodes/blend-modes.js` |

Canvas modes: Normal (TD *Over*), Add (TD *Add / Linear Dodge*), Multiply, Screen,
Overlay, Darken (TD *Dimmest*), Lighten (TD *Brightest*), Color Dodge, Color Burn,
Hard Light, Soft Light, Difference, Exclusion, Under, Inside (TD *Atop*), Outside,
Xor, Hue, Saturation, Color, Luminosity.

WebGL2 modes and their per-channel formulas (`b` = base, `s` = layer,
`burn`/`dodge` are the W3C Color Burn / Color Dodge helpers):

| Mode | Formula |
| --- | --- |
| Subtract | `max(b − s, 0)` |
| Divide | `s ≤ 0 ? 1 : clamp(b / s, 0, 1)` |
| Average | `(b + s) / 2` |
| Linear Burn | `clamp(b + s − 1, 0, 1)` |
| Vivid Light | `s < 0.5 ? burn(b, 2s) : dodge(b, 2s − 1)` |
| Linear Light | `clamp(b + 2s − 1, 0, 1)` |
| Pin Light | `s < 0.5 ? min(b, 2s) : max(b, 2s − 1)` |
| Hard Mix | `b + s ≥ 1 ? 1 : 0` |
| Negate | `1 − |1 − b − s|` |
| Reflect | `s ≥ 1 ? 1 : min(b² / (1 − s), 1)` |
| Glow | `b ≥ 1 ? 1 : min(s² / (1 − b), 1)` |
| Freeze | `s ≤ 0 ? 0 : 1 − min((1 − b)² / s, 1)` |
| Heat | `b ≤ 0 ? 0 : 1 − min((1 − s)² / b, 1)` |
| Darker Color | whole pixel with the lower Rec.709 luma |
| Lighter Color | whole pixel with the higher Rec.709 luma |

Glow is Reflect with the operands swapped, Freeze inverts Reflect and Heat
inverts Glow, which is how Krita documents the quadratic family. The blend shader
normalises `gl_FragCoord` by its viewport origin, because one window can render two
graphs of different sizes through the same intermediate canvas: without that, a
graph rendered after a bigger one would sample shifted rows (`uOriginY`).

### Alpha contract (both classes)

The blend step runs against the *straight-alpha* colours, then the layer is
composited over the base exactly as the canvas does it:

```
Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)      blended source colour
αs  = layer alpha × opacity
αo  = αs + αb·(1 − αs)
Co  = αs·Cs' + αb·(1 − αs)·Cb          premultiplied result
```

Consequences that are tested: an opaque base runs `B(base, layer)` exactly; a
transparent base passes the layer through unchanged (never a blend against
black); opacity scales the layer only. The shader is fed straight-alpha texels
(`UNPACK_PREMULTIPLY_ALPHA_WEBGL = false`) and writes premultiplied output into a
`premultipliedAlpha: true` canvas, so the 2D `drawImage` that copies it composites
like any other layer.

## 3. Transform node

Space: the picture is a unit plane, `x ∈ [−1, 1]` left→right and `y ∈ [−1, 1]`
bottom→top, which exactly covers the frame at rest. The camera sits
`CAMERA_Z = 1` half-frame units in front of the plane, so `clip.w = 1 − z` and
`clip.z = 0` (the graph composites in 2D and never depth-tests).

| Slider | Range | Unit |
| --- | --- | --- |
| Move X / Y | −2 … 2 | half-frame units (1 = half the frame, ±2 clears it) |
| Move Z | −1 … 0.9 | half-frame units along the view axis (+0.5 doubles the picture) |
| Scale X / Y / Z | −4 … 4 | plane scale, negative mirrors |
| Rotate X / Y / Z | −180 … 180 | degrees, applied Z·Y·X |

Matrix: `M = P · T · Sz · Rz · Ry · Rx · S` (`src/nodes/transform.js`). Because
the plane is flat, `S.z` cannot matter before rotation, so the depth scale is
applied *after* the rotation — that is the only order in which `Scale Z` has any
visible effect, and its effect is a change of perspective on a tilted picture.
`isIdentityTransform` therefore ignores `Scale Z` only.

Identity is a pixel-exact `drawImage` copy and never touches the GPU. Everything
else goes to the shared compositor as a forward-drawn quad (4 vertices, one mat4
uniform): the GPU clips at the camera plane, interpolates the texture with
perspective correction and antialiases the quad edges, so a plane rotated through
90° is clipped rather than wrapped.

## 4. Failure behavior

| Condition | Behavior |
| --- | --- |
| WebGL2 unavailable | Canvas modes unaffected; a WebGL2 blend mode renders Normal and the runtime reports `Blend mode <name> needs WebGL2; rendering Normal instead.`; a non-identity Transform passes the image through unchanged and the inspector says so. Identity transforms never need a GPU. |
| Context lost | The compositor marks itself failed and returns `null` forever after, so the fallbacks above take over without retrying a dead context every frame. |
| Requested size above the GPU limit | `glTransform`/`glBlend` return `null` (fallback), never a garbled image. |
| Runtime warning | Warnings live in `GraphRuntime.warnings`, which `getDiagnostics()` reports as text but which never replaces a node canvas with the error card — a degraded mode still shows its picture. |

## 5. Implementation map

| File | Role |
| --- | --- |
| `src/nodes/blend-modes.js` | mode table (`NATIVE_MODES`, `EXTENDED_MODES`, `MODES`, `MODE_NAMES`), lookup helpers and the generated blend shader |
| `src/nodes/transform.js` | parameter definitions, identity test, column-major 4×4 matrix helpers, forward-projected quad |
| `src/nodes/gl-compositor.js` | the one shared WebGL2 context, textures, the blend and transform programs, grow-only intermediate canvas, context-loss handling |
| `src/nodes/runtime.js` | `composite()` (canvas path + shader path + warning), `applyTransform()`, per-node warnings in both the synchronous and the FX render paths |
| `src/nodes/definitions.js` / `model.js` | `transform` in `TYPES`/`VISUAL_TYPES`/`VISUAL_SOURCES`/`MODULATION_TARGETS`, the `image` port, parameter validation, palette create allowlist, `MODES` re-export |
| `src/nodes/NodesEditor.jsx` | `+ Transform` palette entry, node labels, mode select with canvas/WebGL2 groups, inspector notes |
| `tests/nodes-blend-transform.spec.js` | table/validation/geometry in Node, pixels and fallback in the editor |

## 6. Verification

```sh
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes-blend-transform.spec.js --no-deps
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes.spec.js tests/nodes-scalar.spec.js tests/nodes-image-fx-core.spec.js --no-deps
npm run build
```

What the new spec pins down:

- the mode table (classes, names, canvas operations, one shader branch per mode,
  unknown modes rejected, every stored mode accepted);
- the Transform contracts (ports, nine parameters and their ranges, modulation
  targets, palette creation, validation of unknown/out-of-range/partial
  parameters, wiring in both directions, cycle rejection, file round trip);
- geometry (identity matrix, Move X/Y/Z units, perspective trapezoid, edge-on
  degeneracy);
- pixels (canvas modes unchanged; Subtract, Divide, Average, Linear Burn, Linear
  Light, Hard Mix and Negate checked against their formulas; Divide-by-black,
  Reflect-at-white and Freeze-at-black edge cases; transparent base; opacity);
- the editor (both mode groups listed, an extended mode rendering end to end, the
  identity copy, Scale X, Rotate X, Move Y, save) and the no-WebGL2 fallback
  (picture retained, reason visible).
