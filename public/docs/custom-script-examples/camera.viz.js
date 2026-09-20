api.requireVersion(1);
api.create({
  id: 'custom-camera', name: 'Shared camera / mirror', camera: true,
  setup({ state, createCapture }) {
    // Output shares its selected camera across LIVE/CUE. Control preview is
    // intentionally a camera placeholder, matching built-in camera patterns.
    state.capture = createCapture({ video: true, audio: false });
    state.capture.hide();
  },
  draw({ p, state }) {
    p.background(0);
    if (state.capture?.elt.readyState >= 2) {
      p.push(); p.translate(p.width, 0); p.scale(-1, 1);
      p.image(state.capture, 0, 0, p.width, p.height); p.pop();
    }
  },
});
