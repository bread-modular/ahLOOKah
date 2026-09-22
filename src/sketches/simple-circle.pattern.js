// Simple Circle — one filled circle, dead centre, on a black field. The
// smallest useful shape in the library: a clean base layer for merge/Alpha
// Blend and a handy calibration target when aligning a projector.
//
// Like Checkerboard it is deliberately NOT audio reactive: audio loss can never
// move it. It keeps the compact parameter controller so the CUE/TAKE
// pattern-controls transport stays satisfied, but it never inspects audio.
// The circle always uses the two live params (Radius, Hue), read every frame.
//
// Self-describing built-in: the renderer, controller, schema, and complete
// descriptor live in this one module, discovered automatically via
// scripts/generate-pattern-catalog.mjs. No registry edit needed.

import { bounded } from './band-reactive.js';

// Radius is normalised: 1 = the circle exactly fills the shorter screen edge
// (diameter = min(width, height)). The defaults reproduce the legacy look.
export const RADIUS_DEFAULT = 0.3;
export const HUE_DEFAULT = 0.6;

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uRadius: { min: 0, max: 1, neutral: RADIUS_DEFAULT },
    uHue: { min: 0, max: 1, neutral: HUE_DEFAULT },
  },
  arrays: {}, events: {},
  neutral: { continuous: { uRadius: RADIUS_DEFAULT, uHue: HUE_DEFAULT } },
});

export function createAudioController() {
  return {
    update({ params = {} }) {
      return {
        continuous: {
          uRadius: bounded(params.radius, RADIUS_DEFAULT, 0, 1),
          uHue: bounded(params.hue, HUE_DEFAULT, 0, 1),
        },
        arrays: {}, events: [],
      };
    },
    dispose() {},
  };
}

const factory = function simpleCircle(audio, _videoDeviceId, params = {}, runtimeContext = {}) {
  return (p) => {
    p.setup = () => {
      p.createCanvas(p.windowWidth, p.windowHeight);
      p.colorMode(p.HSB, 1, 1, 1);
      p.noStroke();
    };

    p.draw = () => {
      // Read once for the program's consumed-revision barrier, not for animation.
      // The local parameter values deliberately survive audio loss / neutral decay.
      runtimeContext.audioControls?.read();
      const radius = bounded(params.radius, RADIUS_DEFAULT, 0.02, 1) * (Math.min(p.width, p.height) / 2);
      const hue = ((bounded(params.hue, HUE_DEFAULT, 0, 1) % 1) + 1) % 1;
      p.background(0, 0, 0);
      p.fill(hue, 0.85, 0.95);
      p.circle(p.width / 2, p.height / 2, radius * 2);
    };

    p.windowResized = () => {
      p.resizeCanvas(p.windowWidth, p.windowHeight);
    };

    p.mousePressed = () => {
      if (audio) audio.resume();
    };
  };
};

export default factory;

export const pattern = {
  id: 'simple-circle',
  name: 'Simple Circle',
  group: 'Simple',
  description: 'One centred circle on black — not audio reactive. Radius and hue controls only.',
  audioReactive: false,
  factory,
  audioTransport: 'pattern-controls',
  createAudioController,
  audioControlSchema: AUDIO_CONTROL_SCHEMA,
  params: [
    { key: 'radius', label: 'Radius', min: 0.02, max: 1, step: 0.01, default: 0.3 },
    { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
};
