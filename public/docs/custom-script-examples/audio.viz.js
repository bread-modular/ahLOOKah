api.requireVersion(1);
api.create({
  id: 'custom-audio', name: 'Audio controls / spectrum / events',
  params: [{ key: 'gain', label: 'Gain', min: 0, max: 4, step: 0.1, default: 1 }],
  audio: {
    schema: {
      continuous: { level: { min: 0, max: 1, neutral: 0 } },
      arrays: { spectrum: { min: 0, max: 1, minLength: 32, maxLength: 32 } },
      events: { pulse: { fields: { strength: { min: 0, max: 1, required: true } } } },
    },
    update({ shared, params, deltaSeconds }, state) {
      const freqs = shared?.getByteFrequencies?.().left || [];
      const spectrum = new Float32Array(32);
      for (let i = 0; i < 32; i++) spectrum[i] = Math.min(1, ((freqs[i * 4] || 0) / 255) * params.gain);
      const level = spectrum.reduce((sum, x) => sum + x, 0) / 32;
      state.elapsed = (state.elapsed || 0) + deltaSeconds;
      const events = [];
      if (level > 0.3 && state.elapsed > 0.2) {
        state.elapsed = 0; state.count = (state.count || 0) + 1;
        events.push({ id: `pulse-${state.count}`, type: 'pulse', strength: level });
      }
      return { continuous: { level }, arrays: { spectrum }, events };
    },
  },
  draw({ p, controls, state }) {
    const packet = controls?.read();
    const level = packet?.continuous.level || 0;
    if (controls?.consumeEvents().length) state.flash = 1;
    state.flash = Math.max(0, (state.flash || 0) - p.deltaTime / 300);
    p.background(5 + state.flash * 80); p.noStroke(); p.fill(50, 200, 255);
    const bins = packet?.arrays.spectrum || [];
    for (let i = 0; i < bins.length; i++) p.rect(i * p.width / 32, p.height, p.width / 32 - 2, -bins[i] * p.height);
    p.fill(255, 100, 180); p.circle(p.width / 2, p.height / 2, 30 + level * 150);
  },
});
