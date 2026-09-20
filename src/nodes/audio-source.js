import { FEATURE_SCHEMA, createReactiveController } from '../sketches/feature-controls.js';
// Reserved, non-visual signal controller resolved only by the audio engine.
export const NODE_AUDIO_SOURCE = { id: '__node_audio_signal', params: [], audioTransport: 'pattern-controls', audioControlSchema: FEATURE_SCHEMA, createAudioController: createReactiveController };
